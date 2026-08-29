<#
.SYNOPSIS
  Look for an existing Amplify app across a short list of likely regions,
  and if none is found anywhere, create a new one via the AWS CLI,
  connect it to GitHub with a personal access token, add the test
  branch, and start the first build - all without opening the Amplify
  Console.

.DESCRIPTION
  This script exists because 1-discover.ps1 found no Amplify app for
  bello050401/aws-amplify-system in us-east-1. Before creating a new
  app, it re-checks a short list of other plausible regions first, so a
  duplicate app is never created if one already exists elsewhere.

  If nothing is found in any scanned region, it creates a new app with:
    aws amplify create-app --platform WEB_COMPUTE --oauth-token <token> ...
  The GitHub OAuth token path (rather than the newer "GitHub App"
  Console-based connection) is what makes this possible entirely from
  the CLI - a GitHub Personal Access Token is still something only you
  can generate (that one step is the unavoidable BLOCKED_BY_USER part),
  but everything after that - app creation, branch creation, starting
  the first build - runs from this one script.

  The token is only ever held in memory for the single API call and is
  never written to disk, never logged, and never printed to the
  console. If you do not pass -GitHubToken, the script prompts for it
  as a masked SecureString input.

  This does NOT touch the main branch, and does NOT create a second
  Amplify app if one is already found. Each Amplify Hosting branch gets
  its own backend environment (its own Cognito user pool / AppSync API
  / S3 bucket) in Amplify Gen2 - since no Amplify Hosting app has ever
  been connected for this repository before (checked in 1-discover.ps1
  and again here), creating this app and connecting only the test
  branch does not touch any existing production resource; there isn't
  one yet. See docs/aws-test-environment.md section 4a for the full
  explanation.

  This script is plain ASCII on purpose (Windows PowerShell 5.1 without
  a BOM can misread non-ASCII text under a non-English codepage, which
  previously caused ParserError in these scripts).

.PARAMETER GitHubToken
  A GitHub Personal Access Token with the "repo" scope (classic token),
  or a fine-grained token scoped to this repository with Contents:Read
  and Webhooks:Read-and-write. If omitted, you will be prompted for it
  as masked input.

.PARAMETER RepositoryUrl
  The GitHub repository URL (default: https://github.com/bello050401/aws-amplify-system)

.PARAMETER AppName
  Name for the new Amplify app (default: bello-inventory-test)

.PARAMETER BranchName
  Branch to connect (default: claude/inventory-management-system-5vbvc7)

.PARAMETER Region
  Region to create the new app in if none is found anywhere (default: us-east-1)

.PARAMETER ScanRegions
  Regions to check for an existing app before creating a new one
  (default: us-east-1, ap-northeast-1, us-west-2 - a short, deliberately
  bounded list, not every AWS region).

.PARAMETER ProfileName
  AWS CLI profile name (default: Bello)

.PARAMETER Force
  Skip the confirmation prompt before creating resources.

.EXAMPLE
  .\4-create-app.ps1
  (prompts for the GitHub token, scans the default regions, creates the app if none found)
#>
param(
  [string]$GitHubToken,
  [string]$RepositoryUrl = "https://github.com/bello050401/aws-amplify-system",
  [string]$AppName = "bello-inventory-test",
  [string]$BranchName = "claude/inventory-management-system-5vbvc7",
  [string]$Region = "us-east-1",
  [string[]]$ScanRegions = @("us-east-1", "ap-northeast-1", "us-west-2"),
  [string]$ProfileName = "Bello",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

function Invoke-AwsCli {
  # Same Windows PowerShell 5.1 workaround as 1-discover.ps1's
  # Invoke-AwsJson: switch to "Continue" only around the native call so
  # stderr text from aws.exe is not promoted into a terminating error.
  param([string[]]$ArgList)
  $previousEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $out = & aws @ArgList 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousEap
  }
  $rawText = ($out | ForEach-Object { $_.ToString() }) -join "`n"
  return @{ Ok = ($exitCode -eq 0); Raw = $rawText }
}

Write-Host "BELLO AWS test environment - create Amplify app (CLI-only path)" -ForegroundColor Green

if ($BranchName -eq "main") {
  Write-Host "Refusing to run against the main branch. Stopping." -ForegroundColor Red
  exit 1
}

# ---- 1. Identity check ----------------------------------------------------
$identityResult = Invoke-AwsCli -ArgList @("sts", "get-caller-identity", "--profile", $ProfileName, "--region", $Region, "--output", "json")
if (-not $identityResult.Ok) {
  Write-Host "Failed to get AWS identity. Run 1-discover.ps1 first." -ForegroundColor Red
  Write-Host $identityResult.Raw
  exit 1
}
$identity = $identityResult.Raw | ConvertFrom-Json
Write-Host ("Account : " + $identity.Account)
Write-Host ("Arn     : " + $identity.Arn)
if ($identity.Arn -match ":root$") {
  Write-Host "Do not run this with root credentials. See 1-discover.ps1's guidance for switching to an SSO/IAM identity." -ForegroundColor Red
  exit 1
}

# ---- 2. Scan a short list of regions for an existing app -----------------
Write-Host ""
Write-Host ("Scanning regions for an existing app: " + ($ScanRegions -join ", "))
$found = @()
foreach ($r in ($ScanRegions | Select-Object -Unique)) {
  $result = Invoke-AwsCli -ArgList @("amplify", "list-apps", "--profile", $ProfileName, "--region", $r, "--output", "json")
  if (-not $result.Ok) {
    Write-Host ("  " + $r + ": list-apps failed (skipping) - " + $result.Raw)
    continue
  }
  $apps = ($result.Raw | ConvertFrom-Json).apps
  $match = $apps | Where-Object { $_.repository -match "aws-amplify-system" }
  if ($match) {
    if ($match -is [array]) { $match = $match[0] }
    Write-Host ("  " + $r + ": FOUND appId=" + $match.appId + " name=" + $match.name) -ForegroundColor Yellow
    $found += @{ Region = $r; AppId = $match.appId; Name = $match.name }
  } else {
    Write-Host ("  " + $r + ": none found")
  }
}

if ($found.Count -gt 0) {
  Write-Host ""
  Write-Host "An existing app was found - not creating a duplicate." -ForegroundColor Green
  foreach ($f in $found) {
    Write-Host ("  region=" + $f.Region + " appId=" + $f.AppId + " name=" + $f.Name)
  }
  Write-Host ""
  Write-Host "Use this app with 2-apply-secrets-policy.ps1 / 3-create-branch.ps1 (pass -Region matching the one shown above)."
  exit 0
}

Write-Host ""
Write-Host "No existing app found in any scanned region. Proceeding to create one in $Region." -ForegroundColor Yellow

# ---- 3. Get the GitHub token securely --------------------------------------
$secureToken = $null
if ($GitHubToken) {
  $plainToken = $GitHubToken
} else {
  $secureToken = Read-Host -AsSecureString "GitHub Personal Access Token (repo scope, or fine-grained scoped to this repo)"
  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($secureToken)
  try {
    $plainToken = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($bstr)
  } finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($bstr)
  }
}

