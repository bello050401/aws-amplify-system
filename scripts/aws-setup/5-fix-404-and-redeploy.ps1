<#
.SYNOPSIS
  Diagnose and fix the "staging URL returns 404" problem, then redeploy and
  verify. Confirmed root cause (see docs/aws-test-environment.md section 8):
  the Amplify app is configured with platform=WEB (static-only hosting),
  but this is a Next.js 14 SSR app (Amplify requires platform=WEB_COMPUTE
  for any Next.js app on version 14+, whether it uses SSR or SSG) - AWS's
  own docs state this explicitly. With platform=WEB, Amplify has no server
  runtime to execute the app's SSR routes (this app's own build output
  shows only "/" and "/_not-found" as static; every other route -
  /inventory, /admin, /inventory/settings, etc. - is server-rendered on
  demand) or even the App Router's own routing for "/", so every request
  falls through to a plain static-file 404.

.DESCRIPTION
  Steps performed, each printed clearly before it happens:
    1. Read-only: get-app / get-branch, confirm current platform/framework.
    2. Read-only (optional but recommended): download job 5's BUILD
       artifact and list its top-level contents, to directly confirm what
       was actually deployed (an SSR .next tree, not a static site) rather
       than assuming this script's stated diagnosis without evidence.
    3. If platform is not already WEB_COMPUTE: confirm, then
       `aws amplify update-app --platform WEB_COMPUTE` (app-level setting;
       this Amplify app is dedicated to this one test branch only - no
       "main"/production branch is connected to it - so this cannot affect
       any production deployment).
    4. If the branch's framework is not already "Next.js - SSR": confirm,
       then `aws amplify update-branch --framework "Next.js - SSR"`.
    5. Start a new RELEASE job so the corrected settings actually take
       effect (a platform/framework change does not retroactively affect
       an already-finished job).
    6. Poll the new job's status every 15 seconds (up to ~20 minutes) until
       it reaches a terminal state.
    7. On FAILED: fetch and print every build step's log so the real
       failure is visible (never just "it failed").
    8. On SUCCEED: fetch the public URL and print its HTTP status code.

  This script is plain ASCII on purpose - see 1-discover.ps1's header
  comment for why (Windows PowerShell 5.1 + non-ASCII text without a BOM
  can corrupt string literals and produce ParserError).

