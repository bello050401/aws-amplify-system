<#
.SYNOPSIS
  Add the claude/inventory-management-system-5vbvc7 branch to an
  existing Amplify app and start its first build (this script makes a
  change - it asks for confirmation first).

.DESCRIPTION
  Prerequisite: 1-discover.ps1 already found an existing Amplify app
  connected to bello050401/aws-amplify-system. If no Amplify app exists
  yet, this script cannot be used - you first need to create one and
  connect the GitHub repository through the AWS Console (this requires
  GitHub OAuth consent, which only you can grant - see
  docs/aws-test-environment.md section 4).

  Never touches the main branch or any other existing branch's settings.

  This script is plain ASCII on purpose - see 1-discover.ps1's header
  comment for why (Windows PowerShell 5.1 + non-ASCII text without a
  BOM can corrupt string literals and produce ParserError).

.PARAMETER AppId
  The target Amplify app ID (from 1-discover.ps1's output). Required.

.PARAMETER BranchName
  The branch to add (default: claude/inventory-management-system-5vbvc7 - normally leave this as-is).

.PARAMETER ProfileName
  AWS CLI profile name (default: Bello)

.PARAMETER Region
  AWS region (default: us-east-1)

.PARAMETER Force
  Skip the confirmation prompt and apply immediately.

.EXAMPLE
  .\3-create-branch.ps1 -AppId d1234567890abc
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$AppId,

  [string]$BranchName = "claude/inventory-management-system-5vbvc7",

  [string]$ProfileName = "Bello",
  [string]$Region = "us-east-1",

  [switch]$Force
)

$ErrorActionPreference = "Stop"

Write-Host "BELLO AWS test environment - add Amplify branch" -ForegroundColor Green
Write-Host ("AppId  : " + $AppId)
Write-Host ("Branch : " + $BranchName + " (main is never touched by this script)")

if ($BranchName -eq "main") {
  Write-Host "Refusing to run against the main branch. Stopping." -ForegroundColor Red
  exit 1
}

if (-not $Force) {
  $confirmation = Read-Host ("Add branch '" + $BranchName + "' to app '" + $AppId + "' and start a build? (type yes to continue)")
  if ($confirmation -ne "yes") {
    Write-Host "Cancelled. No changes were made." -ForegroundColor Yellow
    exit 0
  }
}

Write-Host ""
Write-Host "-- Creating branch --"
& aws amplify create-branch `
  --app-id $AppId `
  --branch-name $BranchName `
  --profile $ProfileName --region $Region

if ($LASTEXITCODE -ne 0) {
  Write-Host "create-branch failed (this is fine if the branch already exists - just re-run the job-start step below)." -ForegroundColor Yellow
} else {
  Write-Host "Branch created." -ForegroundColor Green
}

Write-Host ""
Write-Host "-- Starting the first build (RELEASE job) --"
& aws amplify start-job `
  --app-id $AppId `
  --branch-name $BranchName `
  --job-type RELEASE `
  --profile $ProfileName --region $Region

if ($LASTEXITCODE -ne 0) {
  Write-Host "Failed to start the build job. The GitHub webhook connection may not be complete - check the branch's status in the Amplify Console." -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "Build started. Check progress with:" -ForegroundColor Green
Write-Host ("  aws amplify list-jobs --app-id " + $AppId + " --branch-name " + $BranchName + " --profile " + $ProfileName + " --region " + $Region)
Write-Host ""
Write-Host "Approximate URL once the build finishes (confirm the exact value in the Amplify Console branch detail page):"
$urlSafeBranch = $BranchName -replace "/", "-"
Write-Host ("  https://" + $urlSafeBranch + "." + $AppId + ".amplifyapp.com")
