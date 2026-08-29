<#
.SYNOPSIS
  Staging Amplify app deployment: preflight checks, IAM role fix (kept
  from the previous version of this script, unchanged logic), build,
  poll, readable failure diagnosis, and post-success HTTP checks - all
  in one script. Never touches the existing production app/role/main.

.DESCRIPTION
  This script started as an IAM-only fix (the staging app's backend
  deployment role could not be assumed - see section "IAM role" below,
  now resolved and left in place, idempotent). It has since been
  broadened into the general staging-deployment validate/build/diagnose
  script, per the decision to consolidate all AWS-side steps the user
  would otherwise have to run one at a time into a single script.

  ---- Most recent real root cause (do not re-diagnose this as IAM/
       WEB_COMPUTE/CDK-bootstrap - confirmed resolved) ----------------
  A real build log showed the backend actually reached CloudFormation
  deployment (past IAM AssumeRole, past CDK bootstrap) and failed with:
    AWS::SecretsManager::Secret ZaicoTokenSecretStack/ZaicoApiTokenSecret
    CREATE_FAILED - "The operation failed because the secret
    bello/zaico-api-token already exists." (HandlerErrorCode: AlreadyExists)
  Every other CREATE_FAILED in that log (Cognito group roles, the SKU
  counter table, etc.) was a secondary rollback effect of this one
  failure, not an independent problem. The fix is in the application
  code (amplify/backend.ts now imports this secret with
  Secret.fromSecretNameV2 instead of creating it - see
  docs/aws-test-environment.md section 10) - this script's job is to
  validate that fix took effect (via the preflight secret/stack checks
  below) and then actually run the build.

  Steps performed:
    0. Identity / root check.
    1. IAM role: read-only inspect the production role's policies,
       create/update the staging-only role (BelloAmplifyStagingBackend
       DeploymentRole) with a trust policy scoped ONLY to the staging
       app's ARN, replicate permissions onto it, point the staging
       app's iamServiceRoleArn at it. All of this is idempotent - safe
       to re-run even though it already succeeded once.
    2. Preflight (read-only; aborts BEFORE starting a build if anything
       looks wrong): identity/account, region, staging app ID is not
       the production app ID, branch is not "main", app platform is
       WEB_COMPUTE, branch framework is "Next.js - SSR", staging role
       ARN matches what step 1 just set, whether bello/zaico-api-token
       exists in this region (list/describe only, never the value),
       and a best-effort listing of this app's CloudFormation stacks
       and their StackStatus (so a ROLLBACK_COMPLETE stack is visible
       up front rather than discovered only after a failure - Amplify's
       own pipeline-deploy/CDK deploy handles cleaning up a
       ROLLBACK_COMPLETE stack on the next deploy automatically; this
       script does not call cloudformation delete-stack itself).
    3. Confirm the staging app's only branch is the target branch.
    4. Start a new RELEASE build, poll every 15 seconds (up to ~20
       minutes).
    5. On FAILED: fetch every step's log as readable UTF-8 text (fixing
       the previous byte-array/garbled-numbers display bug - see
       ConvertTo-DecodedLogText below), save the full combined log to a
       temp file for manual inspection, and automatically extract the
       FIRST meaningful failure (not just the generic final "Build
       failed" banner) with 30 lines of context before / 20 after. If
       the extracted failure is the known IAM-propagation-delay pattern,
       retry automatically (up to 3 attempts total); otherwise stop and
       report exactly what failed.
    6. On SUCCEED: HTTP-check the public URL and two more entry points
       (/inventory, /inventory/login), and print the final job/app
       state for the report.

  This script does NOT set up the Secrets Manager "compute role" used
  by SSR runtime requests (a separate role from this backend deployment
  role - see 2-apply-secrets-policy.ps1, and
  docs/aws-test-environment.md section 10 for why CreateSecret was
  removed from that policy).

  This script is plain ASCII on purpose - see 1-discover.ps1's header
  comment for why (Windows PowerShell 5.1 + non-ASCII text without a
  BOM can corrupt string literals and produce ParserError).

.PARAMETER StagingAppId
  The dedicated staging Amplify app ID (default: d4hkkg7dty2du). This
  script hard-refuses to ever target the existing production app ID
  with a mutating call.

.PARAMETER BranchName
  The staging branch (default: claude/inventory-management-system-5vbvc7).
  Refuses to run if this is "main".

.PARAMETER Region
  AWS region (default: us-west-2).

.PARAMETER ProfileName
  AWS CLI profile name (default: Bello).

.PARAMETER ExistingBackendRoleName
  The existing PRODUCTION backend deployment role to read (never
  modified) as the basis for what permissions the staging role needs
  (default: BelloAmplifyBackendDeploymentRole).

.PARAMETER NewStagingRoleName
  Name of the staging-only backend deployment role (default:
  BelloAmplifyStagingBackendDeploymentRole). Already created by a
  previous run of this script; re-running is safe/idempotent.

.PARAMETER SecretName
  The ZAICO API token secret name to check for during preflight
  (default: bello/zaico-api-token). This script only ever lists/
  describes it - never reads or displays its value.

.PARAMETER Force
  Skip the confirmation prompt before making IAM changes (step 1 only -
  the build itself always proceeds automatically once preflight passes).

.EXAMPLE
  .\7-fix-staging-iam-role.ps1
#>
param(
  [string]$StagingAppId = "d4hkkg7dty2du",
  [string]$BranchName = "claude/inventory-management-system-5vbvc7",
  [string]$Region = "us-west-2",
  [string]$ProfileName = "Bello",
  [string]$ExistingBackendRoleName = "BelloAmplifyBackendDeploymentRole",
  [string]$NewStagingRoleName = "BelloAmplifyStagingBackendDeploymentRole",
  [string]$SecretName = "bello/zaico-api-token",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

# Defense in depth: this script must never operate against the existing
# production-hosting app or its role, under any circumstance.
$ExistingProductionAppId = "d1uy61lbnqm8ae"

# Temp files created during this run (build logs) - cleaned up at the very
# end of the script regardless of how it exits. IAM policy temp files are
# handled separately, closer to where they are created, since those must
# not persist even across a single failed AWS call.
$script:tempLogFiles = @()

function Write-Section {
  param([string]$Title)
  Write-Host ""
  Write-Host ("==== " + $Title + " ====") -ForegroundColor Cyan
}

function Remove-TempLogFiles {
  foreach ($f in $script:tempLogFiles) {
    Remove-Item -Force -ErrorAction SilentlyContinue $f
  }
  $script:tempLogFiles = @()
}

function New-TempJsonFile {
  # Root cause of "MalformedPolicyDocument: This policy contains invalid
  # Json" (seen when this script previously passed policy JSON directly as
  # an --assume-role-policy-document / --policy-document command-line
  # argument): ConvertTo-Json produces valid JSON on the PowerShell side, but
  # a JSON document full of embedded double quotes/braces/colons is exactly
  # the kind of string Windows native-process argument passing
  # (CommandLineToArgvW, which PowerShell's `& external @array` splatting
  # ultimately goes through) is known to mangle in transit to aws.exe - the
  # re-quoting/escaping rules involved do not round-trip a large JSON blob
  # reliably. This is exactly why AWS's own CLI documentation recommends
  # file:// for policy documents on Windows rather than an inline JSON
  # string.
  #
  # Fix: write the JSON to a temp file and let the caller pass
  # file://<path> instead. Windows PowerShell 5.1's built-in
  # -Encoding utf8 (Out-File/Set-Content) writes a UTF-8 BOM, which is also
  # not guaranteed safe for aws.exe to parse - so this writes raw UTF-8
  # without a BOM via [System.IO.File]::WriteAllText with an explicit
  # UTF8Encoding($false). The object is also round-tripped through
  # ConvertFrom-Json before being written, so a malformed object is caught
  # immediately rather than surfacing later as an opaque AWS-side error.
  param(
    [Parameter(Mandatory = $true)]$Object,
    [string]$Prefix = "bello-iam-policy"
  )
  $json = $Object | ConvertTo-Json -Depth 20
  $null = $json | ConvertFrom-Json
  $tempPath = Join-Path $env:TEMP ($Prefix + "-" + [Guid]::NewGuid().ToString("N") + ".json")
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($tempPath, $json, $utf8NoBom)
  return $tempPath
}

function ConvertTo-DecodedLogText {
  # Root cause of the previous "50 48 50 54 45 ..." byte-list log output:
  # Invoke-WebRequest -UseBasicParsing in Windows PowerShell 5.1 returns
  # .Content as a raw byte[] (not a string) whenever the response is not
  # recognized as text - which is common for presigned build-log URLs
  # served without an explicit text content-type. Piping a byte[] into
  # Write-Host prints each byte as a decimal number, which is exactly the
  # garbled numeric output that was seen. This also transparently handles
  # gzip-compressed content (detected by its magic bytes 0x1f 0x8b) in case
  # a log URL is ever served pre-compressed without transparent
  # decompression by Invoke-WebRequest.
  param($RawContent)
  if ($RawContent -is [string]) {
    return $RawContent
  }
  $bytes = [byte[]]$RawContent
  if ($bytes.Length -ge 2 -and $bytes[0] -eq 0x1f -and $bytes[1] -eq 0x8b) {
    $ms = New-Object System.IO.MemoryStream(, $bytes)
    $gz = New-Object System.IO.Compression.GZipStream($ms, [System.IO.Compression.CompressionMode]::Decompress)
    $reader = New-Object System.IO.StreamReader($gz, [System.Text.Encoding]::UTF8)
    try {
      return $reader.ReadToEnd()
    } finally {
      $reader.Dispose()
      $gz.Dispose()
      $ms.Dispose()
    }
  }
  return [System.Text.Encoding]::UTF8.GetString($bytes)
}

function Get-StepLogText {
  # Fetches one build step's log via its (presigned, time-limited) logUrl
  # and returns readable UTF-8 text. The URL itself is not printed - it is
  # a presigned URL that grants access on its own, so it is handled like a
  # secret-adjacent value even though it is not the ZAICO/GitHub secret.
  param([string]$LogUrl)
  $response = Invoke-WebRequest -Uri $LogUrl -UseBasicParsing
  return ConvertTo-DecodedLogText -RawContent $response.Content
}

function Find-FirstMeaningfulFailure {
  # Scans the full build log TOP-DOWN for the FIRST line matching a real
  # failure marker, and returns that line plus context - the generic final
  # "Build failed" banner Amplify always prints is deliberately excluded
  # from the marker list, since it is a summary, never the actual cause.
  param([string]$FullLogText)
  $lines = $FullLogText -split "`r?`n"
  $markers = @(
    "CREATE_FAILED",
    "UPDATE_FAILED",
    "DELETE_FAILED",
    "HandlerErrorCode",
    "\[ERROR\]",
    "AlreadyExists",
    "AccessDenied",
    "ResourceNotFoundException",
    "Unable to assume specified IAM Role"
  )
  $pattern = [string]::Join("|", $markers)
  for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($lines[$i] -match $pattern) {
      $start = [Math]::Max(0, $i - 30)
      $end = [Math]::Min($lines.Length - 1, $i + 20)
      $resourceTypeMatch = [regex]::Match($lines[$i], "AWS::[A-Za-z0-9:]+")
      $handlerErrorMatch = [regex]::Match($lines[$i], "HandlerErrorCode:\s*([A-Za-z]+)")
      return @{
        Found            = $true
        LineIndex        = $i
        MatchedLine      = $lines[$i]
        ResourceType     = $(if ($resourceTypeMatch.Success) { $resourceTypeMatch.Value } else { "(unknown - see matched line)" })
        HandlerErrorCode = $(if ($handlerErrorMatch.Success) { $handlerErrorMatch.Groups[1].Value } else { "(none found on this line)" })
        Context          = ($lines[$start..$end] -join "`n")
      }
    }
  }
  return @{ Found = $false }
}

function Get-AwsErrorKind {
  # Root cause of a real false negative seen in this script: describe-secret
  # DID find bello/zaico-api-token, but the AWS CLI (Python) then hit
  #   [ERROR]: 'cp932' codec can't encode character U+2014 in position 15:
  #   illegal multibyte sequence
  # while trying to write the secret's Description (which contained a
  # Unicode em dash, U+2014) to a Windows PowerShell 5.1 console using the
  # cp932 codepage - an encoding failure while PRINTING output that has
  # nothing to do with whether the secret exists. That crash produced a
  # non-zero exit code, which the previous version of this script's simple
  # "Ok ? found : not-found" check misread as ResourceNotFoundException.
  #
  # Fix (see the two callers below): stop requesting/printing fields that
  # can contain arbitrary Unicode (Description, Tags, etc.) via --query, so
  # this specific crash cannot happen again. This classifier is kept as a
  # second, independent layer of defense - it inspects the actual error
  # text and only ever reports "not-found" for a real
  # ResourceNotFoundException, distinguishing it from access-denied,
  # credential, and encoding-class failures, none of which mean "does not
  # exist".
  param([string]$RawText)
  if ($RawText -match "ResourceNotFoundException") { return "not-found" }
  if ($RawText -match "AccessDenied") { return "access-denied" }
  if ($RawText -match "CredentialsProviderError|could not load credentials|ExpiredToken|InvalidClientTokenId|UnrecognizedClientException") { return "credentials" }
  if ($RawText -match "codec can't encode|UnicodeEncodeError|illegal multibyte sequence|UnicodeDecodeError") { return "encoding" }
  return "other"
}

function Find-FirstStackFailureEvent {
  # CloudFormation's describe-stack-events returns events newest-first, so
  # "the first meaningful failure" (chronologically) is found by reversing
  # to oldest-first and taking the first *_FAILED status - not the last one
  # in the raw API response, which would be the earliest event, not the
  # root cause.
  param([array]$Events)
  $chronological = @($Events)
  [array]::Reverse($chronological)
  foreach ($ev in $chronological) {
    if ($ev.ResourceStatus -match "_FAILED$") {
      return @{
        Found              = $true
        LogicalResourceId  = $ev.LogicalResourceId
        ResourceType       = $ev.ResourceType
        ResourceStatus     = $ev.ResourceStatus
        ResourceStatusReason = $ev.ResourceStatusReason
        Timestamp          = $ev.Timestamp
      }
    }
  }
  return @{ Found = $false }
}

function Invoke-AwsCli {
  param([string[]]$ArgList)
  if ($ArgList -contains $ExistingProductionAppId) {
    Write-Host "[SAFETY ABORT] Refusing an AWS CLI call that references the existing production app ID." -ForegroundColor Red
    Remove-TempLogFiles
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

Write-Host "BELLO Amplify - staging deployment validate/build/diagnose (existing production app/role are never touched)" -ForegroundColor Green

if ($BranchName -eq "main") {
  Write-Host "Refusing to use 'main' as the staging branch name. Stopping." -ForegroundColor Red
  exit 1
}
if ($StagingAppId -eq $ExistingProductionAppId) {
  Write-Host "[SAFETY ABORT] -StagingAppId must not be the existing production app ID." -ForegroundColor Red
  exit 1
}
if ($NewStagingRoleName -eq $ExistingBackendRoleName) {
  Write-Host "[SAFETY ABORT] The new staging role name must differ from the existing production role name." -ForegroundColor Red
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
Write-Host ("Account : " + $accountId)

# ============================================================================
# STEP 1: IAM role fix (unchanged from the previous version of this script -
# this already worked; kept idempotent, not re-diagnosed as the problem)
# ============================================================================
Write-Section "1. Reading the existing production role's policies (read-only, not modified)"
$managedPolicyArns = @()
$inlinePolicies = @{}

$attachedResult = Invoke-AwsCli -ArgList @("iam", "list-attached-role-policies", "--role-name", $ExistingBackendRoleName, "--profile", $ProfileName, "--region", $Region, "--output", "json")
if ($attachedResult.Ok) {
  $attached = ($attachedResult.Raw | ConvertFrom-Json).AttachedPolicies
  foreach ($p in $attached) {
    Write-Host ("  Managed policy: " + $p.PolicyName + " (" + $p.PolicyArn + ")")
    $managedPolicyArns += $p.PolicyArn
  }
} else {
  Write-Host "  Could not list attached managed policies (non-fatal, continuing):" -ForegroundColor Yellow
  Write-Host $attachedResult.Raw
}

$inlineListResult = Invoke-AwsCli -ArgList @("iam", "list-role-policies", "--role-name", $ExistingBackendRoleName, "--profile", $ProfileName, "--region", $Region, "--output", "json")
if ($inlineListResult.Ok) {
  $inlineNames = ($inlineListResult.Raw | ConvertFrom-Json).PolicyNames
  foreach ($name in $inlineNames) {
    $getPolicyResult = Invoke-AwsCli -ArgList @("iam", "get-role-policy", "--role-name", $ExistingBackendRoleName, "--policy-name", $name, "--profile", $ProfileName, "--region", $Region, "--output", "json")
    if ($getPolicyResult.Ok) {
      $doc = ($getPolicyResult.Raw | ConvertFrom-Json).PolicyDocument
      $inlinePolicies[$name] = $doc
      Write-Host ("  Inline policy : " + $name)
    } else {
      Write-Host ("  Could not read inline policy '" + $name + "' (non-fatal, skipping):") -ForegroundColor Yellow
      Write-Host $getPolicyResult.Raw
    }
  }
} else {
  Write-Host "  Could not list inline policies (non-fatal, continuing):" -ForegroundColor Yellow
  Write-Host $inlineListResult.Raw
}

Write-Section "2. Creating/updating the staging-only backend deployment role"
$stagingAppArn = "arn:aws:amplify:" + $Region + ":" + $accountId + ":apps/" + $StagingAppId + "/branches/*"
$trustPolicyObj = @{
  Version   = "2012-10-17"
  Statement = @(
    @{
      Effect    = "Allow"
      Principal = @{
        Service = @("amplify.amazonaws.com", "amplifybackend.amazonaws.com")
      }
      Action    = "sts:AssumeRole"
      Condition = @{
        StringEquals = @{ "aws:SourceAccount" = $accountId }
        ArnLike      = @{ "aws:SourceArn" = $stagingAppArn }
      }
    }
  )
}
Write-Host ("  Role name         : " + $NewStagingRoleName)
Write-Host ("  Trust policy scope: " + $stagingAppArn + " ONLY (production app is not in this trust policy)")

$trustPolicyPath = New-TempJsonFile -Object $trustPolicyObj -Prefix "bello-staging-trust-policy"
try {
  if (-not $Force) {
    Write-Host ""
    Write-Host "About to create/update this IAM role and point the staging app at it (skip if already done)." -ForegroundColor Cyan
    $confirmation = Read-Host "Continue? (type yes to continue, or 'skip' to leave IAM alone and go straight to preflight/build)"
    if ($confirmation -eq "skip") {
      Write-Host "Skipping IAM role creation/update - assuming it is already correctly configured." -ForegroundColor Yellow
      $skipIamStep = $true
    } elseif ($confirmation -ne "yes") {
      Write-Host "Cancelled. No changes were made." -ForegroundColor Yellow
      exit 0
    }
  }

  if (-not $skipIamStep) {
    $existingStagingRoleResult = Invoke-AwsCli -ArgList @("iam", "get-role", "--role-name", $NewStagingRoleName, "--profile", $ProfileName, "--region", $Region, "--output", "json")
    if ($existingStagingRoleResult.Ok) {
      Write-Host "  Role already exists (re-run) - updating its trust policy in place." -ForegroundColor Yellow
      $updateTrustResult = Invoke-AwsCli -ArgList @("iam", "update-assume-role-policy", "--role-name", $NewStagingRoleName, "--policy-document", ("file://" + $trustPolicyPath), "--profile", $ProfileName, "--region", $Region)
      if (-not $updateTrustResult.Ok) {
        Write-Host "update-assume-role-policy failed:" -ForegroundColor Red
        Write-Host $updateTrustResult.Raw
        exit 1
      }
      $newRoleArn = ($existingStagingRoleResult.Raw | ConvertFrom-Json).Role.Arn
    } else {
      $createRoleResult = Invoke-AwsCli -ArgList @(
        "iam", "create-role",
        "--role-name", $NewStagingRoleName,
        "--assume-role-policy-document", ("file://" + $trustPolicyPath),
        "--description", "Amplify backend deployment role for the dedicated staging app only - never used by production.",
        "--profile", $ProfileName, "--region", $Region, "--output", "json"
      )
      if (-not $createRoleResult.Ok) {
        Write-Host "create-role failed:" -ForegroundColor Red
        Write-Host $createRoleResult.Raw
        exit 1
      }
      $newRoleArn = ($createRoleResult.Raw | ConvertFrom-Json).Role.Arn
    }

    foreach ($arn in $managedPolicyArns) {
      $attachResult = Invoke-AwsCli -ArgList @("iam", "attach-role-policy", "--role-name", $NewStagingRoleName, "--policy-arn", $arn, "--profile", $ProfileName, "--region", $Region)
      if ($attachResult.Ok) {
        Write-Host ("  Attached managed policy: " + $arn) -ForegroundColor Green
      } else {
        Write-Host ("  Failed to attach managed policy " + $arn + ":") -ForegroundColor Red
        Write-Host $attachResult.Raw
        exit 1
      }
    }
    foreach ($name in $inlinePolicies.Keys) {
      $inlinePolicyPath = New-TempJsonFile -Object $inlinePolicies[$name] -Prefix "bello-staging-inline-policy"
      try {
        $putResult = Invoke-AwsCli -ArgList @("iam", "put-role-policy", "--role-name", $NewStagingRoleName, "--policy-name", $name, "--policy-document", ("file://" + $inlinePolicyPath), "--profile", $ProfileName, "--region", $Region)
        if ($putResult.Ok) {
          Write-Host ("  Copied inline policy: " + $name) -ForegroundColor Green
        } else {
          Write-Host ("  Failed to copy inline policy " + $name + ":") -ForegroundColor Red
          Write-Host $putResult.Raw
          exit 1
        }
      } finally {
        Remove-Item -Force -ErrorAction SilentlyContinue $inlinePolicyPath
      }
    }

    $updateAppResult = Invoke-AwsCli -ArgList @("amplify", "update-app", "--app-id", $StagingAppId, "--iam-service-role-arn", $newRoleArn, "--profile", $ProfileName, "--region", $Region, "--output", "json")
    if (-not $updateAppResult.Ok) {
      Write-Host "update-app failed:" -ForegroundColor Red
      Write-Host $updateAppResult.Raw
      exit 1
    }
    Write-Host ("  Staging role ARN: " + $newRoleArn) -ForegroundColor Green
    Write-Host "  Staging app now uses the staging-only role." -ForegroundColor Green
  }
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $trustPolicyPath
}

# ============================================================================
# STEP 2: Preflight (read-only) - abort BEFORE starting a build if anything
# looks wrong, per the requirement to check everything up front rather than
# discover problems only after a 20-minute build attempt.
# ============================================================================
Write-Section "3. Preflight checks (read-only - no build started yet)"
$preflightProblems = @()

$appResult = Invoke-AwsCli -ArgList @("amplify", "get-app", "--app-id", $StagingAppId, "--profile", $ProfileName, "--region", $Region, "--output", "json")
if (-not $appResult.Ok) {
  Write-Host "get-app failed:" -ForegroundColor Red
  Write-Host $appResult.Raw
  exit 1
}
$app = ($appResult.Raw | ConvertFrom-Json).app
Write-Host ("  App name          : " + $app.name)
Write-Host ("  Platform          : " + $app.platform)
if ($app.platform -ne "WEB_COMPUTE") {
  $preflightProblems += "Platform is '" + $app.platform + "', expected WEB_COMPUTE."
}
Write-Host ("  iamServiceRoleArn : " + $(if ($app.iamServiceRoleArn) { $app.iamServiceRoleArn } else { "(none)" }))
if ($app.iamServiceRoleArn -notmatch [regex]::Escape($NewStagingRoleName)) {
  $preflightProblems += "App's iamServiceRoleArn does not reference '" + $NewStagingRoleName + "'."
}

$branchResult = Invoke-AwsCli -ArgList @("amplify", "get-branch", "--app-id", $StagingAppId, "--branch-name", $BranchName, "--profile", $ProfileName, "--region", $Region, "--output", "json")
if (-not $branchResult.Ok) {
  Write-Host "get-branch failed:" -ForegroundColor Red
  Write-Host $branchResult.Raw
  exit 1
}
$branch = ($branchResult.Raw | ConvertFrom-Json).branch
Write-Host ("  Branch framework  : " + $(if ($branch.framework) { $branch.framework } else { "(null)" }))
if ($branch.framework -ne "Next.js - SSR") {
  $preflightProblems += "Branch framework is '" + $branch.framework + "', expected 'Next.js - SSR'."
}

$branchesResult = Invoke-AwsCli -ArgList @("amplify", "list-branches", "--app-id", $StagingAppId, "--profile", $ProfileName, "--region", $Region, "--output", "json")
if ($branchesResult.Ok) {
  $branches = ($branchesResult.Raw | ConvertFrom-Json).branches
  $unexpectedBranches = $branches | Where-Object { $_.branchName -ne $BranchName }
  if ($unexpectedBranches) {
    $preflightProblems += "Staging app has a branch other than '" + $BranchName + "'."
  } else {
    Write-Host ("  Branches on app   : only '" + $BranchName + "' - OK") -ForegroundColor Green
  }
}

Write-Host ""
Write-Host ("  Checking for " + $SecretName + " in " + $Region + " (ARN/Name only via --query - see" )
Write-Host "  header comment for why Description/Tags are deliberately never requested)..."
# --query restricts the CLI's own JSON output to exactly these two fields,
# so a Description (or Tags, etc.) containing non-ASCII text - the actual
# cause of the cp932 encoding crash described in Get-AwsErrorKind's comment
# - is never part of what AWS CLI has to serialize/print at all. This is
# the real fix; Get-AwsErrorKind below is the second, independent layer.
$secretDescribeResult = Invoke-AwsCli -ArgList @("secretsmanager", "describe-secret", "--secret-id", $SecretName, "--query", "{ARN:ARN,Name:Name}", "--profile", $ProfileName, "--region", $Region, "--output", "json")
$secretArn = $null
if ($secretDescribeResult.Ok) {
  $secretInfo = $secretDescribeResult.Raw | ConvertFrom-Json
  $secretArn = $secretInfo.ARN
  Write-Host ("  Secret FOUND      : Name=" + $secretInfo.Name) -ForegroundColor Green
  Write-Host ("  Secret ARN        : " + $secretArn) -ForegroundColor Green
  Write-Host ("  Secret Region     : " + $Region) -ForegroundColor Green
} else {
  $errorKind = Get-AwsErrorKind -RawText $secretDescribeResult.Raw
  switch ($errorKind) {
    "not-found" {
      Write-Host ("  Secret genuinely NOT found in " + $Region + " (ResourceNotFoundException):") -ForegroundColor Red
      Write-Host $secretDescribeResult.Raw
      $preflightProblems += $SecretName + " was not found in " + $Region + " (ResourceNotFoundException - confirmed, not a false negative) - run 8-diagnose-zaico-secret.ps1 to check other regions before building."
    }
    "access-denied" {
      Write-Host "  Could not check - AccessDenied. This is a permissions problem, NOT evidence the secret is missing:" -ForegroundColor Red
      Write-Host $secretDescribeResult.Raw
      $preflightProblems += "describe-secret was denied (AccessDenied) - fix IAM permissions for the identity running this script, do not conclude the secret does not exist."
    }
    "credentials" {
      Write-Host "  Could not check - credential problem (expired SSO session, etc.), NOT evidence the secret is missing:" -ForegroundColor Red
      Write-Host $secretDescribeResult.Raw
      $preflightProblems += "describe-secret failed due to a credentials problem - re-run 'aws sso login' and retry, do not conclude the secret does not exist."
    }
    "encoding" {
      Write-Host "  [BUG PATTERN AVOIDED] Got an encoding-class error even with the minimal --query - this should not" -ForegroundColor Red
      Write-Host "  happen since ARN/Name are plain ASCII. Reporting as inconclusive, NOT as not-found:" -ForegroundColor Red
      Write-Host $secretDescribeResult.Raw
      $preflightProblems += "describe-secret failed with an encoding-class error even after restricting to ARN/Name - investigate the console codepage, do not conclude the secret does not exist."
    }
    default {
      Write-Host "  Could not check for an unrecognized reason - NOT evidence the secret is missing:" -ForegroundColor Red
      Write-Host $secretDescribeResult.Raw
      $preflightProblems += "describe-secret failed for an unclassified reason - see raw output above, do not conclude the secret does not exist."
    }
  }
}

Write-Host ""
Write-Host "  Checking this app's CloudFormation stacks for in-progress operations..."
# Restrict to StackStatus only, for the same reason as the secret query
# above - StackName is always ASCII/safe, but there is no reason to pull
# every field CloudFormation could return either.
function Get-StagingStacks {
  $result = Invoke-AwsCli -ArgList @("cloudformation", "describe-stacks", "--query", "Stacks[].{StackName:StackName,StackStatus:StackStatus}", "--profile", $ProfileName, "--region", $Region, "--output", "json")
  if (-not $result.Ok) { return $null }
  $all = $result.Raw | ConvertFrom-Json
  return @($all | Where-Object { $_.StackName -match [regex]::Escape($StagingAppId) })
}

$successTerminalStatuses = @("CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE", "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS")
$failureTerminalStatuses = @("ROLLBACK_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "CREATE_FAILED", "ROLLBACK_FAILED", "UPDATE_ROLLBACK_FAILED", "DELETE_FAILED", "IMPORT_ROLLBACK_COMPLETE", "IMPORT_ROLLBACK_FAILED")

$matchingStacks = Get-StagingStacks
if ($null -eq $matchingStacks) {
  Write-Host "  Could not list CloudFormation stacks (non-fatal, continuing):" -ForegroundColor Yellow
} elseif ($matchingStacks.Count -eq 0) {
  Write-Host "    No CloudFormation stacks matching this app ID found yet (expected before any successful deploy)." -ForegroundColor Yellow
} else {
  foreach ($s in $matchingStacks) {
    Write-Host ("    " + $s.StackName + " : " + $s.StackStatus)
  }

  $inProgress = $matchingStacks | Where-Object { $_.StackStatus -match "_IN_PROGRESS$" }
  if ($inProgress) {
    Write-Section "CloudFormation stabilization wait - a previous deploy is still active"
    Write-Host "  Not starting a new build while these stacks are still changing (a concurrent deploy on the" -ForegroundColor Yellow
    Write-Host "  same stack would be rejected by CloudFormation anyway). Waiting for a terminal status, every" -ForegroundColor Yellow
    Write-Host "  20s, up to ~20 minutes. This does NOT call delete-stack or touch any resource - read-only wait." -ForegroundColor Yellow
    $maxWaitIterations = 60
    for ($w = 0; $w -lt $maxWaitIterations; $w++) {
      Start-Sleep -Seconds 20
      $matchingStacks = Get-StagingStacks
      $stillInProgress = $matchingStacks | Where-Object { $_.StackStatus -match "_IN_PROGRESS$" }
      $statusLine = ($matchingStacks | ForEach-Object { $_.StackName + "=" + $_.StackStatus }) -join "; "
      Write-Host ("    [" + (Get-Date -Format "HH:mm:ss") + "] " + $statusLine)
      if (-not $stillInProgress) { break }
    }
    if ($matchingStacks | Where-Object { $_.StackStatus -match "_IN_PROGRESS$" }) {
      $preflightProblems += "CloudFormation stack(s) for this app are still *_IN_PROGRESS after the ~20 minute wait - do not start a build on top of an active deploy; re-run this script later."
    } else {
      Write-Host "  All stacks reached a terminal status." -ForegroundColor Green
    }
  }

  # Re-evaluate (using whatever the latest poll returned) now that nothing
  # is *_IN_PROGRESS - a stack that settled into a failure/rollback terminal
  # status is a real problem to surface, not something to silently retry.
  $failedStacks = $matchingStacks | Where-Object { $failureTerminalStatuses -contains $_.StackStatus }
  foreach ($fs in $failedStacks) {
    Write-Host ("    [NOTE] " + $fs.StackName + " is in " + $fs.StackStatus + ".") -ForegroundColor Yellow
    if ($fs.StackStatus -eq "ROLLBACK_COMPLETE") {
      Write-Host "      The next 'ampx pipeline-deploy' (triggered by start-job below) deletes and recreates a" -ForegroundColor Yellow
      Write-Host "      ROLLBACK_COMPLETE stack automatically as part of a normal CDK deploy - this script does not" -ForegroundColor Yellow
      Write-Host "      call cloudformation delete-stack itself, and never deletes bello/zaico-api-token (it is not" -ForegroundColor Yellow
      Write-Host "      a resource inside this stack any more - see amplify/backend.ts's Secret.fromSecretNameV2)." -ForegroundColor Yellow
    } else {
      $eventsResult = Invoke-AwsCli -ArgList @("cloudformation", "describe-stack-events", "--stack-name", $fs.StackName, "--query", "StackEvents[].{LogicalResourceId:LogicalResourceId,ResourceType:ResourceType,ResourceStatus:ResourceStatus,ResourceStatusReason:ResourceStatusReason,Timestamp:Timestamp}", "--profile", $ProfileName, "--region", $Region, "--output", "json")
      if ($eventsResult.Ok) {
        $events = $eventsResult.Raw | ConvertFrom-Json
        $firstFailure = Find-FirstStackFailureEvent -Events $events
        if ($firstFailure.Found) {
          Write-Host ("      First failure: " + $firstFailure.LogicalResourceId + " (" + $firstFailure.ResourceType + ") " + $firstFailure.ResourceStatus) -ForegroundColor Red
          Write-Host ("      Reason: " + $firstFailure.ResourceStatusReason) -ForegroundColor Red
        }
      }
    }
  }
}

if ($preflightProblems.Count -gt 0) {
  Write-Section "Preflight FAILED - not starting a build"
  foreach ($p in $preflightProblems) {
    Write-Host ("  - " + $p) -ForegroundColor Red
  }
  exit 1
}
Write-Host ""
Write-Host "Preflight OK - proceeding to build." -ForegroundColor Green

# ============================================================================
# STEP 3: Build / poll / retry loop
# ============================================================================
try {
  $maxAttempts = 3
  $attempt = 0
  $finalStatus = $null
  $finalJob = $null
  $newJobId = $null
  $urlSafeBranch = $BranchName -replace "/", "-"
  $newSiteUrl = "https://" + $urlSafeBranch + "." + $StagingAppId + ".amplifyapp.com"

  while ($attempt -lt $maxAttempts) {
    $attempt++
    Write-Section ("4. Build attempt " + $attempt + " of " + $maxAttempts + " (RELEASE job)")
    $jobStartResult = Invoke-AwsCli -ArgList @("amplify", "start-job", "--app-id", $StagingAppId, "--branch-name", $BranchName, "--job-type", "RELEASE", "--profile", $ProfileName, "--region", $Region, "--output", "json")
    if (-not $jobStartResult.Ok) {
      Write-Host "start-job failed:" -ForegroundColor Red
      Write-Host $jobStartResult.Raw
      exit 1
    }
    $newJobId = ($jobStartResult.Raw | ConvertFrom-Json).jobSummary.jobId
    Write-Host ("  Build started: jobId=" + $newJobId) -ForegroundColor Green

    Write-Host "  Polling every 15s, up to ~20 minutes ..."
    $terminalStates = @("SUCCEED", "FAILED", "CANCELLED")
    $finalStatus = $null
    $finalJob = $null
    for ($i = 0; $i -lt 80; $i++) {
      Start-Sleep -Seconds 15
      $pollResult = Invoke-AwsCli -ArgList @("amplify", "get-job", "--app-id", $StagingAppId, "--branch-name", $BranchName, "--job-id", $newJobId, "--profile", $ProfileName, "--region", $Region, "--output", "json")
      if (-not $pollResult.Ok) {
        Write-Host "  get-job (poll) failed, retrying:" -ForegroundColor Yellow
        Write-Host $pollResult.Raw
        continue
      }
      $jobNow = ($pollResult.Raw | ConvertFrom-Json).job
      $status = $jobNow.summary.status
      Write-Host ("    [" + (Get-Date -Format "HH:mm:ss") + "] status=" + $status)
      if ($terminalStates -contains $status) {
        $finalStatus = $status
        $finalJob = $jobNow
        break
      }
    }

    if (-not $finalStatus) {
      Write-Host "Timed out waiting for the job to finish. Check manually:" -ForegroundColor Red
      Write-Host ("  aws amplify get-job --app-id " + $StagingAppId + " --branch-name " + $BranchName + " --job-id " + $newJobId + " --profile " + $ProfileName + " --region " + $Region)
      exit 1
    }

    if ($finalStatus -eq "SUCCEED") {
      break
    }

    if ($finalStatus -eq "FAILED") {
      Write-Section ("Build attempt " + $attempt + " FAILED - fetching readable step logs")
      $combinedLogText = ""
      $tempLogFile = Join-Path $env:TEMP ("bello-staging-build-log-attempt" + $attempt + "-" + [Guid]::NewGuid().ToString("N") + ".txt")
      $script:tempLogFiles += $tempLogFile

      foreach ($step in $finalJob.steps) {
        Write-Host ("--- step: " + $step.stepName + " status=" + $step.status + " ---") -ForegroundColor Yellow
        if ($step.logUrl) {
          try {
            $stepLogText = Get-StepLogText -LogUrl $step.logUrl
            $combinedLogText += ("`n----- " + $step.stepName + " -----`n" + $stepLogText)
            Add-Content -Path $tempLogFile -Value ("----- " + $step.stepName + " -----`n" + $stepLogText) -Encoding UTF8
          } catch {
            Write-Host ("Could not fetch/decode log for this step: " + $_.Exception.Message) -ForegroundColor Red
          }
        } else {
          Write-Host "(no logUrl for this step)"
        }
      }

      Write-Host ""
      Write-Host ("Full readable log for this attempt saved to (deleted when this script exits): " + $tempLogFile) -ForegroundColor Cyan

      $failureInfo = Find-FirstMeaningfulFailure -FullLogText $combinedLogText
      if ($failureInfo.Found) {
        Write-Section "First meaningful failure (not the generic final 'Build failed' banner)"
        Write-Host ("  Resource type    : " + $failureInfo.ResourceType) -ForegroundColor Red
        Write-Host ("  HandlerErrorCode : " + $failureInfo.HandlerErrorCode) -ForegroundColor Red
        Write-Host ("  Matched line     : " + $failureInfo.MatchedLine) -ForegroundColor Red
        Write-Host ""
        Write-Host "  Context (30 lines before, 20 lines after):" -ForegroundColor Yellow
        Write-Host $failureInfo.Context
      } else {
        Write-Host "Could not automatically identify a specific failure line - review the full log at the temp file path above." -ForegroundColor Yellow
      }

      $isIamPropagationPattern = $combinedLogText -match "Unable to assume specified IAM Role"
      if ($isIamPropagationPattern -and $attempt -lt $maxAttempts) {
        Write-Host ""
        Write-Host "  Detected the known IAM role propagation-delay pattern - waiting longer and retrying" -ForegroundColor Yellow
        Write-Host "  automatically (no user action needed)." -ForegroundColor Yellow
        Start-Sleep -Seconds 30
        continue
      } else {
        Write-Host ""
        Write-Host "Build failed for a reason other than (or persisting past retries of) IAM propagation delay. Stopping - review the failure above." -ForegroundColor Red
        exit 1
      }
    }

    # CANCELLED or any other terminal state that isn't SUCCEED/FAILED
    Write-Host ("Build ended with status " + $finalStatus + " - stopping.") -ForegroundColor Red
    exit 1
  }

  # ============================================================================
  # STEP 4: On SUCCEED - HTTP checks and final state
  # ============================================================================
  Write-Section "5. Job SUCCEED - verifying HTTP responses and app settings"
  $pathsToCheck = @("/", "/inventory", "/inventory/login")
  $httpResults = @{}
  foreach ($path in $pathsToCheck) {
    $checkUrl = $newSiteUrl + $path
    try {
      $response = Invoke-WebRequest -Uri $checkUrl -UseBasicParsing -MaximumRedirection 0 -ErrorAction Stop
      $httpResults[$path] = [int]$response.StatusCode
      Write-Host ("  " + $path + " -> HTTP " + $httpResults[$path]) -ForegroundColor Green
    } catch {
      if ($_.Exception.Response) {
        $statusCode = [int]$_.Exception.Response.StatusCode
        $httpResults[$path] = $statusCode
        $isOk = ($statusCode -ge 200 -and $statusCode -lt 400)
        Write-Host ("  " + $path + " -> HTTP " + $statusCode) -ForegroundColor $(if ($isOk) { "Green" } else { "Red" })
        if ($statusCode -eq 302 -or $statusCode -eq 301 -or $statusCode -eq 307) {
          $locationHeader = $_.Exception.Response.Headers["Location"]
          Write-Host ("    Redirect location: " + $locationHeader)
        }
      } else {
        $httpResults[$path] = -1
        Write-Host ("  " + $path + " -> request failed without an HTTP response: " + $_.Exception.Message) -ForegroundColor Red
      }
    }
  }

  $finalAppResult = Invoke-AwsCli -ArgList @("amplify", "get-app", "--app-id", $StagingAppId, "--profile", $ProfileName, "--region", $Region, "--output", "json")
  $finalPlatform = "(unknown)"
  if ($finalAppResult.Ok) {
    $finalPlatform = ($finalAppResult.Raw | ConvertFrom-Json).app.platform
  }
  $finalBranchResult = Invoke-AwsCli -ArgList @("amplify", "get-branch", "--app-id", $StagingAppId, "--branch-name", $BranchName, "--profile", $ProfileName, "--region", $Region, "--output", "json")
  $finalFramework = "(unknown)"
  if ($finalBranchResult.Ok) {
    $finalFramework = ($finalBranchResult.Raw | ConvertFrom-Json).branch.framework
  }

  Write-Section "Summary"
  Write-Host ("Staging app ID    : " + $StagingAppId)
  Write-Host ("Build attempts    : " + $attempt + " of " + $maxAttempts)
  Write-Host ("Final job ID      : " + $newJobId)
  Write-Host ("Final job status  : " + $finalStatus)
  Write-Host ("Staging URL       : " + $newSiteUrl)
  foreach ($path in $pathsToCheck) {
    Write-Host ("  HTTP " + $path.PadRight(20) + ": " + $httpResults[$path])
  }
  Write-Host ("Platform          : " + $finalPlatform)
  Write-Host ("Branch framework  : " + $finalFramework)
  Write-Host ("Existing app " + $ExistingProductionAppId + " (production): NOT modified.") -ForegroundColor Green
  Write-Host ("Existing role " + $ExistingBackendRoleName + " (production): NOT modified.") -ForegroundColor Green
  Write-Host "main branch: NOT touched." -ForegroundColor Green
  Write-Host ""
  Write-Host "NOTE: HTTP-level checks confirm hosting/routing/SSR responds correctly. They do NOT by" -ForegroundColor Yellow
  Write-Host "themselves prove an authenticated session can read/write Cognito/AppSync/S3 data - that" -ForegroundColor Yellow
  Write-Host "needs an actual login. Next step (separate, later): configure the SSR runtime's Secrets" -ForegroundColor Cyan
  Write-Host "Manager compute role (different role from this backend deployment role) via" -ForegroundColor Cyan
  Write-Host "2-apply-secrets-policy.ps1, then log in on the staging URL to verify Cognito/AppSync/S3." -ForegroundColor Cyan
} finally {
  Remove-TempLogFiles
}
