<#
.SYNOPSIS
  Check the current state of the BELLO AWS test environment (read-only, safe).

.DESCRIPTION
  Checks and prints the following. Does NOT change any AWS resource.
    1. Current AWS identity (sts get-caller-identity) - confirms it is not root
    2. Current region setting
    3. Whether an Amplify app already exists for bello050401/aws-amplify-system
    4. If found: existing branches, whether claude/inventory-management-system-5vbvc7 is already registered
    5. If found: candidate IAM role ARNs (to help identify the SSR compute role)
    6. Whether the Secrets Manager secret bello/zaico-api-token already exists

  This script is plain ASCII on purpose (Windows PowerShell 5.1 on a
  Japanese-locale machine can misinterpret a script file containing
  multi-byte characters if it is not saved with a BOM, which corrupts
  string literals and produces ParserError / MissingEndCurlyBrace /
  "unexpected token" errors). Keeping every string literal ASCII-only
  removes that failure mode entirely, independent of file encoding.

.PARAMETER ProfileName
  AWS CLI profile name (default: Bello)

.PARAMETER Region
  AWS region (default: us-east-1, BELLO's Amplify environment)

.EXAMPLE
  .\1-discover.ps1
  .\1-discover.ps1 -ProfileName Bello -Region us-east-1
#>
param(
  [string]$ProfileName = "Bello",
  [string]$Region = "us-east-1"
)

$ErrorActionPreference = "Stop"

function Write-Section {
  param([string]$Title)
  Write-Host ""
  Write-Host ("==== " + $Title + " ====") -ForegroundColor Cyan
}

function Invoke-AwsJson {
  # Named $ArgList (not $Args) to avoid colliding with PowerShell's
  # automatic $args variable inside a function.
  param([string[]]$ArgList)
  $fullArgs = $ArgList + @("--profile", $ProfileName, "--region", $Region, "--output", "json")
  $out = & aws @fullArgs 2>&1
  if ($LASTEXITCODE -ne 0) {
    return @{ Ok = $false; Raw = ($out -join "`n") }
  }
  return @{ Ok = $true; Raw = ($out -join "`n") }
}

Write-Host "BELLO AWS test environment - discovery script" -ForegroundColor Green
Write-Host ("profile=" + $ProfileName + " region=" + $Region)

# ---- 0. Confirm AWS CLI is installed ------------------------------------
Write-Section "0. AWS CLI"
$awsVersion = & aws --version 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "AWS CLI was not found. Install it from https://aws.amazon.com/cli/ and try again." -ForegroundColor Red
  exit 1
}
Write-Host $awsVersion

# ---- 1. Current AWS identity ---------------------------------------------
Write-Section "1. Current AWS identity"
$identityResult = Invoke-AwsJson -ArgList @("sts", "get-caller-identity")
if (-not $identityResult.Ok) {
  Write-Host "Failed to get identity. You may need to run SSO login:" -ForegroundColor Yellow
  Write-Host ("  aws sso login --profile " + $ProfileName)
  Write-Host $identityResult.Raw
  exit 1
}
$identity = $identityResult.Raw | ConvertFrom-Json
Write-Host ("Account : " + $identity.Account)
Write-Host ("Arn     : " + $identity.Arn)
Write-Host ("UserId  : " + $identity.UserId)

if ($identity.Arn -match ":root$") {
  Write-Host ""
  Write-Host "[WARNING] You are using root account credentials." -ForegroundColor Red
  Write-Host "Do not proceed to IAM changes (2-apply-secrets-policy.ps1) with root credentials." -ForegroundColor Red
  Write-Host "Safer alternative:" -ForegroundColor Red
  Write-Host "  1. Sign in to the AWS Console as root, then go to IAM (or IAM Identity Center) and create an IAM/SSO user"
  Write-Host "  2. Put that user in a group with the permissions needed here (attach role policies, view Amplify)"
  Write-Host ("  3. Run: aws configure sso --profile " + $ProfileName + "   (set up that SSO user's profile)")
  Write-Host ("  4. Run: aws sso login --profile " + $ProfileName + "   then re-run this script")
  exit 1
}
Write-Host "Not using root credentials. Continuing." -ForegroundColor Green

$accountId = $identity.Account

# ---- 2. Look for an existing Amplify app ---------------------------------
Write-Section "2. Looking for an existing Amplify app (bello050401/aws-amplify-system)"
$appsResult = Invoke-AwsJson -ArgList @("amplify", "list-apps")
if (-not $appsResult.Ok) {
  Write-Host "amplify list-apps failed (possible permission issue):" -ForegroundColor Yellow
  Write-Host $appsResult.Raw
  $apps = @()
} else {
  $apps = ($appsResult.Raw | ConvertFrom-Json).apps
}

$targetApp = $apps | Where-Object { $_.repository -match "aws-amplify-system" }