if (-not $plainToken) {
  Write-Host "No token was provided. Stopping without creating anything." -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "About to create:"
Write-Host ("  App name   : " + $AppName)
Write-Host ("  Repository : " + $RepositoryUrl)
Write-Host ("  Platform   : WEB_COMPUTE (Next.js SSR)")
Write-Host ("  Region     : " + $Region)
Write-Host ("  Branch     : " + $BranchName + " (main is never touched)")
Write-Host "(The GitHub token itself is never printed or logged.)"

if (-not $Force) {
  $confirmation = Read-Host "Create this Amplify app and connect the branch? (type yes to continue)"
  if ($confirmation -ne "yes") {
    Write-Host "Cancelled. No changes were made." -ForegroundColor Yellow
    $plainToken = $null
    exit 0
  }
}

# ---- 4. Create the app ------------------------------------------------------
$createResult = Invoke-AwsCli -ArgList @(
  "amplify", "create-app",
  "--name", $AppName,
  "--repository", $RepositoryUrl,
  "--platform", "WEB_COMPUTE",
  "--oauth-token", $plainToken,
  "--profile", $ProfileName, "--region", $Region, "--output", "json"
)
# Drop the token from memory as soon as the call is made, whether it succeeded or not.
$plainToken = $null
[System.GC]::Collect()

if (-not $createResult.Ok) {
  Write-Host ""
  Write-Host "create-app failed. Full CLI output below (this never includes your token):" -ForegroundColor Red
  Write-Host $createResult.Raw
  Write-Host ""
  Write-Host "Common causes: an invalid/expired token, a token missing the 'repo' scope, or (for a fine-grained token) it not being scoped to this repository."
  exit 1
}

$app = ($createResult.Raw | ConvertFrom-Json).app
$appId = $app.appId
Write-Host ""
Write-Host ("App created: appId=" + $appId) -ForegroundColor Green

# ---- 5. Create the branch ----------------------------------------------------
Write-Host ""
Write-Host "-- Creating branch --"
$branchResult = Invoke-AwsCli -ArgList @(
  "amplify", "create-branch",
  "--app-id", $appId,
  "--branch-name", $BranchName,
  "--stage", "DEVELOPMENT",
  "--enable-auto-build",
  "--profile", $ProfileName, "--region", $Region, "--output", "json"
)
if (-not $branchResult.Ok) {
  Write-Host "create-branch failed:" -ForegroundColor Red
  Write-Host $branchResult.Raw
  exit 1
}
Write-Host "Branch created." -ForegroundColor Green

# ---- 6. Start the first build -------------------------------------------------
Write-Host ""
Write-Host "-- Starting the first build (RELEASE job) --"
$jobResult = Invoke-AwsCli -ArgList @(
  "amplify", "start-job",
  "--app-id", $appId,
  "--branch-name", $BranchName,
  "--job-type", "RELEASE",
  "--profile", $ProfileName, "--region", $Region, "--output", "json"
)
if (-not $jobResult.Ok) {
  Write-Host "start-job failed:" -ForegroundColor Red
  Write-Host $jobResult.Raw
  exit 1
}

Write-Host ""
Write-Host "Build started." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host ("  1. Check build progress: aws amplify list-jobs --app-id " + $appId + " --branch-name " + $BranchName + " --profile " + $ProfileName + " --region " + $Region)
Write-Host ("  2. Once you know the SSR compute role name (Amplify Console -> App settings -> Hosting compute, or re-run 1-discover.ps1 -Region " + $Region + "), run:")
Write-Host ("     .\2-apply-secrets-policy.ps1 -RoleName <role-name> -Region " + $Region)
$urlSafeBranch = $BranchName -replace "/", "-"
Write-Host ""
Write-Host "Approximate URL once the build finishes (confirm the exact value in the Amplify Console branch detail page):"
Write-Host ("  https://" + $urlSafeBranch + "." + $appId + ".amplifyapp.com")
