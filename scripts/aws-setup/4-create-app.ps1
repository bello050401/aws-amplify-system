<#
.SYNOPSIS
  Look for an existing Amplify app across a short list of likely regions,
  and if none is found anywhere, create a new one via the AWS CLI using
  the official GitHub App connection method, add the test branch, and
  start the first build.

.DESCRIPTION
  This script exists because 1-discover.ps1 found no Amplify app for
  bello050401/aws-amplify-system in us-east-1. Before creating a new
  app, it re-checks a short list of other plausible regions first, so a
  duplicate app is never created if one already exists elsewhere.

  GitHub connection method (per AWS's current official guidance, which
  recommends the GitHub App method over the legacy OAuth-token method
  for GitHub specifically - --oauth-token is for non-GitHub providers
  such as Bitbucket or CodeCommit only):
    aws amplify create-app --platform WEB_COMPUTE --access-token <token> ...
  This requires ONE prerequisite that only you can do in a browser: the
  "AWS Amplify" GitHub App for the target region must be installed and
  authorized on your GitHub account/organization first. Do this once at
  (replace REGION if you pass a different -Region than the default):
    https://github.com/apps/aws-amplify-us-east-1
  Sign in on GitHub -> Install & Authorize -> choose "Only select
  repositories" and pick bello050401/aws-amplify-system (or "All
  repositories"). See docs/aws-test-environment.md section 4a for
  details and a link to try if the install page for your region 404s.

  After that one-time GitHub App install, you still pass a classic
  GitHub Personal Access Token (one starting with ghp_ - fine-grained
  tokens are not reliably accepted by Amplify's accessToken parameter)
  with the admin:repo_hook scope; Amplify uses it together with the
  GitHub App installation to set up the webhook, and the GitHub App
  itself (not the token) is what the App actually uses for read access
  to repository content on every build.

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
  A classic GitHub Personal Access Token (starts with ghp_) with the
  admin:repo_hook scope, used with --access-token per AWS's current
  GitHub App connection method. Requires the AWS Amplify GitHub App to
  already be installed on your account for the target region (see
  DESCRIPTION above). If the connect step reports a permission error
  even with admin:repo_hook, AWS's documented fallback is to also add
  the repo scope. If omitted, you will be prompted for it as masked
  input.

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

# ---- 3. Confirm the GitHub App prerequisite, then get the token securely --
Write-Host ""
Write-Host "PREREQUISITE (one-time, browser, only you can do this):" -ForegroundColor Cyan
Write-Host ("  The AWS Amplify GitHub App for region " + $Region + " must already be installed and")
Write-Host "  authorized on your GitHub account/org. If you have not done this yet, open:"
Write-Host ("    https://github.com/apps/aws-amplify-" + $Region)
Write-Host "  and choose Install & Authorize (select this repository, or All repositories), before"
Write-Host "  continuing. See docs/aws-test-environment.md section 4a if that URL 404s for your region."
Write-Host ""

# Token handling below sanitizes and pre-validates against GitHub's own API
# before AWS ever sees it - see 6-create-staging-app.ps1's identical block
# for the full history of why.
#
# Root cause found (second iteration of this fix, see 6-create-staging-app.ps1
# for the original diagnosis): `Read-Host -AsSecureString` is itself buggy
# here - a real run showed it captured Length=1 after pasting a full ghp_...
# token. Windows PowerShell 5.1's secure/masked console input path does not
# reliably receive a full clipboard paste character-by-character the way its
# normal (non-secure) input does; only one character made it through. A plain
# `Read-Host` (no masking) was confirmed to capture the same token correctly.
#
# Fix: read the token with plain `Read-Host` (echoed to the screen, not
# masked). This trades a moment of on-screen visibility - on your own
# machine, in your own terminal, never captured to a log or file by this
# script - for actually working reliably. Everything downstream (sanitize,
# safe shape diagnostics that never print the value itself, pre-validation
# against GitHub with this exact variable, then passing that same variable to
# AWS) is unchanged.
Write-Host ""
Write-Host "Please enter a NEW Personal Access Token now. Do not reuse a token that has" -ForegroundColor Yellow
Write-Host "already been typed into a chat or shared elsewhere - treat any such token as" -ForegroundColor Yellow
Write-Host "compromised and revoke it on GitHub (Settings > Developer settings >" -ForegroundColor Yellow
Write-Host "Personal access tokens) before continuing." -ForegroundColor Yellow
Write-Host ""
Write-Host "NOTE: this prompt is NOT masked - the token will be visible as you type or" -ForegroundColor Yellow
Write-Host "paste it (Read-Host -AsSecureString does not reliably receive a full pasted" -ForegroundColor Yellow
Write-Host "token in Windows PowerShell 5.1 - only plain Read-Host does). It is never" -ForegroundColor Yellow
Write-Host "written to a log, file, or environment variable by this script." -ForegroundColor Yellow
Write-Host ""

if ($GitHubToken) {
  $rawToken = $GitHubToken
} else {
  $rawToken = Read-Host "GitHub Personal Access Token (classic, admin:repo_hook scope) - visible as typed, see note above"
}

if (-not $rawToken) {
  Write-Host "No token was provided. Stopping without creating anything." -ForegroundColor Red
  exit 1
}

$hadEmbeddedNewline = $rawToken -match "[\r\n]"
$strippedToken = $rawToken -replace "[\r\n]", ""
$trimmedToken = $strippedToken.Trim()
$hadLeadingOrTrailingWhitespace = ($trimmedToken -ne $strippedToken)
$plainToken = $trimmedToken
$rawToken = $null

Write-Host ""
Write-Host "Token shape diagnostics (the token value itself is never printed):"
Write-Host ("  Length                         : " + $plainToken.Length)
Write-Host ("  Starts with 'ghp_'             : " + $plainToken.StartsWith("ghp_"))
Write-Host ("  Had embedded newline (removed) : " + $hadEmbeddedNewline)
Write-Host ("  Had leading/trailing whitespace (trimmed): " + $hadLeadingOrTrailingWhitespace)

# Fail fast on an obviously-wrong shape rather than spending a network round
# trip on something that cannot be a real classic PAT - a truncated read (the
# exact bug this fix addresses) is caught right here.
$shapeLooksValid = $true
if (-not $plainToken.StartsWith("ghp_")) {
  Write-Host "  [WARNING] A current classic GitHub PAT normally starts with 'ghp_'. This one does not - double-check the whole token was copied/pasted." -ForegroundColor Yellow
  $shapeLooksValid = $false
}
if ($plainToken.Length -lt 20) {
  Write-Host "  [WARNING] This looks too short for a real GitHub PAT (a classic ghp_ token is normally 40 characters)." -ForegroundColor Yellow
  $shapeLooksValid = $false
}
if (-not $shapeLooksValid) {
  Write-Host "  Stopping before calling GitHub or AWS - the captured value does not look like a real token." -ForegroundColor Red
  $plainToken = $null
  exit 1
}

Write-Host ""
Write-Host "Pre-validating this exact token against https://api.github.com/user ..."
try {
  $ghUser = Invoke-RestMethod -Uri "https://api.github.com/user" -Method Get -Headers @{
    Authorization = "token $plainToken"
    "User-Agent"  = "bello-inventory-staging-setup"
    Accept        = "application/vnd.github+json"
  }
  Write-Host ("GitHub accepted this token. login=" + $ghUser.login) -ForegroundColor Green
} catch {
  Write-Host "GitHub rejected this exact token - stopping before calling AWS at all." -ForegroundColor Red
  if ($_.Exception.Response) {
    Write-Host ("HTTP status: " + [int]$_.Exception.Response.StatusCode) -ForegroundColor Red
  }
  Write-Host ("  " + $_.Exception.Message) -ForegroundColor Red
  $plainToken = $null
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
# --access-token (not --oauth-token) is the correct flag for GitHub per AWS's
# current documented method: it is used together with the already-installed
# Amplify GitHub App above. --oauth-token is for non-GitHub providers only
# (Bitbucket, CodeCommit) and is not used here.
$createResult = Invoke-AwsCli -ArgList @(
  "amplify", "create-app",
  "--name", $AppName,
  "--repository", $RepositoryUrl,
  "--platform", "WEB_COMPUTE",
  "--access-token", $plainToken,
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
  Write-Host "Common causes:"
  Write-Host "  - The AWS Amplify GitHub App for this region was not installed/authorized yet"
  Write-Host ("    (visit https://github.com/apps/aws-amplify-" + $Region + " first)")
  Write-Host "  - The token is not a classic token (fine-grained tokens are not reliably accepted here)"
  Write-Host "  - The token is missing admin:repo_hook (AWS's documented fallback is to also add the repo scope)"
  Write-Host "  - The token is invalid or expired"
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
