<#
.SYNOPSIS
  Add a least-privilege Secrets Manager inline policy for
  bello/zaico-api-token to the Amplify Hosting SSR execution role
  (this script makes a change - it asks for confirmation first).

.DESCRIPTION
  Grants only secretsmanager:GetSecretValue, PutSecretValue and
  CreateSecret, scoped to the bello/zaico-api-token secret (with the
  version-suffix part of the ARN wildcarded), on the IAM role you pass
  in. Does not grant ListSecrets / DescribeSecret / DeleteSecret, since
  the app code (lib/zaico/secretStore.ts) never calls those.

  Prints the target role and the policy document, then waits for you to
  type "yes" before making any change, unless -Force is passed.

  This script is plain ASCII on purpose - see 1-discover.ps1's header
  comment for why (Windows PowerShell 5.1 + non-ASCII text without a
  BOM can corrupt string literals and produce ParserError).

.PARAMETER RoleName
  The IAM role to update (the SSR execution role you found via
  1-discover.ps1). Required.

.PARAMETER SecretArn
  The target secret's ARN. If omitted, it is built automatically as
  "arn:aws:secretsmanager:<region>:<account>:secret:bello/zaico-api-token-??????"
  (with the random version suffix wildcarded). If 1-discover.ps1 printed
  the exact ARN, pass that here for a stricter exact match.

.PARAMETER ProfileName
  AWS CLI profile name (default: Bello)

.PARAMETER Region
  AWS region (default: us-east-1)

.PARAMETER Force
  Skip the confirmation prompt and apply immediately.

.EXAMPLE
  .\2-apply-secrets-policy.ps1 -RoleName amplify-xxxxx-computeRole
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

Write-Host "BELLO AWS test environment - apply Secrets Manager IAM policy" -ForegroundColor Green

# Always check identity first, whether or not -SecretArn was passed in,
# so a root-credential run is caught either way.
$identityRaw = & aws sts get-caller-identity --profile $ProfileName --region $Region --output json
if ($LASTEXITCODE -ne 0) {
  Write-Host "Failed to get AWS identity. Run 1-discover.ps1 first." -ForegroundColor Red
  exit 1
}
$identity = $identityRaw | ConvertFrom-Json

if ($identity.Arn -match ":root$") {
  Write-Host "Do not run this with root credentials. Follow the safer steps printed by 1-discover.ps1." -ForegroundColor Red
  exit 1
}

if (-not $SecretArn) {
  $SecretArn = "arn:aws:secretsmanager:" + $Region + ":" + $identity.Account + ":secret:bello/zaico-api-token-??????"
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
Write-Host ("Target role   : " + $RoleName)
Write-Host ("Target secret : " + $SecretArn)
Write-Host "Policy to apply (does not include ListSecrets/DescribeSecret/DeleteSecret):"
Write-Host $policyDocument

if (-not $Force) {
  $confirmation = Read-Host ("Add this policy to role '" + $RoleName + "'? (type yes to continue)")
  if ($confirmation -ne "yes") {
    Write-Host "Cancelled. No changes were made." -ForegroundColor Yellow
    exit 0
  }
}

$tempFile = New-TemporaryFile
try {
  Set-Content -Path $tempFile -Value $policyDocument -Encoding utf8

  & aws iam put-role-policy `
    --role-name $RoleName `
    --policy-name BelloZaicoSecretAccess `
    --policy-document ("file://" + $tempFile) `
    --profile $ProfileName --region $Region

  if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed to apply the policy. Check the error above (wrong role name, or insufficient permissions)." -ForegroundColor Red
    exit 1
  }

  Write-Host ""
  Write-Host "Policy applied. Verify with:" -ForegroundColor Green
  Write-Host ("  aws iam get-role-policy --role-name " + $RoleName + " --policy-name BelloZaicoSecretAccess --profile " + $ProfileName + " --region " + $Region)
} finally {
  Remove-Item -Path $tempFile -ErrorAction SilentlyContinue
}
