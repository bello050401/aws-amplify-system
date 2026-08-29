<#
.SYNOPSIS
  Create a brand new, dedicated staging Amplify app (platform=WEB_COMPUTE
  from the start), connect only the test branch, deploy, poll, and verify.
  Never touches the existing app (which also hosts production "main").

.DESCRIPTION
  Policy change from the previous approach: the existing Amplify app
  (d1uy61lbnqm8ae) also hosts "main" as its PRODUCTION branch. Since
  platform is an app-level setting, changing it on that app risks
  affecting production. The fix is therefore to create a SEPARATE
  Amplify app dedicated solely to this project's staging/test branch,
  configured correctly (platform=WEB_COMPUTE) from creation - not to
  modify the existing app at all.

  This script hard-refuses to ever call a mutating API against the
  existing production app ID, as defense in depth (see
  $ExistingProductionAppId below) - it does not accept that app ID as a
  parameter for any of its own operations.

  Steps performed:
    1. Read-only: confirm identity, look up the existing
       BelloAmplifyBackendDeploymentRole (does not modify it - only
       checks it exists and prints its ARN so it can be reused, or falls
       back to omitting --iam-service-role-arn if not found).
    2. GitHub connection: reuses the AWS-recommended GitHub App method
       (--access-token), exactly like 4-create-app.ps1. Since the
       existing app already deploys "main" from this same GitHub
       repository in this same account/region, the AWS Amplify GitHub
       App for this region should already be installed - this script
       does not re-attempt that browser-based install step, only prompts
       for a Personal Access Token (classic, admin:repo_hook scope) to
       use with the already-installed GitHub App. If create-app fails
       specifically due to a GitHub App/token problem, that install may
       need to be (re)done - see docs/aws-test-environment.md section 4a.
    3. Create the new app: platform=WEB_COMPUTE, same repository, the
       reused backend deployment role if found.
    4. Create the branch (framework="Next.js - SSR" set explicitly at
       creation, enable-auto-build on) - main is never added to this app.
    5. Start the first RELEASE job.
    6. Poll every 15 seconds until terminal (up to ~20 minutes).
    7. On FAILED: fetch and print every build step's log.
    8. On SUCCEED: request the new public URL and print its HTTP status.

  CDK bootstrap is NOT re-run here - the task's own premise states
  us-west-2 bootstrap is already complete, and CDK bootstrap is a
  per-account-per-region resource, not a per-Amplify-app one, so it does
  not need to be redone for a new app in the same account/region.

  This script is plain ASCII on purpose - see 1-discover.ps1's header
  comment for why (Windows PowerShell 5.1 + non-ASCII text without a BOM
  can corrupt string literals and produce ParserError).

.PARAMETER GitHubToken
  A classic GitHub Personal Access Token (starts with ghp_) with the
  admin:repo_hook scope. If omitted, you will be prompted for it as
  masked input. Never logged, never written to disk.