if (-not $targetApp) {
  Write-Host ("No Amplify app for bello050401/aws-amplify-system was found in region " + $Region + ".") -ForegroundColor Yellow
  Write-Host "It might exist in a different region. All apps found in this region:"
  $apps | ForEach-Object { Write-Host ("  - " + $_.name + " (" + $_.appId + ") repo=" + $_.repository) }
  Write-Host ""
  Write-Host "[NEXT ACTION] Create a new Amplify app in the AWS Console and connect the GitHub repository." -ForegroundColor Cyan
  Write-Host "See docs/aws-test-environment.md section 4 for the exact steps."
  Write-Host "Once the app is created, use its App ID with 3-create-branch.ps1."
} else {
  if ($targetApp -is [array]) { $targetApp = $targetApp[0] }
  Write-Host "Found an existing app:" -ForegroundColor Green
  Write-Host ("  AppId      : " + $targetApp.appId)
  Write-Host ("  Name       : " + $targetApp.name)
  Write-Host ("  Repository : " + $targetApp.repository)
  Write-Host ("  Platform   : " + $targetApp.platform)
  $appId = $targetApp.appId

  Write-Section "2a. Existing branches"
  $branchesResult = Invoke-AwsJson -ArgList @("amplify", "list-branches", "--app-id", $appId)
  if ($branchesResult.Ok) {
    $branches = ($branchesResult.Raw | ConvertFrom-Json).branches
    $branches | ForEach-Object { Write-Host ("  - " + $_.branchName + " (stage=" + $_.stage + ")") }
    $targetBranch = $branches | Where-Object { $_.branchName -eq "claude/inventory-management-system-5vbvc7" }
    if ($targetBranch) {
      Write-Host ""
      Write-Host "claude/inventory-management-system-5vbvc7 is already registered on this app." -ForegroundColor Green
      Write-Host ("Approximate staging URL: https://claude-inventory-management-system-5vbvc7." + $appId + ".amplifyapp.com") -ForegroundColor Cyan
      Write-Host "(Confirm the exact URL on the branch's detail page in the Amplify Console - slashes in the branch name may be shown differently there.)"
    } else {
      Write-Host ""
      Write-Host ("[NEXT ACTION] Run: 3-create-branch.ps1 -AppId " + $appId + "   to add this branch to Amplify.") -ForegroundColor Cyan
    }
  } else {
    Write-Host $branchesResult.Raw
  }

  Write-Section "2b. Candidate IAM role ARNs (from raw get-app JSON)"
  $getAppResult = Invoke-AwsJson -ArgList @("amplify", "get-app", "--app-id", $appId)
  if ($getAppResult.Ok) {
    $roleArns = [regex]::Matches($getAppResult.Raw, 'arn:aws:iam::[0-9]+:role/[^"\s]+') | ForEach-Object { $_.Value } | Select-Object -Unique
    if ($roleArns.Count -gt 0) {
      Write-Host "IAM role ARNs found in the get-app response:"
      $roleArns | ForEach-Object { Write-Host ("  - " + $_) }
      Write-Host "The one associated with a key containing 'computeRole' (or similar) is the SSR execution role."
      Write-Host "(Look at the raw JSON below and check key names such as computeRoleArn / iamServiceRoleArn.)"
    } else {
      Write-Host "No IAM role ARN was found in the get-app response (a compute role may not be assigned yet)."
    }
    Write-Host ""
    Write-Host "--- raw get-app JSON (inspect manually) ---"
    Write-Host $getAppResult.Raw
  } else {
    Write-Host $getAppResult.Raw
  }
}

# ---- 3. Check Secrets Manager ---------------------------------------------
Write-Section "3. Secrets Manager (bello/zaico-api-token)"
$secretResult = Invoke-AwsJson -ArgList @("secretsmanager", "describe-secret", "--secret-id", "bello/zaico-api-token")
if ($secretResult.Ok) {
  $secret = $secretResult.Raw | ConvertFrom-Json
  Write-Host "The secret already exists:" -ForegroundColor Green
  Write-Host ("  ARN: " + $secret.ARN)
  Write-Host "You can pass this full ARN to 2-apply-secrets-policy.ps1 -SecretArn for the strictest exact-match policy."
} else {
  if ($secretResult.Raw -match "ResourceNotFoundException") {
    Write-Host "The secret does not exist yet (amplify/backend.ts's CDK stack may not be deployed to this account/region yet)." -ForegroundColor Yellow
    Write-Host "The app will auto-create it (CreateSecret) the first time an ADMIN saves a token from the settings screen - no manual pre-creation is needed."
  } else {
    Write-Host $secretResult.Raw
  }
}

Write-Section "Summary"
Write-Host ("AccountId: " + $accountId)
Write-Host "This script made no changes. Follow the [NEXT ACTION] notes above to run the next script."
