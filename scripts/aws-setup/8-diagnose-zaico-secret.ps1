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
      region (describe-secret)?
    - If found: prints its ARN and name only (never SecretString /
      VersionId payload - describe-secret does not return the value at
      all, and this script never calls get-secret-value).

  Root cause of a real false negative this script (and
  7-fix-staging-iam-role.ps1's preflight) previously had: describe-secret
  DID find the secret, but AWS CLI then crashed trying to print its
  Description (which contained a Unicode em dash, U+2014) to a Windows
  PowerShell 5.1 console using the cp932 codepage -
  "'cp932' codec can't encode character ... illegal multibyte sequence" -
  an encoding failure while PRINTING output, unrelated to whether the
  secret exists. The non-zero exit code that crash produced was
  misread as "not found". Fixed by requesting ONLY ARN and Name via
  --query (Description/Tags/etc. are never part of what AWS CLI has to
  serialize, so this specific crash cannot recur), and by classifying
  any remaining failure by its actual error text (Get-AwsErrorKind)
  rather than assuming any non-zero exit means "not found".

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

function Get-AwsErrorKind {
  # See this script's header comment - only a real ResourceNotFoundException
  # means "not found". AccessDenied/credential/encoding failures are
  # distinct problems and must never be reported as "secret does not exist".
  param([string]$RawText)
  if ($RawText -match "ResourceNotFoundException") { return "not-found" }
  if ($RawText -match "AccessDenied") { return "access-denied" }
  if ($RawText -match "CredentialsProviderError|could not load credentials|ExpiredToken|InvalidClientTokenId|UnrecognizedClientException") { return "credentials" }
  if ($RawText -match "codec can't encode|UnicodeEncodeError|illegal multibyte sequence|UnicodeDecodeError") { return "encoding" }
  return "other"
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

  # --query restricts AWS CLI's own output to exactly ARN and Name - see
  # header comment for why Description/Tags/etc. are deliberately never
  # requested (they can contain non-ASCII text that crashes AWS CLI's own
  # console output encoding on Windows, which is not the same thing as the
  # secret not existing).
  $describeResult = Invoke-AwsCli -ArgList @("secretsmanager", "describe-secret", "--secret-id", $SecretName, "--query", "{ARN:ARN,Name:Name}", "--profile", $ProfileName, "--region", $region, "--output", "json")
  if ($describeResult.Ok) {
    $secretInfo = $describeResult.Raw | ConvertFrom-Json
    Write-Host ("  FOUND in " + $region + ":") -ForegroundColor Green
    Write-Host ("    Name : " + $secretInfo.Name)
    Write-Host ("    ARN  : " + $secretInfo.ARN)
    $foundIn += @{ Region = $region; Name = $secretInfo.Name; Arn = $secretInfo.ARN }
  } else {
    $errorKind = Get-AwsErrorKind -RawText $describeResult.Raw
    switch ($errorKind) {
      "not-found" {
        Write-Host ("  Not found in " + $region + " (ResourceNotFoundException - confirmed, not a false negative).") -ForegroundColor Yellow
      }
      "access-denied" {
        Write-Host ("  Could not check " + $region + " - AccessDenied. This is a permissions problem, NOT evidence the secret is missing:") -ForegroundColor Red
        Write-Host $describeResult.Raw
      }
      "credentials" {
        Write-Host ("  Could not check " + $region + " - credential problem, NOT evidence the secret is missing:") -ForegroundColor Red
        Write-Host $describeResult.Raw
      }
      "encoding" {
        Write-Host ("  [BUG PATTERN AVOIDED] Got an encoding-class error in " + $region + " even with the minimal --query -") -ForegroundColor Red
        Write-Host "  this should not happen since ARN/Name are plain ASCII. Reporting as inconclusive, NOT as not-found:" -ForegroundColor Red
        Write-Host $describeResult.Raw
      }
      default {
        Write-Host ("  Could not check " + $region + " for an unrecognized reason - NOT evidence the secret is missing:") -ForegroundColor Yellow
        Write-Host $describeResult.Raw
      }
    }
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