.PARAMETER RepositoryUrl
  The GitHub repository URL (default: https://github.com/bello050401/aws-amplify-system).

.PARAMETER AppName
  Name for the new Amplify app (default: bello-inventory-staging).

.PARAMETER BranchName
  Branch to connect (default: claude/inventory-management-system-5vbvc7).
  Refuses to run if this is "main".

.PARAMETER Region
  AWS region (default: us-west-2, matching the existing app / CDK bootstrap).

.PARAMETER ProfileName
  AWS CLI profile name (default: Bello).

.PARAMETER BackendRoleName
  Existing IAM role to look up and reuse as the new app's backend
  deployment service role (default: BelloAmplifyBackendDeploymentRole).
  Read-only lookup - this role itself is never modified.

.PARAMETER Force
  Skip the confirmation prompt before creating resources.

.EXAMPLE
  .\6-create-staging-app.ps1
#>
param(
  [string]$GitHubToken,
  [string]$RepositoryUrl = "https://github.com/bello050401/aws-amplify-system",
  [string]$AppName = "bello-inventory-staging",
  [string]$BranchName = "claude/inventory-management-system-5vbvc7",
  [string]$Region = "us-west-2",
  [string]$ProfileName = "Bello",
  [string]$BackendRoleName = "BelloAmplifyBackendDeploymentRole",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

# Defense in depth: this script must never operate against the existing
# production-hosting app, under any circumstance. There is no parameter
# that accepts an existing app ID for a mutating call in this script, but
# this constant plus the assertion below make that a hard guarantee
# rather than just "no code path happens to do it today".
$ExistingProductionAppId = "d1uy61lbnqm8ae"

function Write-Section {
  param([string]$Title)
  Write-Host ""
  Write-Host ("==== " + $Title + " ====") -ForegroundColor Cyan
}

function Invoke-AwsCli {
  param([string[]]$ArgList)
  if ($ArgList -contains $ExistingProductionAppId) {
    Write-Host "[SAFETY ABORT] Refusing an AWS CLI call that references the existing production app ID." -ForegroundColor Red
    exit 1
  }
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

Write-Host "BELLO Amplify - create a dedicated staging app (existing production app is never touched)" -ForegroundColor Green

if ($BranchName -eq "main") {
  Write-Host "Refusing to use 'main' as the staging branch name. Stopping." -ForegroundColor Red
  exit 1
}

# ---- 0. Identity / root check ----------------------------------------------
$identityResult = Invoke-AwsCli -ArgList @("sts", "get-caller-identity", "--profile", $ProfileName, "--region", $Region, "--output", "json")
if (-not $identityResult.Ok) {
  Write-Host "Failed to get AWS identity. Run 1-discover.ps1 first." -ForegroundColor Red
  Write-Host $identityResult.Raw
  exit 1
}
$identity = $identityResult.Raw | ConvertFrom-Json
Write-Host ("Identity: " + $identity.Arn)
if ($identity.Arn -match ":root$") {
  Write-Host "Do not run this with root credentials." -ForegroundColor Red
  exit 1
}
$accountId = $identity.Account

# ---- 1. Look up the existing backend deployment role (read-only) ----------
Write-Section "1. Checking the existing backend deployment role (read-only, not modified)"
$roleResult = Invoke-AwsCli -ArgList @("iam", "get-role", "--role-name", $BackendRoleName, "--profile", $ProfileName, "--region", $Region, "--output", "json")
$backendRoleArn = $null
if ($roleResult.Ok) {
  $backendRoleArn = ($roleResult.Raw | ConvertFrom-Json).Role.Arn
  Write-Host ("Found existing role, will reuse it: " + $backendRoleArn) -ForegroundColor Green
} else {
  Write-Host ("Role '" + $BackendRoleName + "' not found or not accessible - the new app will be created without --iam-service-role-arn (Amplify's own default backend build credentials will be used instead).") -ForegroundColor Yellow
}

# ---- 2. GitHub token: acquire, sanitize, diagnose (never reveal the value),
#         then pre-validate against GitHub itself before AWS ever sees it ---
#
# Root cause found (second iteration of this fix): `Read-Host -AsSecureString`
# is the actual bug here. Diagnostics from a real run showed the captured
# token had Length=1 after pasting a full ghp_... token - Windows
# PowerShell 5.1's secure/masked console input handling does not reliably
# receive a full clipboard paste character-by-character the way its normal
# (non-secure) input does; only one character made it through. This is a
# known limitation of -AsSecureString's masked input path in Windows
# PowerShell 5.1 (as opposed to PowerShell 7's revised console handling),
# not something the earlier trim/sanitize logic could ever have caught,
# since the string was already truncated to 1 character before any of that
# ran. The user independently confirmed a PLAIN `Read-Host` (no masking)
# captured the same token correctly and it validated fine directly against
# https://api.github.com/user.
#
# Fix: read the token with plain `Read-Host` (echoed to the screen, not
# masked). This trades a moment of on-screen visibility - on the user's own
# machine, in their own terminal, never captured to a log or file by this
# script - for actually working reliably, which the user explicitly
# prioritized. Everything downstream (sanitize, safe shape diagnostics that
# never print the value itself, pre-validation against GitHub with this
# exact variable, then passing that same variable to AWS) is unchanged from
# the previous fix and remains in place.
Write-Host ""
Write-Host "PREREQUISITE: the AWS Amplify GitHub App for this region should already be" -ForegroundColor Cyan
Write-Host "installed, since the existing production app already deploys this same" -ForegroundColor Cyan
Write-Host "repository from this same account/region. If create-app below fails with a" -ForegroundColor Cyan
Write-Host ("GitHub-App-related error, visit https://github.com/apps/aws-amplify-" + $Region + " and Install & Authorize first.") -ForegroundColor Cyan
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

# A real classic PAT never legitimately contains a leading/trailing space or
# an embedded CR/LF - if either is present, it was introduced by the
# capture step (clipboard/paste), not part of the actual credential.
$hadEmbeddedNewline = $rawToken -match "[\r\n]"
$strippedToken = $rawToken -replace "[\r\n]", ""
$trimmedToken = $strippedToken.Trim()
$hadLeadingOrTrailingWhitespace = ($trimmedToken -ne $strippedToken)
$plainToken = $trimmedToken
$rawToken = $null

Write-Section "2a. Token shape diagnostics (the token value itself is never printed)"
Write-Host ("  Length                         : " + $plainToken.Length)
Write-Host ("  Starts with 'ghp_'             : " + $plainToken.StartsWith("ghp_"))
Write-Host ("  Had embedded newline (removed) : " + $hadEmbeddedNewline)
Write-Host ("  Had leading/trailing whitespace (trimmed): " + $hadLeadingOrTrailingWhitespace)

# Fail fast on an obviously-wrong shape rather than spending a network round
# trip on something that cannot be a real classic PAT - a truncated read
# (the exact bug this fix addresses) is caught right here.
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

# Pre-validate this EXACT variable against GitHub's own API before AWS ever
# sees it. If this fails, the problem is the token itself (or how it just
# got captured) - not AWS - and we stop here rather than let it surface
# later as an opaque 401 from create-app.
Write-Section "2b. Pre-validating this exact token against https://api.github.com/user"
try {
  $ghUser = Invoke-RestMethod -Uri "https://api.github.com/user" -Method Get -Headers @{
    Authorization = "token $plainToken"
    "User-Agent"  = "bello-inventory-staging-setup"
    Accept        = "application/vnd.github+json"
  }
  Write-Host ("  GitHub accepted this token. login=" + $ghUser.login) -ForegroundColor Green
} catch {
  Write-Host "  GitHub rejected this exact token - stopping before calling AWS at all." -ForegroundColor Red
  if ($_.Exception.Response) {
    Write-Host ("  HTTP status: " + [int]$_.Exception.Response.StatusCode) -ForegroundColor Red
  }
  Write-Host ("  " + $_.Exception.Message) -ForegroundColor Red
  $plainToken = $null
  exit 1
}

# ---- 3. Confirm and create the new app --------------------------------------
Write-Section "2. About to create a new, dedicated staging app"
Write-Host ("  App name    : " + $AppName)
Write-Host ("  Repository  : " + $RepositoryUrl)
Write-Host ("  Platform    : WEB_COMPUTE (Next.js SSR)")
Write-Host ("  Region      : " + $Region)
Write-Host ("  Branch      : " + $BranchName + " only (no 'main')")
Write-Host ("  Backend role: " + $(if ($backendRoleArn) { $backendRoleArn } else { "(none - using Amplify default)" }))
Write-Host ("  Existing app " + $ExistingProductionAppId + " (production) will NOT be touched.") -ForegroundColor Green

if (-not $Force) {
  $confirmation = Read-Host "Create this new staging app? (type yes to continue)"
  if ($confirmation -ne "yes") {
    Write-Host "Cancelled. No changes were made." -ForegroundColor Yellow
    $plainToken = $null
    exit 0
  }
}

# $plainToken here is literally the same variable that was just trimmed,
# diagnosed, and pre-validated against GitHub above - never re-read or
# re-derived. $createArgs is a plain array passed to aws.exe via
# PowerShell's native-command splatting (`& aws @createArgs`), which hands
# each element to the process as its own argv entry with no further shell
# requoting - correct and sufficient for a classic PAT (alphanumeric plus
# underscore only), so no manual quoting is added or needed here.
$createArgs = @(
  "amplify", "create-app",
  "--name", $AppName,
  "--repository", $RepositoryUrl,
  "--platform", "WEB_COMPUTE",
  "--access-token", $plainToken,
  "--profile", $ProfileName, "--region", $Region, "--output", "json"
)
if ($backendRoleArn) {
  $createArgs += @("--iam-service-role-arn", $backendRoleArn)
}
$createResult = Invoke-AwsCli -ArgList $createArgs
$plainToken = $null
[System.GC]::Collect()

if (-not $createResult.Ok) {
  Write-Host ""
  Write-Host "create-app failed. Full CLI output below (never includes your token):" -ForegroundColor Red
  Write-Host $createResult.Raw
  exit 1
}

$newApp = ($createResult.Raw | ConvertFrom-Json).app
$newAppId = $newApp.appId
if ($newAppId -eq $ExistingProductionAppId) {
  Write-Host "[SAFETY ABORT] The newly created app ID matches the existing production app ID - this should be impossible. Stopping without further action." -ForegroundColor Red
  exit 1
}
Write-Host ("New staging app created: appId=" + $newAppId) -ForegroundColor Green

# ---- 4. Create the branch ----------------------------------------------------
Write-Section "3. Creating the staging branch"
$branchResult = Invoke-AwsCli -ArgList @(
  "amplify", "create-branch",
  "--app-id", $newAppId,
  "--branch-name", $BranchName,
  "--framework", "Next.js - SSR",
  "--stage", "DEVELOPMENT",
  "--enable-auto-build",
  "--profile", $ProfileName, "--region", $Region, "--output", "json"
)
if (-not $branchResult.Ok) {
  Write-Host "create-branch failed:" -ForegroundColor Red
  Write-Host $branchResult.Raw
  exit 1
}
Write-Host "Branch created with framework=Next.js - SSR." -ForegroundColor Green

# ---- 5. Start the first build -------------------------------------------------
Write-Section "4. Starting the first build (RELEASE job)"
$jobStartResult = Invoke-AwsCli -ArgList @(
  "amplify", "start-job",
  "--app-id", $newAppId,
  "--branch-name", $BranchName,
  "--job-type", "RELEASE",
  "--profile", $ProfileName, "--region", $Region, "--output", "json"
)
if (-not $jobStartResult.Ok) {
  Write-Host "start-job failed:" -ForegroundColor Red
  Write-Host $jobStartResult.Raw
  exit 1
}
$newJobId = ($jobStartResult.Raw | ConvertFrom-Json).jobSummary.jobId
Write-Host ("Build started: jobId=" + $newJobId) -ForegroundColor Green

# ---- 6. Poll until terminal state -------------------------------------------
Write-Section ("5. Polling job " + $newJobId + " (checks every 15s, up to ~20 minutes)")
$terminalStates = @("SUCCEED", "FAILED", "CANCELLED")
$finalStatus = $null
$finalJob = $null
for ($i = 0; $i -lt 80; $i++) {
  Start-Sleep -Seconds 15
  $pollResult = Invoke-AwsCli -ArgList @("amplify", "get-job", "--app-id", $newAppId, "--branch-name", $BranchName, "--job-id", $newJobId, "--profile", $ProfileName, "--region", $Region, "--output", "json")
  if (-not $pollResult.Ok) {
    Write-Host "get-job (poll) failed, retrying:" -ForegroundColor Yellow
    Write-Host $pollResult.Raw
    continue
  }
  $jobNow = ($pollResult.Raw | ConvertFrom-Json).job
  $status = $jobNow.summary.status
  Write-Host ("  [" + (Get-Date -Format "HH:mm:ss") + "] status=" + $status)
  if ($terminalStates -contains $status) {
    $finalStatus = $status
    $finalJob = $jobNow
    break
  }
}

if (-not $finalStatus) {
  Write-Host "Timed out waiting for the job to finish. Check manually:" -ForegroundColor Red
  Write-Host ("  aws amplify get-job --app-id " + $newAppId + " --branch-name " + $BranchName + " --job-id " + $newJobId + " --profile " + $ProfileName + " --region " + $Region)
  exit 1
}

$urlSafeBranch = $BranchName -replace "/", "-"
$newSiteUrl = "https://" + $urlSafeBranch + "." + $newAppId + ".amplifyapp.com"

# ---- 7. On FAILED: fetch and print every step's log -------------------------
if ($finalStatus -eq "FAILED") {
  Write-Section "6. Job FAILED - fetching step logs"
  foreach ($step in $finalJob.steps) {
    Write-Host ("--- step: " + $step.stepName + " status=" + $step.status + " ---") -ForegroundColor Yellow
    if ($step.logUrl) {
      try {
        $logText = (Invoke-WebRequest -Uri $step.logUrl -UseBasicParsing).Content
        Write-Host $logText
      } catch {
        Write-Host ("Could not fetch log for this step: " + $_.Exception.Message) -ForegroundColor Red
      }
    } else {
      Write-Host "(no logUrl for this step)"
    }
  }
  Write-Host ""
  Write-Host ("New app ID (for re-running/debugging): " + $newAppId) -ForegroundColor Yellow
  Write-Host "Job failed. Review the logs above." -ForegroundColor Red
  exit 1
}

# ---- 8. On SUCCEED: verify the public URL -----------------------------------
Write-Section "7. Job SUCCEED - verifying the new public URL"
Write-Host ("URL: " + $newSiteUrl)
try {
  $response = Invoke-WebRequest -Uri $newSiteUrl -UseBasicParsing -MaximumRedirection 0 -ErrorAction Stop
  Write-Host ("HTTP status: " + $response.StatusCode) -ForegroundColor Green
} catch {
  if ($_.Exception.Response) {
    $statusCode = [int]$_.Exception.Response.StatusCode
    Write-Host ("HTTP status: " + $statusCode) -ForegroundColor $(if ($statusCode -ge 200 -and $statusCode -lt 400) { "Green" } else { "Red" })
    if ($statusCode -eq 302 -or $statusCode -eq 301) {
      $locationHeader = $_.Exception.Response.Headers["Location"]
      Write-Host ("Redirect location: " + $locationHeader) -ForegroundColor Green
      Write-Host "(A redirect to /inventory/login is the expected/normal behavior for an unauthenticated visitor.)"
    }
  } else {
    Write-Host ("Request failed without an HTTP response: " + $_.Exception.Message) -ForegroundColor Red
  }
}

Write-Section "Summary"
Write-Host ("New app ID     : " + $newAppId)
Write-Host ("New staging URL: " + $newSiteUrl)
Write-Host "Platform       : WEB_COMPUTE"
Write-Host "Framework      : Next.js - SSR"
Write-Host ("Job ID         : " + $newJobId)
Write-Host ("Job status     : " + $finalStatus)
Write-Host ("Existing app " + $ExistingProductionAppId + " (production 'main'): NOT modified.") -ForegroundColor Green
