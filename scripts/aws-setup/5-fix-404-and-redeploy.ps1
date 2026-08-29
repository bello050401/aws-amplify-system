<#
.SYNOPSIS
  Read-only diagnosis of the "staging URL returns 404" problem on the
  EXISTING Amplify app. Makes NO changes to that app. See
  6-create-staging-app.ps1 for the actual fix.

.DESCRIPTION
  CORRECTED (previous version of this script was wrong): the Amplify app
  d1uy61lbnqm8ae also hosts "main" as its PRODUCTION branch. Changing this
  app's platform (an app-level setting, not a per-branch one) from WEB to
  WEB_COMPUTE could affect that production branch's build/runtime
  behavior. This script therefore NEVER calls update-app, update-branch,
  or start-job against this app - it only reads and reports.

  Confirmed root cause (see docs/aws-test-environment.md section 8):
  the Amplify app is configured with platform=WEB (static-only hosting),
  but this is a Next.js 14 SSR app (Amplify requires platform=WEB_COMPUTE
  for any Next.js app on version 14+, whether it uses SSR or SSG) - AWS's
  own docs state this explicitly. With platform=WEB, Amplify has no server
  runtime to execute the app's SSR routes, so every request 404s.

  Because platform is app-level and this app is shared with a production
  branch, the actual fix is NOT to change this app - it is to create a
  brand new, dedicated staging Amplify app with platform=WEB_COMPUTE from
  the start (see 6-create-staging-app.ps1). This script's only job is to
  gather and print evidence:
    1. Read-only: get-app / get-branch, print platform/framework, and
       list every branch on the app (so a human can see "main" is there).
    2. Read-only: list-branches to double-check for any branch besides
       the test branch - if the app has more than one branch OR has a
       branch literally named "main", this script prints a clear warning
       that mutating this app is unsafe and refuses to offer any mutating
       action at all (there is none in this script to run).
    3. Read-only (optional but recommended): download job 5's BUILD
       artifact and list its top-level contents, to directly confirm what
       was actually deployed (an SSR .next tree, not a static site).

  This script is plain ASCII on purpose - see 1-discover.ps1's header
  comment for why (Windows PowerShell 5.1 + non-ASCII text without a BOM
  can corrupt string literals and produce ParserError).

.PARAMETER AppId
  Amplify app ID to inspect (default: d1uy61lbnqm8ae - the EXISTING app
  that also hosts production "main". This script never modifies it.)

.PARAMETER BranchName
  The test branch to report on (default: claude/inventory-management-system-5vbvc7).

.PARAMETER Region
  AWS region (default: us-west-2).

.PARAMETER ProfileName
  AWS CLI profile name (default: Bello).

.PARAMETER InspectJobId
  Job ID whose BUILD artifact to download and inspect (default: 5).

.EXAMPLE
  .\5-fix-404-and-redeploy.ps1
#>
param(
  [string]$AppId = "d1uy61lbnqm8ae",
  [string]$BranchName = "claude/inventory-management-system-5vbvc7",
  [string]$Region = "us-west-2",
  [string]$ProfileName = "Bello",
  [string]$InspectJobId = "5"
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

Write-Host "BELLO Amplify - read-only 404 diagnosis (existing app, NOT modified)" -ForegroundColor Green
Write-Host ("AppId=" + $AppId + " Branch=" + $BranchName + " Region=" + $Region)
Write-Host "This script makes NO changes. It only reads and reports." -ForegroundColor Yellow

# ---- 0. Identity / root check ----------------------------------------------
$identityResult = Invoke-AwsCli -ArgList @("sts", "get-caller-identity", "--profile", $ProfileName, "--region", $Region, "--output", "json")
if (-not $identityResult.Ok) {
  Write-Host "Failed to get AWS identity. Run 1-discover.ps1 first." -ForegroundColor Red
  Write-Host $identityResult.Raw
  exit 1
}
$identity = $identityResult.Raw | ConvertFrom-Json
Write-Host ("Identity: " + $identity.Arn)

# ---- 1. Current app/branch settings -----------------------------------------
Write-Section "1. Current app settings (read-only)"
$appResult = Invoke-AwsCli -ArgList @("amplify", "get-app", "--app-id", $AppId, "--profile", $ProfileName, "--region", $Region, "--output", "json")
if (-not $appResult.Ok) {
  Write-Host "get-app failed:" -ForegroundColor Red
  Write-Host $appResult.Raw
  exit 1
}
$app = ($appResult.Raw | ConvertFrom-Json).app
Write-Host ("App name: " + $app.name)
Write-Host ("App platform: " + $app.platform)

Write-Section "2. All branches on this app (read-only) - checking for production"
$branchesResult = Invoke-AwsCli -ArgList @("amplify", "list-branches", "--app-id", $AppId, "--profile", $ProfileName, "--region", $Region, "--output", "json")
$hasMainOrOtherBranch = $false
if ($branchesResult.Ok) {
  $branches = ($branchesResult.Raw | ConvertFrom-Json).branches
  foreach ($b in $branches) {
    Write-Host ("  - " + $b.branchName + " (stage=" + $b.stage + ", framework=" + $(if ($b.framework) { $b.framework } else { "(null)" }) + ")")
    if ($b.branchName -ne $BranchName) { $hasMainOrOtherBranch = $true }
  }
} else {
  Write-Host "list-branches failed:" -ForegroundColor Red
  Write-Host $branchesResult.Raw
}

if ($hasMainOrOtherBranch) {
  Write-Host ""
  Write-Host "[SAFETY] This app has at least one branch other than the test branch (likely 'main' / production)." -ForegroundColor Red
  Write-Host "[SAFETY] Changing this app's platform (an app-level setting) could affect that branch." -ForegroundColor Red
  Write-Host "[SAFETY] This script will NOT offer to change platform/framework or start a job on this app." -ForegroundColor Red
  Write-Host "[SAFETY] Use 6-create-staging-app.ps1 to create a separate, dedicated staging app instead." -ForegroundColor Red
}

$branchResult = Invoke-AwsCli -ArgList @("amplify", "get-branch", "--app-id", $AppId, "--branch-name", $BranchName, "--profile", $ProfileName, "--region", $Region, "--output", "json")
if ($branchResult.Ok) {
  $branch = ($branchResult.Raw | ConvertFrom-Json).branch
  Write-Host ("Test branch framework: " + $(if ($branch.framework) { $branch.framework } else { "(null)" }))
}

# ---- 3. Inspect the actual deployed BUILD artifact (read-only) -------------
Write-Section ("3. Inspecting job " + $InspectJobId + "'s BUILD artifact (read-only)")
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
        Write-Host "Confirmed: this is a Next.js SSR build (server/ present, no root index.html) - platform=WEB cannot serve this correctly, it needs platform=WEB_COMPUTE." -ForegroundColor Yellow
      }
    } catch {
      Write-Host ("Could not download/inspect the artifact (non-fatal): " + $_.Exception.Message) -ForegroundColor Yellow
    }
  } else {
    Write-Host "No BUILD step artifactsUrl found on this job." -ForegroundColor Yellow
  }
} else {
  Write-Host "get-job failed:" -ForegroundColor Yellow
  Write-Host $jobDetailResult.Raw
}

Write-Section "Summary"
Write-Host "This script made NO changes to this app." -ForegroundColor Green
Write-Host "Next step: run 6-create-staging-app.ps1 to create a separate, dedicated staging app with platform=WEB_COMPUTE from the start."
