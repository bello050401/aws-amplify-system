<#
.SYNOPSIS
  Read-only: confirm which AWS region(s) actually contain the
  bello/zaico-api-token secret. Never reads or displays the secret
  VALUE - list/describe only.

.DESCRIPTION
  Context: amplify/backend.ts previously created bello/zaico-api-token
  as a CloudFormation-owned resource; that has been changed to import
  it as an existing external resource instead (see
  docs/aws-test-environment.md section 10). lib/zaico/secretStore.ts's
  region fallback also used to default to us-east-1 - a guess that did
  not match where the app actually deploys - and has been corrected to
  us-west-2. This script exists so that correction is verified against
  real AWS state rather than assumed a second time.

  Checks, in both us-west-2 and us-east-1:
    - Does a secret literally named bello/zaico-api-token exist in this
      region (list-secrets with a name filter, and describe-secret)?
    - If found: prints its ARN and name only (never SecretString /
      VersionId payload - describe-secret does not return the value at
      all, and this script never calls get-secret-value).

  This script makes NO changes to any AWS resource - it is pure
  read-only diagnosis, safe to run against the same account used for
  the production app.

  This script is plain ASCII on purpose - see 1-discover.ps1's header
  comment for why (Windows PowerShell 5.1 + non-ASCII text without a
  BOM can corrupt string literals and produce ParserError).

.PARAMETER SecretName
  The secret name to look for (default: bello/zaico-api-token).

.PARAMETER Regions
  Regions to check (default: us-west-2, us-east-1 - the region the
  apps actually deploy to, and the previous incorrect fallback default,
  respectively).

.PARAMETER ProfileName
  AWS CLI profile name (default: Bello).

.EXAMPLE
  .\8-diagnose-zaico-secret.ps1
#>
param(
  [string]$SecretName = "bello/zaico-api-token",
  [string[]]$Regions = @("us-west-2", "us-east-1"),
  [string]$ProfileName = "Bello"
)

$ErrorActionPreference = "Stop"

function Write-Section {
  param([string]$Title)
  Write-Host ""
  Write-Host ("==== " + $Title + " ====") -ForegroundColor Cyan
}

function Invoke-AwsCli {
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

Write-Host "BELLO - read-only diagnosis of the bello/zaico-api-token secret's real region(s)" -ForegroundColor Green
Write-Host "This script never calls get-secret-value and never displays a secret VALUE." -ForegroundColor Yellow

# ---- 0. Identity / root check (uses the first region only for this call) --
$identityResult = Invoke-AwsCli -ArgList @("sts", "get-caller-identity", "--profile", $ProfileName, "--region", $Regions[0], "--output", "json")
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

$foundIn = @()

foreach ($region in $Regions) {
  Write-Section ("Checking region: " + $region)

  # describe-secret is the more direct check (exact name, no pagination) -
  # a ResourceNotFoundException here just means "not in this region",
  # which is expected and not an error condition for this script.
  $describeResult = Invoke-AwsCli -ArgList @("secretsmanager", "describe-secret", "--secret-id", $SecretName, "--profile", $ProfileName, "--region", $region, "--output", "json")
  if ($describeResult.Ok) {
    $secretInfo = $describeResult.Raw | ConvertFrom-Json
    Write-Host ("  FOUND in " + $region + ":") -ForegroundColor Green
    Write-Host ("    Name : " + $secretInfo.Name)
    Write-Host ("    ARN  : " + $secretInfo.ARN)
    if ($secretInfo.DeletedDate) {
      Write-Host ("    [NOTE] This secret has a DeletedDate set (" + $secretInfo.DeletedDate + ") - it is scheduled for deletion, not active.") -ForegroundColor Yellow
    }
    $foundIn += @{ Region = $region; Name = $secretInfo.Name; Arn = $secretInfo.ARN }
  } elseif ($describeResult.Raw -match "ResourceNotFoundException") {
    Write-Host ("  Not found in " + $region + ".") -ForegroundColor Yellow
  } else {
    Write-Host ("  Could not check " + $region + " (non-fatal, see raw output):") -ForegroundColor Yellow
    Write-Host $describeResult.Raw
  }
}

Write-Section "Summary"
if ($foundIn.Count -eq 0) {
  Write-Host "The secret was not found in any checked region. If a build recently failed with" -ForegroundColor Red
  Write-Host "AlreadyExists for this secret, it must exist SOMEWHERE in this account - try adding" -ForegroundColor Red
  Write-Host "that region to -Regions and re-running." -ForegroundColor Red
} elseif ($foundIn.Count -eq 1) {
  Write-Host ("Confirmed: exactly one region has this secret - " + $foundIn[0].Region + ".") -ForegroundColor Green
  Write-Host ("  ARN: " + $foundIn[0].Arn)
  Write-Host ""
  Write-Host "This should match the region lib/zaico/secretStore.ts's REGION constant resolves to" -ForegroundColor Cyan
  Write-Host "at runtime (AWS_REGION / AWS_DEFAULT_REGION env var, or its hardcoded fallback)." -ForegroundColor Cyan
} else {
  Write-Host "[WARNING] The secret exists in MORE THAN ONE region:" -ForegroundColor Red
  foreach ($f in $foundIn) {
    Write-Host ("  - " + $f.Region + ": " + $f.Arn)
  }
  Write-Host ""
  Write-Host "Do not duplicate or delete either copy without understanding why both exist first -" -ForegroundColor Red
  Write-Host "figure out which runtime/backend is actually supposed to read from which region before" -ForegroundColor Red
  Write-Host "changing anything." -ForegroundColor Red
}
