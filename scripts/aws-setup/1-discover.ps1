<#
.SYNOPSIS
  BELLO AWSテスト環境の現状を確認する(読み取り専用・安全)。

.DESCRIPTION
  以下を確認し、画面へ表示する。AWSリソースは一切変更しない。
    1. 現在のAWS identity(sts get-caller-identity) — root credentialsでないことを確認
    2. 現在のregion設定
    3. bello050401/aws-amplify-system に紐づく既存Amplifyアプリの有無
    4. 見つかった場合: 既存ブランチ一覧、claude/inventory-management-system-5vbvc7 が既に登録済みか
    5. 見つかった場合: SSRコンピュートロールらしきARN(computeRoleArnを含むフィールド)の抽出
    6. Secrets Manager上の bello/zaico-api-token の存在有無

.PARAMETER ProfileName
  AWS CLIプロファイル名(既定: Bello)

.PARAMETER Region
  AWSリージョン(既定: us-east-1 — BELLOのAmplify環境の指定値)

.EXAMPLE
  ./1-discover.ps1
  ./1-discover.ps1 -ProfileName Bello -Region us-east-1
#>
param(
  [string]$ProfileName = "Bello",
  [string]$Region = "us-east-1"
)

$ErrorActionPreference = "Stop"

function Write-Section($title) {
  Write-Host ""
  Write-Host "==== $title ====" -ForegroundColor Cyan
}

function Invoke-AwsJson {
  # $ArgList(自動変数$argsとの衝突を避けるためこの名前にしている)。
  param([string[]]$ArgList)
  $fullArgs = $ArgList + @("--profile", $ProfileName, "--region", $Region, "--output", "json")
  $out = & aws @fullArgs 2>&1
  if ($LASTEXITCODE -ne 0) {
    return @{ Ok = $false; Raw = ($out -join "`n") }
  }
  return @{ Ok = $true; Raw = ($out -join "`n") }
}

Write-Host "BELLO AWSテスト環境 — 現状確認スクリプト" -ForegroundColor Green
Write-Host "profile=$ProfileName region=$Region"

# ── 1. AWS CLIの存在確認 ─────────────────────────────────────────────
Write-Section "0. AWS CLI"
$awsVersion = & aws --version 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "AWS CLIが見つかりません。https://aws.amazon.com/cli/ からインストールしてください。" -ForegroundColor Red
  exit 1
}
Write-Host $awsVersion

# ── 2. 現在のAWS identity ────────────────────────────────────────────
Write-Section "1. 現在のAWS identity"
$identityResult = Invoke-AwsJson -ArgList @("sts", "get-caller-identity")
if (-not $identityResult.Ok) {
  Write-Host "identityの取得に失敗しました。SSOログインが必要な可能性があります:" -ForegroundColor Yellow
  Write-Host "  aws sso login --profile $ProfileName"
  Write-Host $identityResult.Raw
  exit 1
}
$identity = $identityResult.Raw | ConvertFrom-Json
Write-Host "Account : $($identity.Account)"
Write-Host "Arn     : $($identity.Arn)"
Write-Host "UserId  : $($identity.UserId)"

if ($identity.Arn -match ":root$") {
  Write-Host ""
  Write-Host "【警告】root credentialsが使用されています。" -ForegroundColor Red
  Write-Host "このままIAM変更(2-apply-secrets-policy.ps1)を実行しないでください。" -ForegroundColor Red
  Write-Host "安全な代替手順:" -ForegroundColor Red
  Write-Host "  1. AWS Console (ルートアカウントでサインイン) → IAM → ユーザー または IAM Identity Center でSSOユーザーを作成"
  Write-Host "  2. 必要な権限(IAMロールへのポリシー付与、Amplify閲覧)を持つグループへ所属させる"
  Write-Host "  3. aws configure sso --profile $ProfileName でそのSSOユーザーのプロファイルを設定し直す"
  Write-Host "  4. aws sso login --profile $ProfileName でログインし、このスクリプトを再実行する"
  exit 1
}
Write-Host "root credentialsではありません。続行します。" -ForegroundColor Green

$accountId = $identity.Account

# ── 3. Amplifyアプリの検索 ───────────────────────────────────────────
Write-Section "2. 既存Amplifyアプリの検索(bello050401/aws-amplify-system)"
$appsResult = Invoke-AwsJson -ArgList @("amplify", "list-apps")
if (-not $appsResult.Ok) {
  Write-Host "amplify list-apps に失敗しました(権限不足の可能性):" -ForegroundColor Yellow
  Write-Host $appsResult.Raw
  $apps = @()
} else {
  $apps = ($appsResult.Raw | ConvertFrom-Json).apps
}

$targetApp = $apps | Where-Object { $_.repository -match "aws-amplify-system" }

