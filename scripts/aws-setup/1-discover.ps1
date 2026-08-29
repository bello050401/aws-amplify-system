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
  #
  # Windows PowerShell 5.1 bug worked around here: with
  # $ErrorActionPreference = "Stop" (set at script scope above), text
  # that a native command (aws.exe) writes to stderr and that gets
  # merged into the success stream via "2>&1" is promoted from a plain
  # string into a terminating NativeCommandError - which aborts the
  # whole script right there, before $LASTEXITCODE can even be checked.
  # This is exactly what happened when Secrets Manager returned
  # ResourceNotFoundException (aws.exe writes the error JSON to stderr
  # and exits non-zero, which is completely normal/expected here - it
  # is a result to classify, not a script bug). The fix is to switch
  # $ErrorActionPreference to "Continue" for the duration of the native
  # call only, so its stderr is treated as plain text instead of a
  # terminating error, and to restore the previous value afterward no
  # matter what (finally).
  param([string[]]$ArgList)
  $fullArgs = $ArgList + @("--profile", $ProfileName, "--region", $Region, "--output", "json")

  $previousEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $out = & aws @fullArgs 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousEap
  }

  # Every element of $out is converted to a plain string explicitly -
  # a merged stderr line can come back as an ErrorRecord object rather
  # than a bare string, and ErrorRecord's default ToString() already
  # returns the underlying message text, so this never loses information.
  $rawText = ($out | ForEach-Object { $_.ToString() }) -join "`n"

  if ($exitCode -ne 0) {
    return @{ Ok = $false; Raw = $rawText }
  }
  return @{ Ok = $true; Raw = $rawText }
}

<#
.SYNOPSIS (helper) Classify-AwsError
  Turns the raw text of a failed AWS CLI call into one of a small set
  of known reasons, instead of only ever saying "it failed". Matches
  the same reasons app/actions and lib/zaico/secretStore.ts already
  distinguish for the running app itself.
#>
function Get-AwsErrorKind {
  param([string]$RawText)
  if ($RawText -match "ResourceNotFoundException") { return "not-found" }
  if ($RawText -match "AccessDeniedException" -or $RawText -match "is not authorized to perform") { return "access-denied" }
  if ($RawText -match "InvalidClientTokenId" -or $RawText -match "UnrecognizedClientException" -or $RawText -match "ExpiredToken") { return "auth-error" }
  if ($RawText -match "Unable to locate credentials" -or $RawText -match "Could not connect to the endpoint") { return "network-or-credentials" }
  return "other"
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
  Write-Host "[NEXT ACTION] Run 4-create-app.ps1 - it re-checks a short list of other regions, and if" -ForegroundColor Cyan
  Write-Host "still nothing is found, creates the app and connects the branch from the CLI (a GitHub" -ForegroundColor Cyan
  Write-Host "personal access token is the only manual step it needs). See docs/aws-test-environment.md" -ForegroundColor Cyan
  Write-Host "section 4 for details, or section 4b for the AWS Console alternative." -ForegroundColor Cyan
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
  $kind = Get-AwsErrorKind -RawText $secretResult.Raw
  switch ($kind) {
    "not-found" {
      Write-Host "Secret not found: it does not exist yet in this account/region." -ForegroundColor Yellow
      Write-Host "This is expected and fine - the app will auto-create it (CreateSecret) the first time an ADMIN saves a token from the settings screen. No manual pre-creation is needed."
    }
    "access-denied" {
      Write-Host "Access denied: this identity is not authorized to call secretsmanager:DescribeSecret here." -ForegroundColor Red
      Write-Host "This does not block the app itself (it only needs GetSecretValue/PutSecretValue/CreateSecret on the Hosting execution role, checked separately in step 2b/2)."
      Write-Host $secretResult.Raw
    }
    "auth-error" {
      Write-Host "Authentication error while calling Secrets Manager (invalid or expired credentials)." -ForegroundColor Red
      Write-Host ("Try: aws sso login --profile " + $ProfileName + "   then re-run this script.")
      Write-Host $secretResult.Raw
    }
    "network-or-credentials" {
      Write-Host "Could not reach AWS, or no usable credentials were found for this call." -ForegroundColor Red
      Write-Host $secretResult.Raw
    }
    default {
      Write-Host "Other AWS error while checking the secret:" -ForegroundColor Red
      Write-Host $secretResult.Raw
    }
  }
}

Write-Section "Summary"
Write-Host ("AccountId: " + $accountId)
Write-Host "This script made no changes. Follow the [NEXT ACTION] notes above to run the next script."
