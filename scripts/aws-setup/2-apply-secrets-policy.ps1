<#
.SYNOPSIS
  Amplify Hosting SSR実行ロールへ、bello/zaico-api-token用の最小権限
  Secrets Managerポリシーを追加する(書き込みあり・要確認)。

.DESCRIPTION
  secretsmanager:GetSecretValue / PutSecretValue / CreateSecret の3つ
  だけを、bello/zaico-api-token (のバージョンsuffixを含むARNパターン)
  へ限定して許可するインラインポリシーを、指定したIAMロールへ追加する。
  ListSecrets / DescribeSecret / DeleteSecret は付与しない
  (lib/zaico/secretStore.tsが実際に呼ぶAPIのみ)。

  実行前に対象ロール名・ポリシー内容を表示し、-Force を渡さない限り
  確認プロンプトで止まる。

.PARAMETER RoleName
  ポリシーを追加するIAMロール名(1-discover.ps1の出力で見つけたSSR
  実行ロール名を渡す)。必須。

.PARAMETER SecretArn
  対象SecretのARN。省略した場合、AccountId/Regionから
  "arn:aws:secretsmanager:<region>:<account>:secret:bello/zaico-api-token-??????"
  (バージョンsuffixをワイルドカードにしたもの)を自動生成する。
  1-discover.ps1で完全なARNが分かっている場合はそちらを渡すとより厳密。

.PARAMETER ProfileName
  AWS CLIプロファイル名(既定: Bello)

.PARAMETER Region
  AWSリージョン(既定: us-east-1)

.PARAMETER Force
  確認プロンプトをスキップして即実行する。

.EXAMPLE
  ./2-apply-secrets-policy.ps1 -RoleName amplify-xxxxx-computeRole
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$RoleName,

  [string]$SecretArn,

  [string]$ProfileName = "Bello",
  [string]$Region = "us-east-1",

  [switch]$Force
)

$ErrorActionPreference = "Stop"

Write-Host "BELLO AWSテスト環境 — Secrets Manager IAMポリシー適用" -ForegroundColor Green

# identityは常に一度確認する(SecretArnの自動生成に使うだけでなく、
# root credentialsでの実行を必ず検出するため — SecretArnが明示的に
# 渡されたケースでもこのチェックを省略しない)。
$identityRaw = & aws sts get-caller-identity --profile $ProfileName --region $Region --output json
if ($LASTEXITCODE -ne 0) {
  Write-Host "AWS identityの取得に失敗しました。先に 1-discover.ps1 を実行してください。" -ForegroundColor Red
  exit 1
}
$identity = $identityRaw | ConvertFrom-Json

if ($identity.Arn -match ":root$") {
  Write-Host "root credentialsではこの操作を行わないでください。1-discover.ps1 の警告(SSOユーザーへの切り替え手順)に従ってください。" -ForegroundColor Red
  exit 1
}

if (-not $SecretArn) {
  $SecretArn = "arn:aws:secretsmanager:${Region}:$($identity.Account):secret:bello/zaico-api-token-??????"
}

$policyDocument = @"
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BelloZaicoTokenSecretAccess",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:PutSecretValue",
        "secretsmanager:CreateSecret"
      ],
      "Resource": "$SecretArn"
    }
  ]
}
"@

Write-Host ""
Write-Host "対象ロール : $RoleName"
Write-Host "対象Secret : $SecretArn"
Write-Host "適用ポリシー(secretsmanager:ListSecrets/DescribeSecret/DeleteSecretは含めない):"
Write-Host $policyDocument

if (-not $Force) {
  $confirmation = Read-Host "このポリシーをロール '$RoleName' へ追加しますか？ (yes と入力して続行)"
  if ($confirmation -ne "yes") {
    Write-Host "中断しました。何も変更していません。" -ForegroundColor Yellow
    exit 0
  }
}

$tempFile = New-TemporaryFile
try {
  Set-Content -Path $tempFile -Value $policyDocument -Encoding utf8

  & aws iam put-role-policy `
    --role-name $RoleName `
    --policy-name BelloZaicoSecretAccess `
    --policy-document "file://$tempFile" `
    --profile $ProfileName --region $Region

  if ($LASTEXITCODE -ne 0) {
    Write-Host "ポリシーの適用に失敗しました。上記のエラーを確認してください(ロール名の誤り・権限不足の可能性)。" -ForegroundColor Red
    exit 1
  }

  Write-Host ""
  Write-Host "ポリシーを適用しました。確認コマンド:" -ForegroundColor Green
  Write-Host "  aws iam get-role-policy --role-name $RoleName --policy-name BelloZaicoSecretAccess --profile $ProfileName --region $Region"
} finally {
  Remove-Item -Path $tempFile -ErrorAction SilentlyContinue
}