if (-not $targetApp) {
  Write-Host "region=$Region に bello050401/aws-amplify-system 用のAmplifyアプリは見つかりませんでした。" -ForegroundColor Yellow
  Write-Host "他のリージョンに存在する可能性があります。全アプリ一覧:"
  $apps | ForEach-Object { Write-Host ("  - {0} ({1}) repo={2}" -f $_.name, $_.appId, $_.repository) }
  Write-Host ""
  Write-Host "【次のアクション】AWS ConsoleでAmplifyアプリを新規作成し、GitHubリポジトリを接続してください。" -ForegroundColor Cyan
  Write-Host "手順は docs/aws-test-environment.md の §4 を参照してください。"
  Write-Host "アプリ作成後、そのApp IDを使って 3-create-branch.ps1 を実行してください。"
} else {
  if ($targetApp -is [array]) { $targetApp = $targetApp[0] }
  Write-Host "既存アプリを発見しました:" -ForegroundColor Green
  Write-Host "  AppId      : $($targetApp.appId)"
  Write-Host "  Name       : $($targetApp.name)"
  Write-Host "  Repository : $($targetApp.repository)"
  Write-Host "  Platform   : $($targetApp.platform)"
  $appId = $targetApp.appId

  Write-Section "2-a. 既存ブランチ一覧"
  $branchesResult = Invoke-AwsJson -ArgList @("amplify", "list-branches", "--app-id", $appId)
  if ($branchesResult.Ok) {
    $branches = ($branchesResult.Raw | ConvertFrom-Json).branches
    $branches | ForEach-Object { Write-Host ("  - {0} (stage={1})" -f $_.branchName, $_.stage) }
    $targetBranch = $branches | Where-Object { $_.branchName -eq "claude/inventory-management-system-5vbvc7" }
    if ($targetBranch) {
      Write-Host ""
      Write-Host "claude/inventory-management-system-5vbvc7 は既にAmplifyへ登録済みです。" -ForegroundColor Green
      Write-Host "staging URL: https://claude-inventory-management-system-5vbvc7.$appId.amplifyapp.com" -ForegroundColor Cyan
      Write-Host "(実際のURLは Amplify Console のブランチ詳細で確認してください — ブランチ名のスラッシュはURL上ハイフンに変換される場合があります)"
    } else {
      Write-Host ""
      Write-Host "【次のアクション】3-create-branch.ps1 -AppId $appId を実行して、このブランチをAmplifyへ追加してください。" -ForegroundColor Cyan
    }
  } else {
    Write-Host $branchesResult.Raw
  }

  Write-Section "2-b. SSRコンピュートロールの手がかり(get-app / get-branch の生JSONから抽出)"
  $getAppResult = Invoke-AwsJson -ArgList @("amplify", "get-app", "--app-id", $appId)
  if ($getAppResult.Ok) {
    $roleArns = [regex]::Matches($getAppResult.Raw, 'arn:aws:iam::[0-9]+:role/[^"\s]+') | ForEach-Object { $_.Value } | Select-Object -Unique
    if ($roleArns.Count -gt 0) {
      Write-Host "get-app の応答内で見つかったIAMロールARN候補:"
      $roleArns | ForEach-Object { Write-Host "  - $_" }
      Write-Host "この中に 'computeRole' や 'compute' を含むキー名で紐づいているものが、SSR実行ロールです。"
      Write-Host "(下の生JSONで computeRoleArn / iamServiceRoleArn 等のキー名を目視確認してください)"
    } else {
      Write-Host "get-app の応答内にIAMロールARNは見つかりませんでした(まだコンピュートロールが割り当てられていない可能性)。"
    }
    Write-Host ""
    Write-Host "--- get-app 生JSON(必要な部分を目視確認) ---"
    Write-Host $getAppResult.Raw
  } else {
    Write-Host $getAppResult.Raw
  }
}

# ── 4. Secrets Managerの確認 ─────────────────────────────────────────
Write-Section "3. Secrets Manager (bello/zaico-api-token) の確認"
$secretResult = Invoke-AwsJson -ArgList @("secretsmanager", "describe-secret", "--secret-id", "bello/zaico-api-token")
if ($secretResult.Ok) {
  $secret = $secretResult.Raw | ConvertFrom-Json
  Write-Host "Secretは既に存在します:" -ForegroundColor Green
  Write-Host "  ARN: $($secret.ARN)"
  Write-Host "この完全なARNを 2-apply-secrets-policy.ps1 の -SecretArn に渡すと、suffix完全一致で最も厳密なポリシーを作成できます。"
} else {
  if ($secretResult.Raw -match "ResourceNotFoundException") {
    Write-Host "Secretはまだ存在しません(amplify/backend.tsのCDKデプロイ未実施、またはこのregion/accountに未デプロイ)。" -ForegroundColor Yellow
    Write-Host "アプリ初回起動時、ADMIN画面からのTOKEN保存操作がCreateSecretで自動作成します(lib/zaico/secretStore.ts参照) — 事前作成は不要です。"
  } else {
    Write-Host $secretResult.Raw
  }
}

Write-Section "まとめ"
Write-Host "AccountId: $accountId"
Write-Host "このスクリプトは何も変更していません。上記の【次のアクション】に従って次のスクリプトを実行してください。"