.PARAMETER AppId
  Amplify app ID (default: d1uy61lbnqm8ae, this project's staging app).

.PARAMETER BranchName
  Branch to redeploy (default: claude/inventory-management-system-5vbvc7).
  Refuses to run against "main".

.PARAMETER Region
  AWS region (default: us-west-2, per this app's actual region).

.PARAMETER ProfileName
  AWS CLI profile name (default: Bello).

.PARAMETER SiteUrl
  Public Hosted URL to verify at the end (default: this branch's known
  amplifyapp.com URL).

.PARAMETER InspectJobId
  Job ID whose BUILD artifact to download and inspect in step 2 (default:
  5, the job the user already confirmed SUCCEED on BUILD/DEPLOY/VERIFY).

.PARAMETER Force
  Skip confirmation prompts before the mutating steps (update-app,
  update-branch, start-job).

.EXAMPLE
  .\5-fix-404-and-redeploy.ps1
#>
param(
  [string]$AppId = "d1uy61lbnqm8ae",
  [string]$BranchName = "claude/inventory-management-system-5vbvc7",
  [string]$Region = "us-west-2",
  [string]$ProfileName = "Bello",
  [string]$SiteUrl = "https://claude-inventory-management-system-5vbvc7.d1uy61lbnqm8ae.amplifyapp.com",
  [string]$InspectJobId = "5",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

function Write-Section {
  param([string]$Title)
  Write-Host ""
  Write-Host ("==== " + $Title + " ====") -ForegroundColor Cyan
}

function Invoke-AwsCli {
  # Same Windows PowerShell 5.1 workaround as the other scripts in this
  # folder: switch to "Continue" only around the native call so aws.exe's
  # stderr is not promoted into a terminating NativeCommandError.
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

Write-Host "BELLO Amplify staging - diagnose and fix 404, then redeploy" -ForegroundColor Green
Write-Host ("AppId=" + $AppId + " Branch=" + $BranchName + " Region=" + $Region)

if ($BranchName -eq "main") {
  Write-Host "Refusing to run against the main branch. Stopping." -ForegroundColor Red
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

# ---- 1. Current app/branch settings -----------------------------------------
Write-Section "1. Current app and branch settings (read-only)"
$appResult = Invoke-AwsCli -ArgList @("amplify", "get-app", "--app-id", $AppId, "--profile", $ProfileName, "--region", $Region, "--output", "json")
if (-not $appResult.Ok) {
  Write-Host "get-app failed:" -ForegroundColor Red
  Write-Host $appResult.Raw
  exit 1
}
$app = ($appResult.Raw | ConvertFrom-Json).app
$currentPlatform = $app.platform
Write-Host ("Current app platform: " + $currentPlatform)

$branchResult = Invoke-AwsCli -ArgList @("amplify", "get-branch", "--app-id", $AppId, "--branch-name", $BranchName, "--profile", $ProfileName, "--region", $Region, "--output", "json")
if (-not $branchResult.Ok) {
  Write-Host "get-branch failed:" -ForegroundColor Red
  Write-Host $branchResult.Raw
  exit 1
}
$branch = ($branchResult.Raw | ConvertFrom-Json).branch
$currentFramework = $branch.framework
Write-Host ("Current branch framework: " + $(if ($currentFramework) { $currentFramework } else { "(null)" }))

# ---- 2. Inspect the actual deployed BUILD artifact (read-only, optional) ---
Write-Section ("2. Inspecting job " + $InspectJobId + "'s BUILD artifact (read-only)")
$jobDetailResult = Invoke-AwsCli -ArgList @("amplify", "get-job", "--app-id", $AppId, "--branch-name", $BranchName, "--job-id", $InspectJobId, "--profile", $ProfileName, "--region", $Region, "--output", "json")
if ($jobDetailResult.Ok) {
  $jobDetail = ($jobDetailResult.Raw | ConvertFrom-Json).job
  $buildStep = $jobDetail.steps | Where-Object { $_.stepName -eq "BUILD" }
  if ($buildStep -and $buildStep.artifactsUrl) {
    try {
      $artifactZip = Join-Path $env:TEMP "amplify-job-$InspectJobId-artifact.zip"
      Invoke-WebRequest -Uri $buildStep.artifactsUrl -OutFile $artifactZip -UseBasicParsing
      $extractDir = Join-Path $env:TEMP "amplify-job-$InspectJobId-extract"
      if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }
      Expand-Archive -Path $artifactZip -DestinationPath $extractDir -Force
      Write-Host "Top-level contents of the deployed artifact:"
      Get-ChildItem -Path $extractDir | ForEach-Object { Write-Host ("  - " + $_.Name) }
      $hasServerDir = Test-Path (Join-Path $extractDir "server")
      $hasIndexHtml = Test-Path (Join-Path $extractDir "index.html")
      Write-Host ("Has a server/ directory (Next.js SSR build output): " + $hasServerDir)
      Write-Host ("Has a plain index.html at the artifact root (what static WEB hosting needs): " + $hasIndexHtml)
      if ($hasServerDir -and -not $hasIndexHtml) {
        Write-Host "This confirms the artifact is a Next.js SSR build (server/ present, no root index.html) - platform=WEB cannot serve this correctly." -ForegroundColor Yellow
      }
    } catch {
      Write-Host ("Could not download/inspect the artifact (non-fatal, continuing): " + $_.Exception.Message) -ForegroundColor Yellow
    }
  } else {
    Write-Host "No BUILD step artifactsUrl found on this job (non-fatal, continuing)." -ForegroundColor Yellow
  }
} else {
  Write-Host "get-job failed (non-fatal, continuing):" -ForegroundColor Yellow
  Write-Host $jobDetailResult.Raw
}

# ---- 3/4. Fix platform and framework if needed ------------------------------
Write-Section "3. Platform / framework fix"
$needsPlatformFix = ($currentPlatform -ne "WEB_COMPUTE")
$needsFrameworkFix = ($currentFramework -ne "Next.js - SSR")

if (-not $needsPlatformFix -and -not $needsFrameworkFix) {
  Write-Host "Platform is already WEB_COMPUTE and framework is already 'Next.js - SSR'. No app/branch settings to fix." -ForegroundColor Green
} else {
  if ($needsPlatformFix) {
    Write-Host ("Will change app platform: " + $currentPlatform + " -> WEB_COMPUTE") -ForegroundColor Yellow
    Write-Host "(This is an app-level setting. This Amplify app is dedicated to this one test branch - no main/production branch is connected to it - so this change cannot affect any production deployment.)"
  }
  if ($needsFrameworkFix) {
    Write-Host ("Will change branch framework: " + $(if ($currentFramework) { $currentFramework } else { "(null)" }) + " -> 'Next.js - SSR'") -ForegroundColor Yellow
  }

  if (-not $Force) {
    $confirmation = Read-Host "Apply the above change(s)? (type yes to continue)"
    if ($confirmation -ne "yes") {
      Write-Host "Cancelled. No changes were made." -ForegroundColor Yellow
      exit 0
    }
  }

  if ($needsPlatformFix) {
    $updateAppResult = Invoke-AwsCli -ArgList @("amplify", "update-app", "--app-id", $AppId, "--platform", "WEB_COMPUTE", "--profile", $ProfileName, "--region", $Region, "--output", "json")
    if (-not $updateAppResult.Ok) {
      Write-Host "update-app failed:" -ForegroundColor Red
      Write-Host $updateAppResult.Raw
      exit 1
    }
    Write-Host "App platform updated to WEB_COMPUTE." -ForegroundColor Green
  }

  if ($needsFrameworkFix) {
    $updateBranchResult = Invoke-AwsCli -ArgList @("amplify", "update-branch", "--app-id", $AppId, "--branch-name", $BranchName, "--framework", "Next.js - SSR", "--profile", $ProfileName, "--region", $Region, "--output", "json")
    if (-not $updateBranchResult.Ok) {
      Write-Host "update-branch failed:" -ForegroundColor Red
      Write-Host $updateBranchResult.Raw
      exit 1
    }
    Write-Host "Branch framework updated to 'Next.js - SSR'." -ForegroundColor Green
  }
}

# ---- 5. Start a new job to redeploy with corrected settings -----------------
Write-Section "4. Starting a new RELEASE job"
$startJobResult = Invoke-AwsCli -ArgList @("amplify", "start-job", "--app-id", $AppId, "--branch-name", $BranchName, "--job-type", "RELEASE", "--profile", $ProfileName, "--region", $Region, "--output", "json")
if (-not $startJobResult.Ok) {
  Write-Host "start-job failed:" -ForegroundColor Red
  Write-Host $startJobResult.Raw
  exit 1
}
$newJobId = ($startJobResult.Raw | ConvertFrom-Json).jobSummary.jobId
Write-Host ("New job started: jobId=" + $newJobId) -ForegroundColor Green

# ---- 6. Poll until terminal state -------------------------------------------
Write-Section ("5. Polling job " + $newJobId + " (checks every 15s, up to ~20 minutes)")
$terminalStates = @("SUCCEED", "FAILED", "CANCELLED")
$finalStatus = $null
for ($i = 0; $i -lt 80; $i++) {
  Start-Sleep -Seconds 15
  $pollResult = Invoke-AwsCli -ArgList @("amplify", "get-job", "--app-id", $AppId, "--branch-name", $BranchName, "--job-id", $newJobId, "--profile", $ProfileName, "--region", $Region, "--output", "json")
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
  Write-Host "Timed out waiting for the job to finish (still not terminal after ~20 minutes). Check manually:" -ForegroundColor Red
  Write-Host ("  aws amplify get-job --app-id " + $AppId + " --branch-name " + $BranchName + " --job-id " + $newJobId + " --profile " + $ProfileName + " --region " + $Region)
  exit 1
}

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
  Write-Host "Job failed. Review the logs above; this script did not attempt an automatic further fix beyond the platform/framework change." -ForegroundColor Red
  exit 1
}

# ---- 8. On SUCCEED: verify the public URL -----------------------------------
Write-Section "7. Job SUCCEED - verifying the public URL"
Write-Host ("URL: " + $SiteUrl)
try {
  $response = Invoke-WebRequest -Uri $SiteUrl -UseBasicParsing -MaximumRedirection 0 -ErrorAction Stop
  Write-Host ("HTTP status: " + $response.StatusCode) -ForegroundColor Green
} catch {
  if ($_.Exception.Response) {
    $statusCode = [int]$_.Exception.Response.StatusCode
    Write-Host ("HTTP status: " + $statusCode) -ForegroundColor $(if ($statusCode -ge 200 -and $statusCode -lt 400) { "Green" } else { "Red" })
    if ($statusCode -eq 302 -or $statusCode -eq 301) {
      # Windows PowerShell 5.1's Invoke-WebRequest throws a
      # System.Net.WebException whose Response is a plain
      # System.Net.HttpWebResponse - its Headers collection is indexed by
      # key (WebHeaderCollection), not a named ".Location" property (that
      # named-property style only exists on PowerShell 7's HttpResponseMessage).
      $locationHeader = $_.Exception.Response.Headers["Location"]
      Write-Host ("Redirect location: " + $locationHeader) -ForegroundColor Green
      Write-Host "(A redirect to /inventory/login is the expected/normal behavior for an unauthenticated visitor.)"
    }
  } else {
    Write-Host ("Request failed without an HTTP response: " + $_.Exception.Message) -ForegroundColor Red
  }
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
