<#
.SYNOPSIS
  Idempotent BELLO staging Amplify deployment runner. Re-run this same
  script any number of times, in any state - it detects what AWS
  already has and continues from there, never redoing settled work and
  never touching production. Kept at this filename for backward
  compatibility (this is what earlier rounds called an "IAM fix
  script" - it has been redesigned into the general deployment
  runner; see .DESCRIPTION).

.DESCRIPTION
  Design goal (this is a rewrite, not another patch on top of the
  previous version): running this script should always be safe and
  should always make forward progress from wherever AWS's real state
  currently is, whether that is "nothing done yet", "a build is
  already running", "a build just failed", or "everything already
  succeeded". No state is ever re-created, re-started, or re-confirmed
  once it is already correct - each state below checks before it acts.

  Fixed real-world facts this script is built from (do not treat as a
  guess - repository, account, staging/production app IDs, region,
  role names, and the ZAICO secret name/ARN are exactly as configured
  below and as confirmed in prior runs):
    Staging app   : d4hkkg7dty2du (bello-inventory-staging), us-west-2
    Staging branch: claude/inventory-management-system-5vbvc7
    Production app: d1uy61lbnqm8ae (main) - NEVER modified by this script
    ZAICO secret  : bello/zaico-api-token
                    arn:aws:secretsmanager:us-west-2:203918843421:secret:bello/zaico-api-token-6B6S6P

  ---- State machine (fixed order, each step below is one function) ----
    STATE 1  AWS_AUTH                    - Test-AwsAuth
    STATE 2  ENVIRONMENT_VALIDATE        - Test-StagingEnvironment
    STATE 3  IAM_VALIDATE                - Test-StagingIamRole (+ repair)
    STATE 4  SECRET_VALIDATE             - Test-ZaicoSecret
    STATE 5  CLOUDFORMATION_STABILIZE    - Wait-CloudFormationStable
    STATE 6  AMPLIFY_JOB_DISCOVER        - Get-ActiveAmplifyJob
    STATE 7  AMPLIFY_JOB_ATTACH_OR_START - attach existing job, or start
                                           one only after a second,
                                           immediately-before-start
                                           recheck (TOCTOU-safe), with
                                           LimitExceededException treated
                                           as a race to recover from, not
                                           a failure
    STATE 8  AMPLIFY_JOB_POLL            - Wait-AmplifyJob
    STATE 9  AMPLIFY_STEP_VALIDATE       - BUILD/DEPLOY/VERIFY checked
                                           individually - all three must
                                           be SUCCEED, not just the
                                           overall job status
    STATE 10 FAILURE_DIAGNOSE            - readable log decode + first
             or HTTP_VALIDATE              meaningful failure, OR (on
                                           full success) HTTP checks
                                           against a URL built from
                                           get-app's own defaultDomain
                                           field, never hardcoded
    STATE 11 BACKEND_RESOURCE_VALIDATE   - read-only Cognito/AppSync/
                                           DynamoDB/S3 presence checks,
                                           plus the SSR Compute Role
                                           (separate from the backend
                                           deployment role) is validated/
                                           configured here too
    STATE 12 COMPLETE                    - final report; only reports
                                           success if every hard gate
                                           above actually passed

  Root cause history this design is meant to end (see
  docs/aws-test-environment.md sections 8-11 for the individual
  incidents): platform/framework mismatch, GitHub PAT input capture,
  IAM trust policy scoping, a CDK-owned vs external Secret conflict, a
  console encoding crash misread as "secret not found", and finally a
  LimitExceededException from starting a job without checking for an
  already-running one first. Each of those was fixed one at a time in
  earlier commits; this rewrite's job is to make the whole run
  idempotent so a NEW failure mode (which will eventually happen -
  AWS/CDK/npm are moving targets) can be re-run against without
  repeating any already-completed work or clobbering good state.

  ---- Safety invariants (unchanged from every previous version) ----
  - $ExistingProductionAppId (d1uy61lbnqm8ae) and $ExistingBackendRoleName
    (BelloAmplifyBackendDeploymentRole) are read-only references. Any
    AWS CLI call classified as "mutating" (see $MutatingAwsSubcommands)
    is refused by Invoke-AwsCli if either identifier appears in its
    arguments - this is enforced at the single call site every AWS CLI
    invocation in this script goes through, not per-caller.
  - Secret VALUE (SecretString/SecretBinary) is never requested, never
    logged, never displayed - every secretsmanager call in this script
    uses --query to fetch ARN/Name only.
  - Presigned build-log URLs are fetched but never printed.
  - No interactive prompts in the normal path (per the explicit
    instruction that repeated "yes/skip/continue" prompts are exactly
    the friction this rewrite exists to remove). The one exception is
    BLOCKED_BY_USER for an expired/wrong AWS SSO session, which prints
    exactly one command and stops - because that is the one thing only
    the user's own browser session can do.

  This script is plain ASCII on purpose - see 1-discover.ps1's header
  comment for why (Windows PowerShell 5.1 + non-ASCII text without a
  BOM can corrupt string literals and produce ParserError).

.PARAMETER StagingAppId
  Default: d4hkkg7dty2du.

.PARAMETER StagingAppName
  Default: bello-inventory-staging (validated, not used for lookup).

.PARAMETER BranchName
  Default: claude/inventory-management-system-5vbvc7. Refuses to run
  if this is "main".

.PARAMETER Region
  Default: us-west-2.

.PARAMETER ProfileName
  Default: Bello.

.PARAMETER ExistingBackendRoleName
  The PRODUCTION backend deployment role - read-only reference used
  only to learn what permissions to replicate if the staging role ever
  needs (re)creating. Default: BelloAmplifyBackendDeploymentRole.

.PARAMETER NewStagingRoleName
  The staging-only backend deployment role. Default:
  BelloAmplifyStagingBackendDeploymentRole.

.PARAMETER StagingComputeRoleName
  The staging-only SSR Hosting Compute role (distinct from the backend
  deployment role - see STATE 11). Default: BelloAmplifyStagingComputeRole.

.PARAMETER SecretName
  Default: bello/zaico-api-token.

.PARAMETER CfnStabilizeMaxMinutes
  Max time to wait in STATE 5 for CloudFormation stacks to reach a
  terminal status before giving up. Default: 25.

.PARAMETER JobPollMaxMinutes
  Max time to wait in STATE 8 for the Amplify job to reach a terminal
  status. Default: 30.

.PARAMETER Force
  Deprecated / no-op, kept only so an old invocation with -Force does
  not error out. This runner no longer has any interactive prompt to
  skip in the normal path.

.EXAMPLE
  .\7-fix-staging-iam-role.ps1
#>
param(
  [string]$StagingAppId = "d4hkkg7dty2du",
  [string]$StagingAppName = "bello-inventory-staging",
  [string]$BranchName = "claude/inventory-management-system-5vbvc7",
  [string]$Region = "us-west-2",
  [string]$ProfileName = "Bello",
  [string]$ExistingBackendRoleName = "BelloAmplifyBackendDeploymentRole",
  [string]$NewStagingRoleName = "BelloAmplifyStagingBackendDeploymentRole",
  [string]$StagingComputeRoleName = "BelloAmplifyStagingComputeRole",
  [string]$SecretName = "bello/zaico-api-token",
  [int]$CfnStabilizeMaxMinutes = 25,
  [int]$JobPollMaxMinutes = 30,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

# ---- Fixed identifiers - see header comment. Never accepted as parameters
# for anything that could target them mutably. ----------------------------
$ExistingProductionAppId = "d1uy61lbnqm8ae"
$ExpectedAccountId = "203918843421"

# AWS CLI subcommands this script treats as mutating - Invoke-AwsCli refuses
# any call in this list whose arguments contain the production app ID or
# the production role name, regardless of which function issued it. Purely
# read-only calls (get-role, list-attached-role-policies, get-app, etc.)
# against the production app/role are allowed and expected - that is how
# this script learns what to replicate without ever touching them.
$MutatingAwsSubcommands = @(
  "update-app", "delete-app", "update-branch", "delete-branch",
  "start-job", "stop-job", "create-branch", "delete-stack",
  "update-role", "delete-role", "put-role-policy", "attach-role-policy",
  "detach-role-policy", "create-role", "update-assume-role-policy",
  "put-secret-value", "create-secret", "delete-secret", "tag-role", "untag-role"
)

$script:tempLogFiles = @()

function Write-Section {
  param([string]$Title)
  Write-Host ""
  Write-Host ("---- " + $Title + " ----") -ForegroundColor Cyan
}

function Write-StateBanner {
  param([string]$Name)
  Write-Host ""
  Write-Host ("======== " + $Name + " ========") -ForegroundColor Magenta
}

function Remove-TempLogFiles {
  foreach ($f in $script:tempLogFiles) {
    Remove-Item -Force -ErrorAction SilentlyContinue $f
  }
  $script:tempLogFiles = @()
}

function Stop-Runner {
  param([int]$Code = 1)
  Remove-TempLogFiles
  exit $Code
}

function Show-BlockedByUser {
  # The ONLY interactive stop in this script - an AWS SSO session only the
  # user's own browser can renew. Exactly one command, no other guidance.
  param([string]$Reason)
  Write-Host ""
  Write-Host "BLOCKED_BY_USER" -ForegroundColor Red
  Write-Host ("Reason: " + $Reason) -ForegroundColor Red
  Write-Host ""
  Write-Host ("aws sso login --profile " + $ProfileName) -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Re-run this same script after that command succeeds - it will pick up exactly where it left off."
  Stop-Runner -Code 2
}

# ============================================================================
# Log decoding - fixes the real "68 101 112 ..." decimal-byte-list bug seen
# in earlier runs (Invoke-WebRequest -UseBasicParsing in Windows PowerShell
# 5.1 returns .Content as byte[] for many presigned log URLs).
# ============================================================================
function ConvertTo-DecodedLogText {
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

function Test-LogDecoder {
  # Runs for real, every time this script starts - a broken decoder would
  # otherwise show up only when a build actually fails, which is exactly
  # the moment readable diagnostics matter most. Not a "wrote code, assume
  # it works" check: this actually calls ConvertTo-DecodedLogText three
  # times with real byte[] input (including gzip) and compares output.
  $failures = @()

  $t1Text = "plain ascii build log line"
  $t1Bytes = [System.Text.Encoding]::UTF8.GetBytes($t1Text)
  $t1Decoded = ConvertTo-DecodedLogText -RawContent $t1Bytes
  if ($t1Decoded -ne $t1Text) { $failures += "Test1 (ASCII byte[]) mismatch" }

  $t2Text = "build failed: could not find secret [ZAICO API TOKEN test]"
  $t2Bytes = [System.Text.Encoding]::UTF8.GetBytes($t2Text)
  $t2Decoded = ConvertTo-DecodedLogText -RawContent $t2Bytes
  if ($t2Decoded -ne $t2Text) { $failures += "Test2 (UTF8 byte[] with bracketed text) mismatch" }

  $t3Text = "gzip roundtrip check line"
  $t3PlainBytes = [System.Text.Encoding]::UTF8.GetBytes($t3Text)
  $t3Ms = New-Object System.IO.MemoryStream
  $t3Gz = New-Object System.IO.Compression.GZipStream($t3Ms, [System.IO.Compression.CompressionMode]::Compress, $true)
  $t3Gz.Write($t3PlainBytes, 0, $t3PlainBytes.Length)
  $t3Gz.Dispose()
  $t3GzipBytes = $t3Ms.ToArray()
  $t3Ms.Dispose()
  $t3Decoded = ConvertTo-DecodedLogText -RawContent $t3GzipBytes
  if ($t3Decoded -ne $t3Text) { $failures += "Test3 (gzip byte[]) mismatch" }

  if ($failures.Count -gt 0) {
    Write-Host "[SELF-TEST FAILED] ConvertTo-DecodedLogText:" -ForegroundColor Red
    foreach ($f in $failures) { Write-Host ("  - " + $f) -ForegroundColor Red }
    return $false
  }
  Write-Host "Log decoder self-test: 3/3 passed (ASCII byte[], UTF8 byte[], gzip byte[])." -ForegroundColor Green
  return $true
}

function Get-StepLogText {
  # The URL itself is never printed - it is a presigned, time-limited URL
  # that grants access on its own.
  param([string]$LogUrl)
  $response = Invoke-WebRequest -Uri $LogUrl -UseBasicParsing
  return ConvertTo-DecodedLogText -RawContent $response.Content
}

function Find-FirstMeaningfulFailure {
  # Scans TOP-DOWN for the FIRST line matching a real failure marker.
  # Deliberately EXCLUDED from the marker list: "Build failed", "Command
  # failed with exit code", the Amplify SSR-framework troubleshooting URL,
  # and bare "NoStack" - these are generic/secondary and were misreported
  # as root causes in earlier rounds. NoStack in particular is a known
  # secondary artifact of a CloudFormation rollback, not a cause on its own.
  param([string]$FullLogText)
  $lines = $FullLogText -split "`r?`n"
  $markers = @(
    "CREATE_FAILED", "UPDATE_FAILED", "DELETE_FAILED",
    "HandlerErrorCode",
    "\[ERROR\]",
    "AlreadyExists",
    "AccessDenied",
    "ResourceNotFoundException",
    "ValidationException",
    "MalformedPolicyDocument",
    "LimitExceededException",
    "BootstrapDetectionError",
    "Unable to assume specified IAM Role",
    "TypeError",
    "Module not found",
    "Failed to compile",
    "npm ERR",
    "Command failed with exit code [1-9]"
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
  # Root cause of a real false negative this classifier exists to prevent:
  # describe-secret found the secret, then AWS CLI crashed trying to print
  # its Description (containing U+2014) on a cp932 Windows console. The
  # non-zero exit code from THAT crash was misread as "secret not found" by
  # an earlier version of this script. Only a real ResourceNotFoundException
  # means "not found" - everything else here is a distinct, separately
  # reported problem.
  param([string]$RawText)
  if ($RawText -match "ResourceNotFoundException") { return "not-found" }
  if ($RawText -match "AccessDenied") { return "access-denied" }
  if ($RawText -match "CredentialsProviderError|could not load credentials|ExpiredToken|InvalidClientTokenId|UnrecognizedClientException|The security token included in the request is expired") { return "credentials" }
  if ($RawText -match "codec can't encode|UnicodeEncodeError|illegal multibyte sequence|UnicodeDecodeError") { return "encoding" }
  if ($RawText -match "LimitExceededException") { return "limit-exceeded" }
  return "other"
}

function Find-FirstStackFailureEvent {
  # CloudFormation returns stack events newest-first; reverse to
  # oldest-first so "first" here means chronologically first, i.e. root
  # cause, not just the last event in the raw API response.
  param([array]$Events)
  $chronological = @($Events)
  [array]::Reverse($chronological)
  foreach ($ev in $chronological) {
    if ($ev.ResourceStatus -match "_FAILED$") {
      return @{
        Found                = $true
        LogicalResourceId    = $ev.LogicalResourceId
        ResourceType         = $ev.ResourceType
        ResourceStatus       = $ev.ResourceStatus
        ResourceStatusReason = $ev.ResourceStatusReason
        Timestamp            = $ev.Timestamp
      }
    }
  }
  return @{ Found = $false }
}

function New-TempJsonFile {
  # See docs/aws-test-environment.md section 9e for the MalformedPolicyDocument
  # incident this exists to prevent - a JSON policy document passed directly
  # as a Windows native-process command-line argument can be mangled in
  # transit (CommandLineToArgvW re-quoting). Round-trips through
  # ConvertFrom-Json before writing (catches a malformed object immediately)
  # and writes UTF-8 WITHOUT a BOM ([System.IO.File]::WriteAllText with an
  # explicit UTF8Encoding($false) - Windows PowerShell 5.1's -Encoding utf8
  # adds a BOM, which is also not guaranteed safe for aws.exe to parse).
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

function Invoke-AwsCli {
  param([string[]]$ArgList)
  $subcommand = $(if ($ArgList.Count -ge 2) { $ArgList[1] } else { "" })
  if ($MutatingAwsSubcommands -contains $subcommand) {
    if ($ArgList -contains $ExistingProductionAppId) {
      Write-Host "[SAFETY ABORT] Refusing a mutating AWS CLI call that references the existing production app ID." -ForegroundColor Red
      Stop-Runner
    }
    if ($ArgList -contains $ExistingBackendRoleName) {
      Write-Host "[SAFETY ABORT] Refusing a mutating AWS CLI call that references the existing production IAM role." -ForegroundColor Red
      Stop-Runner
    }
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

# ============================================================================
# STATE 1: AWS_AUTH
# ============================================================================
function Test-AwsAuth {
  Write-StateBanner "STATE 1: AWS_AUTH"
  $identityResult = Invoke-AwsCli -ArgList @("sts", "get-caller-identity", "--profile", $ProfileName, "--region", $Region, "--output", "json")
  if (-not $identityResult.Ok) {
    $kind = Get-AwsErrorKind -RawText $identityResult.Raw
    if ($kind -eq "credentials") {
      Show-BlockedByUser -Reason "AWS SSO session for profile '$ProfileName' is expired or not logged in."
    }
    Write-Host "Could not get AWS identity for an unrecognized reason:" -ForegroundColor Red
    Write-Host $identityResult.Raw
    Stop-Runner
  }
  $identity = $identityResult.Raw | ConvertFrom-Json
  Write-Host ("Identity: " + $identity.Arn)
  if ($identity.Arn -match ":root$") {
    Write-Host "Do not run this with root credentials." -ForegroundColor Red
    Stop-Runner
  }
  if ($identity.Account -ne $ExpectedAccountId) {
    Write-Host ("Wrong AWS account: got " + $identity.Account + ", expected " + $ExpectedAccountId + ". Stopping.") -ForegroundColor Red
    Stop-Runner
  }
  Write-Host ("Account: " + $identity.Account + " - OK") -ForegroundColor Green
  return $identity
}

# ============================================================================
# STATE 2: ENVIRONMENT_VALIDATE
# ============================================================================
function Test-StagingEnvironment {
  Write-StateBanner "STATE 2: ENVIRONMENT_VALIDATE"
  if ($BranchName -eq "main") {
    Write-Host "Refusing to use 'main' as the staging branch name. Stopping." -ForegroundColor Red
    Stop-Runner
  }
  if ($StagingAppId -eq $ExistingProductionAppId) {
    Write-Host "[SAFETY ABORT] -StagingAppId must not be the existing production app ID." -ForegroundColor Red
    Stop-Runner
  }
  if ($NewStagingRoleName -eq $ExistingBackendRoleName) {
    Write-Host "[SAFETY ABORT] The staging role name must differ from the production role name." -ForegroundColor Red
    Stop-Runner
  }

  $appResult = Invoke-AwsCli -ArgList @("amplify", "get-app", "--app-id", $StagingAppId, "--profile", $ProfileName, "--region", $Region, "--output", "json")
  if (-not $appResult.Ok) {
    Write-Host "get-app failed:" -ForegroundColor Red
    Write-Host $appResult.Raw
    Stop-Runner
  }
  $app = ($appResult.Raw | ConvertFrom-Json).app
  Write-Host ("App name          : " + $app.name)
  Write-Host ("Platform          : " + $app.platform)
  Write-Host ("defaultDomain     : " + $app.defaultDomain)
  Write-Host ("iamServiceRoleArn : " + $(if ($app.iamServiceRoleArn) { $app.iamServiceRoleArn } else { "(none)" }))

  $problems = @()
  if ($app.name -ne $StagingAppName) { $problems += "App name is '" + $app.name + "', expected '" + $StagingAppName + "'." }
  if ($app.platform -ne "WEB_COMPUTE") { $problems += "Platform is '" + $app.platform + "', expected WEB_COMPUTE." }

  $branchResult = Invoke-AwsCli -ArgList @("amplify", "get-branch", "--app-id", $StagingAppId, "--branch-name", $BranchName, "--profile", $ProfileName, "--region", $Region, "--output", "json")
  if (-not $branchResult.Ok) {
    Write-Host "get-branch failed:" -ForegroundColor Red
    Write-Host $branchResult.Raw
    Stop-Runner
  }
  $branch = ($branchResult.Raw | ConvertFrom-Json).branch
  Write-Host ("Branch framework  : " + $(if ($branch.framework) { $branch.framework } else { "(null)" }))
  if ($branch.framework -ne "Next.js - SSR") { $problems += "Branch framework is '" + $branch.framework + "', expected 'Next.js - SSR'." }

  $branchesResult = Invoke-AwsCli -ArgList @("amplify", "list-branches", "--app-id", $StagingAppId, "--profile", $ProfileName, "--region", $Region, "--output", "json")
  if ($branchesResult.Ok) {
    $branches = ($branchesResult.Raw | ConvertFrom-Json).branches
    $hasMain = $branches | Where-Object { $_.branchName -eq "main" }
    $unexpectedBranches = $branches | Where-Object { $_.branchName -ne $BranchName }
    if ($hasMain) {
      $problems += "This staging app unexpectedly has a 'main' branch connected - refusing to proceed."
    } elseif ($unexpectedBranches) {
      $problems += "Staging app has a branch other than '" + $BranchName + "'."
    } else {
      Write-Host ("Branches on app   : only '" + $BranchName + "' - OK") -ForegroundColor Green
    }
  } else {
    $problems += "Could not list branches to confirm no 'main' branch is present."
  }

  if ($problems.Count -gt 0) {
    Write-Host ""
    Write-Host "ENVIRONMENT_VALIDATE failed:" -ForegroundColor Red
    foreach ($p in $problems) { Write-Host ("  - " + $p) -ForegroundColor Red }
    Stop-Runner
  }
  Write-Host "Environment matches expected staging configuration - OK" -ForegroundColor Green
  return @{ App = $app; Branch = $branch }
}

# ============================================================================
# STATE 3: IAM_VALIDATE (repairs only when actually needed - no prompt)
# ============================================================================
function Test-StagingIamRole {
  param($App, [string]$AccountId)
  Write-StateBanner "STATE 3: IAM_VALIDATE"

  $roleResult = Invoke-AwsCli -ArgList @("iam", "get-role", "--role-name", $NewStagingRoleName, "--profile", $ProfileName, "--region", $Region, "--output", "json")
  $needsRoleCreate = -not $roleResult.Ok
  $needsTrustFix = $false
  $roleArn = $null

  if (-not $needsRoleCreate) {
    $role = ($roleResult.Raw | ConvertFrom-Json).Role
    $roleArn = $role.Arn
    $trustJson = $role.AssumeRolePolicyDocument | ConvertTo-Json -Depth 10 -Compress
    $scopedToStaging = $trustJson -match [regex]::Escape($StagingAppId)
    $mentionsProduction = $trustJson -match [regex]::Escape($ExistingProductionAppId)
    if (-not $scopedToStaging -or $mentionsProduction) {
      $needsTrustFix = $true
    }
  }

  $needsAppLinkFix = $false
  if (-not $needsRoleCreate -and -not $needsTrustFix) {
    if ($App.iamServiceRoleArn -ne $roleArn) { $needsAppLinkFix = $true }
  }

  if (-not $needsRoleCreate -and -not $needsTrustFix -and -not $needsAppLinkFix) {
    Write-Host "IAM already configured - OK" -ForegroundColor Green
    Write-Host ("  Role: " + $roleArn)
    return $roleArn
  }

  Write-Host "IAM needs repair - proceeding automatically (scoped to the staging role/app only, never production):" -ForegroundColor Yellow
  if ($needsRoleCreate) { Write-Host "  - staging role does not exist yet, will create it" }
  if ($needsTrustFix) { Write-Host "  - trust policy is missing/wrong, will update it" }
  if ($needsAppLinkFix) { Write-Host "  - app's iamServiceRoleArn does not point at the staging role, will fix" }

  # Read (never modify) the production role's policies, purely to learn
  # what permissions to replicate onto the staging role.
  $managedPolicyArns = @()
  $inlinePolicies = @{}
  $attachedResult = Invoke-AwsCli -ArgList @("iam", "list-attached-role-policies", "--role-name", $ExistingBackendRoleName, "--profile", $ProfileName, "--region", $Region, "--output", "json")
  if ($attachedResult.Ok) {
    foreach ($p in ($attachedResult.Raw | ConvertFrom-Json).AttachedPolicies) { $managedPolicyArns += $p.PolicyArn }
  }
  $inlineListResult = Invoke-AwsCli -ArgList @("iam", "list-role-policies", "--role-name", $ExistingBackendRoleName, "--profile", $ProfileName, "--region", $Region, "--output", "json")
  if ($inlineListResult.Ok) {
    foreach ($name in ($inlineListResult.Raw | ConvertFrom-Json).PolicyNames) {
      $getPolicyResult = Invoke-AwsCli -ArgList @("iam", "get-role-policy", "--role-name", $ExistingBackendRoleName, "--policy-name", $name, "--profile", $ProfileName, "--region", $Region, "--output", "json")
      if ($getPolicyResult.Ok) { $inlinePolicies[$name] = ($getPolicyResult.Raw | ConvertFrom-Json).PolicyDocument }
    }
  }

  $stagingAppArn = "arn:aws:amplify:" + $Region + ":" + $AccountId + ":apps/" + $StagingAppId + "/branches/*"
  $trustPolicyObj = @{
    Version   = "2012-10-17"
    Statement = @(
      @{
        Effect    = "Allow"
        Principal = @{ Service = @("amplify.amazonaws.com", "amplifybackend.amazonaws.com") }
        Action    = "sts:AssumeRole"
        Condition = @{
          StringEquals = @{ "aws:SourceAccount" = $AccountId }
          ArnLike      = @{ "aws:SourceArn" = $stagingAppArn }
        }
      }
    )
  }
  $trustPolicyPath = New-TempJsonFile -Object $trustPolicyObj -Prefix "bello-staging-trust-policy"
  try {
    if ($needsRoleCreate) {
      $createRoleResult = Invoke-AwsCli -ArgList @(
        "iam", "create-role", "--role-name", $NewStagingRoleName,
        "--assume-role-policy-document", ("file://" + $trustPolicyPath),
        "--description", "Amplify backend deployment role for the dedicated staging app only - never used by production.",
        "--profile", $ProfileName, "--region", $Region, "--output", "json"
      )
      if (-not $createRoleResult.Ok) {
        Write-Host "create-role failed:" -ForegroundColor Red
        Write-Host $createRoleResult.Raw
        Stop-Runner
      }
      $roleArn = ($createRoleResult.Raw | ConvertFrom-Json).Role.Arn
      foreach ($arn in $managedPolicyArns) {
        $attachResult = Invoke-AwsCli -ArgList @("iam", "attach-role-policy", "--role-name", $NewStagingRoleName, "--policy-arn", $arn, "--profile", $ProfileName, "--region", $Region)
        if (-not $attachResult.Ok) { Write-Host ("Failed to attach " + $arn + ":") -ForegroundColor Red; Write-Host $attachResult.Raw; Stop-Runner }
      }
      foreach ($name in $inlinePolicies.Keys) {
        $inlinePath = New-TempJsonFile -Object $inlinePolicies[$name] -Prefix "bello-staging-inline-policy"
        try {
          $putResult = Invoke-AwsCli -ArgList @("iam", "put-role-policy", "--role-name", $NewStagingRoleName, "--policy-name", $name, "--policy-document", ("file://" + $inlinePath), "--profile", $ProfileName, "--region", $Region)
          if (-not $putResult.Ok) { Write-Host ("Failed to copy inline policy " + $name + ":") -ForegroundColor Red; Write-Host $putResult.Raw; Stop-Runner }
        } finally {
          Remove-Item -Force -ErrorAction SilentlyContinue $inlinePath
        }
      }
      Write-Host ("Created staging role: " + $roleArn) -ForegroundColor Green
    } elseif ($needsTrustFix) {
      $updateTrustResult = Invoke-AwsCli -ArgList @("iam", "update-assume-role-policy", "--role-name", $NewStagingRoleName, "--policy-document", ("file://" + $trustPolicyPath), "--profile", $ProfileName, "--region", $Region)
      if (-not $updateTrustResult.Ok) {
        Write-Host "update-assume-role-policy failed:" -ForegroundColor Red
        Write-Host $updateTrustResult.Raw
        Stop-Runner
      }
      Write-Host "Trust policy corrected." -ForegroundColor Green
    }
  } finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $trustPolicyPath
  }

  if ($needsAppLinkFix -or $needsRoleCreate) {
    $updateAppResult = Invoke-AwsCli -ArgList @("amplify", "update-app", "--app-id", $StagingAppId, "--iam-service-role-arn", $roleArn, "--profile", $ProfileName, "--region", $Region, "--output", "json")
    if (-not $updateAppResult.Ok) {
      Write-Host "update-app (iamServiceRoleArn) failed:" -ForegroundColor Red
      Write-Host $updateAppResult.Raw
      Stop-Runner
    }
    Write-Host "Staging app's iamServiceRoleArn now points at the staging role." -ForegroundColor Green
  }

  return $roleArn
}

# ============================================================================
# STATE 4: SECRET_VALIDATE
# ============================================================================
function Test-ZaicoSecret {
  Write-StateBanner "STATE 4: SECRET_VALIDATE"
  Write-Host ("Checking for " + $SecretName + " (ARN/Name only via --query - Description/Tags are never")
  Write-Host "requested, since they can contain non-ASCII text that has crashed AWS CLI's own console"
  Write-Host "output encoding on Windows in the past - unrelated to whether the secret exists)."

  $describeResult = Invoke-AwsCli -ArgList @("secretsmanager", "describe-secret", "--secret-id", $SecretName, "--query", "{ARN:ARN,Name:Name}", "--profile", $ProfileName, "--region", $Region, "--output", "json")
  if ($describeResult.Ok) {
    $secretInfo = $describeResult.Raw | ConvertFrom-Json
    Write-Host ("Secret FOUND: Name=" + $secretInfo.Name) -ForegroundColor Green
    Write-Host ("  ARN   : " + $secretInfo.ARN) -ForegroundColor Green
    Write-Host ("  Region: " + $Region) -ForegroundColor Green
    return @{ Found = $true; Arn = $secretInfo.ARN }
  }

  $kind = Get-AwsErrorKind -RawText $describeResult.Raw
  switch ($kind) {
    "not-found" {
      Write-Host ("Secret genuinely NOT found in " + $Region + " (ResourceNotFoundException). This blocks the build -") -ForegroundColor Red
      Write-Host "backend.ts imports this secret by name and expects it to already exist. Run" -ForegroundColor Red
      Write-Host "8-diagnose-zaico-secret.ps1 to check other regions before doing anything else." -ForegroundColor Red
    }
    "access-denied" {
      Write-Host "AccessDenied checking the secret - a permissions problem, NOT evidence it is missing:" -ForegroundColor Red
      Write-Host $describeResult.Raw
    }
    "credentials" {
      Show-BlockedByUser -Reason "AWS credentials expired while checking the secret."
    }
    "encoding" {
      Write-Host "[UNEXPECTED] Encoding-class error even with the minimal --query - investigate the console" -ForegroundColor Red
      Write-Host "codepage. Not evidence the secret is missing:" -ForegroundColor Red
      Write-Host $describeResult.Raw
    }
    default {
      Write-Host "Could not check the secret for an unclassified reason - NOT evidence it is missing:" -ForegroundColor Red
      Write-Host $describeResult.Raw
    }
  }
  Stop-Runner
}

# ============================================================================
# STATE 5: CLOUDFORMATION_STABILIZE
# ============================================================================
function Get-StagingStacks {
  $result = Invoke-AwsCli -ArgList @("cloudformation", "describe-stacks", "--query", "Stacks[].{StackName:StackName,StackStatus:StackStatus}", "--profile", $ProfileName, "--region", $Region, "--output", "json")
  if (-not $result.Ok) { return $null }
  $all = $result.Raw | ConvertFrom-Json
  return @($all | Where-Object { $_.StackName -match [regex]::Escape($StagingAppId) })
}

function Wait-CloudFormationStable {
  Write-StateBanner "STATE 5: CLOUDFORMATION_STABILIZE"
  $failureTerminalStatuses = @("ROLLBACK_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "CREATE_FAILED", "ROLLBACK_FAILED", "UPDATE_ROLLBACK_FAILED", "UPDATE_FAILED", "DELETE_FAILED", "IMPORT_ROLLBACK_COMPLETE", "IMPORT_ROLLBACK_FAILED")
  $selfHealingStatuses = @("ROLLBACK_COMPLETE", "IMPORT_ROLLBACK_COMPLETE")

  $stacks = Get-StagingStacks
  if ($null -eq $stacks) {
    Write-Host "Could not list CloudFormation stacks (non-fatal, continuing to job discovery)." -ForegroundColor Yellow
    return
  }
  if ($stacks.Count -eq 0) {
    Write-Host "No CloudFormation stacks matching this app yet (expected before any successful deploy)." -ForegroundColor Yellow
    return
  }
  foreach ($s in $stacks) { Write-Host ("  " + $s.StackName + " : " + $s.StackStatus) }

  $inProgress = $stacks | Where-Object { $_.StackStatus -match "_IN_PROGRESS$" }
  if ($inProgress) {
    Write-Host ""
    Write-Host "A previous deploy is still active - waiting for a terminal status (every 20s, up to ~" -ForegroundColor Yellow
    Write-Host ($CfnStabilizeMaxMinutes.ToString() + " minutes) before considering any Amplify job. Read-only wait, no delete-stack.") -ForegroundColor Yellow
    $maxIterations = [Math]::Ceiling(($CfnStabilizeMaxMinutes * 60) / 20)
    for ($w = 0; $w -lt $maxIterations; $w++) {
      Start-Sleep -Seconds 20
      $stacks = Get-StagingStacks
      $stillInProgress = $stacks | Where-Object { $_.StackStatus -match "_IN_PROGRESS$" }
      $statusLine = ($stacks | ForEach-Object { $_.StackName + "=" + $_.StackStatus }) -join "; "
      Write-Host ("  [" + (Get-Date -Format "HH:mm:ss") + "] " + $statusLine)
      if (-not $stillInProgress) { break }
    }
    if ($stacks | Where-Object { $_.StackStatus -match "_IN_PROGRESS$" }) {
      Write-Host ("Stacks are still *_IN_PROGRESS after " + $CfnStabilizeMaxMinutes + " minutes - not starting a build. Re-run this script later.") -ForegroundColor Red
      Stop-Runner
    }
    Write-Host "All stacks reached a terminal status." -ForegroundColor Green
  }

  $hardFailures = $stacks | Where-Object { ($failureTerminalStatuses -contains $_.StackStatus) -and ($selfHealingStatuses -notcontains $_.StackStatus) }
  $selfHealing = $stacks | Where-Object { $selfHealingStatuses -contains $_.StackStatus }

  foreach ($sh in $selfHealing) {
    Write-Host ("  [NOTE] " + $sh.StackName + " is " + $sh.StackStatus + " - the next Amplify job (ampx pipeline-deploy / CDK") -ForegroundColor Yellow
    Write-Host "  deploy) cleans this up automatically. Not calling delete-stack here, and bello/zaico-api-token" -ForegroundColor Yellow
    Write-Host "  is never at risk either way (it is an imported reference, not a resource in this stack)." -ForegroundColor Yellow
  }

  if ($hardFailures) {
    Write-Host ""
    Write-Host "CloudFormation stack(s) settled into a real failure state (not a self-healing rollback):" -ForegroundColor Red
    foreach ($fs in $hardFailures) {
      Write-Host ("  " + $fs.StackName + " : " + $fs.StackStatus) -ForegroundColor Red
      $eventsResult = Invoke-AwsCli -ArgList @("cloudformation", "describe-stack-events", "--stack-name", $fs.StackName, "--query", "StackEvents[].{LogicalResourceId:LogicalResourceId,ResourceType:ResourceType,ResourceStatus:ResourceStatus,ResourceStatusReason:ResourceStatusReason,Timestamp:Timestamp}", "--profile", $ProfileName, "--region", $Region, "--output", "json")
      if ($eventsResult.Ok) {
        $firstFailure = Find-FirstStackFailureEvent -Events ($eventsResult.Raw | ConvertFrom-Json)
        if ($firstFailure.Found) {
          Write-Host ("    LogicalResourceId   : " + $firstFailure.LogicalResourceId) -ForegroundColor Red
          Write-Host ("    ResourceType         : " + $firstFailure.ResourceType) -ForegroundColor Red
          Write-Host ("    ResourceStatus       : " + $firstFailure.ResourceStatus) -ForegroundColor Red
          Write-Host ("    ResourceStatusReason : " + $firstFailure.ResourceStatusReason) -ForegroundColor Red
        }
      }
    }
    Write-Host ""
    Write-Host "Not starting a build on top of a stuck stack. This needs investigation before re-running." -ForegroundColor Red
    Stop-Runner
  }
}

# ============================================================================
# STATE 6 / 7: AMPLIFY_JOB_DISCOVER, AMPLIFY_JOB_ATTACH_OR_START
# ============================================================================
function Get-ActiveAmplifyJob {
  $listResult = Invoke-AwsCli -ArgList @("amplify", "list-jobs", "--app-id", $StagingAppId, "--branch-name", $BranchName, "--profile", $ProfileName, "--region", $Region, "--output", "json")
  if (-not $listResult.Ok) { return @{ Ok = $false; Raw = $listResult.Raw } }
  $summaries = @(($listResult.Raw | ConvertFrom-Json).jobSummaries)
  $activeStatuses = @("PENDING", "PROVISIONING", "RUNNING")
  $active = @($summaries | Where-Object { $activeStatuses -contains $_.status })
  if ($active.Count -eq 0) { return @{ Ok = $true; Found = $false } }
  $sorted = @($active | Sort-Object -Property startTime -Descending)
  return @{ Ok = $true; Found = $true; Primary = $sorted[0]; All = $sorted }
}

function Invoke-AmplifyJobDiscoverAndStart {
  Write-StateBanner "STATE 6: AMPLIFY_JOB_DISCOVER"
  try {
    $gitHead = (& git rev-parse HEAD 2>$null)
    if ($gitHead) { Write-Host ("Local git HEAD (informational only - not used to reject an active job): " + $gitHead) }
  } catch {
    # git not available or not a repo checkout at this path - non-fatal, informational only.
  }

  $discovery = Get-ActiveAmplifyJob
  if (-not $discovery.Ok) {
    Write-Host "list-jobs failed:" -ForegroundColor Red
    Write-Host $discovery.Raw
    Stop-Runner
  }

  Write-StateBanner "STATE 7: AMPLIFY_JOB_ATTACH_OR_START"
  if ($discovery.Found) {
    Write-Host "Existing active Amplify job found." -ForegroundColor Green
    Write-Host ("Attaching to jobId: " + $discovery.Primary.jobId) -ForegroundColor Green
    if ($discovery.All.Count -gt 1) {
      Write-Host "Additional active jobs (left alone, not touched):"
      foreach ($j in ($discovery.All | Select-Object -Skip 1)) {
        Write-Host ("  - jobId=" + $j.jobId + " status=" + $j.status + " startTime=" + $j.startTime)
      }
    }
    return $discovery.Primary.jobId
  }

  # TOCTOU-safe recheck immediately before start-job - covers auto-build
  # having started a job between STATE 6's discovery and now.
  $recheck = Get-ActiveAmplifyJob
  if ($recheck.Ok -and $recheck.Found) {
    Write-Host "An active job appeared between discovery and start (race with auto-build or another run) -" -ForegroundColor Yellow
    Write-Host ("attaching to jobId: " + $recheck.Primary.jobId + " instead of starting a new one.") -ForegroundColor Yellow
    return $recheck.Primary.jobId
  }

  Write-Host "No active job found - starting a new RELEASE job."
  $startResult = Invoke-AwsCli -ArgList @("amplify", "start-job", "--app-id", $StagingAppId, "--branch-name", $BranchName, "--job-type", "RELEASE", "--profile", $ProfileName, "--region", $Region, "--output", "json")
  if ($startResult.Ok) {
    $jobId = ($startResult.Raw | ConvertFrom-Json).jobSummary.jobId
    Write-Host ("Started new RELEASE job: " + $jobId) -ForegroundColor Green
    return $jobId
  }

  if ($startResult.Raw -match "LimitExceededException") {
    Write-Host "start-job hit LimitExceededException (branch already has a pending/running job) - this is an" -ForegroundColor Yellow
    Write-Host "expected race, not a failure. Re-discovering and attaching, not retrying start-job." -ForegroundColor Yellow
    $raceRecover = Get-ActiveAmplifyJob
    if ($raceRecover.Ok -and $raceRecover.Found) {
      Write-Host ("Attaching to jobId: " + $raceRecover.Primary.jobId) -ForegroundColor Green
      return $raceRecover.Primary.jobId
    }
    Write-Host "start-job reported LimitExceededException but no active job is visible now - transient" -ForegroundColor Red
    Write-Host "inconsistency on AWS's side. Re-run this script." -ForegroundColor Red
    Stop-Runner
  }

  Write-Host "start-job failed for a reason other than LimitExceededException:" -ForegroundColor Red
  Write-Host $startResult.Raw
  Stop-Runner
}

# ============================================================================
# STATE 8: AMPLIFY_JOB_POLL
# ============================================================================
function Wait-AmplifyJob {
  param([string]$JobId)
  Write-StateBanner "STATE 8: AMPLIFY_JOB_POLL"
  $terminalStates = @("SUCCEED", "FAILED", "CANCELLED")
  $maxIterations = [Math]::Ceiling(($JobPollMaxMinutes * 60) / 15)
  for ($i = 0; $i -lt $maxIterations; $i++) {
    Start-Sleep -Seconds 15
    $pollResult = Invoke-AwsCli -ArgList @("amplify", "get-job", "--app-id", $StagingAppId, "--branch-name", $BranchName, "--job-id", $JobId, "--profile", $ProfileName, "--region", $Region, "--output", "json")
    if (-not $pollResult.Ok) {
      Write-Host "  get-job (poll) failed, retrying:" -ForegroundColor Yellow
      Write-Host $pollResult.Raw
      continue
    }
    $jobNow = ($pollResult.Raw | ConvertFrom-Json).job
    $status = $jobNow.summary.status
    Write-Host ("  [" + (Get-Date -Format "HH:mm:ss") + "] status=" + $status)
    if ($terminalStates -contains $status) {
      return $jobNow
    }
  }
  Write-Host ("Timed out after " + $JobPollMaxMinutes + " minutes waiting for jobId " + $JobId + ". Re-run this script - it will re-attach to this same job if it is still active, or move on if it finished.") -ForegroundColor Red
  Stop-Runner
}

# ============================================================================
# STATE 9: AMPLIFY_STEP_VALIDATE
# ============================================================================
function Test-AmplifyJobSteps {
  param($Job)
  Write-StateBanner "STATE 9: AMPLIFY_STEP_VALIDATE"
  $stepStatus = @{}
  foreach ($stepName in @("BUILD", "DEPLOY", "VERIFY")) {
    $step = $Job.steps | Where-Object { $_.stepName -eq $stepName } | Select-Object -First 1
    $stepStatus[$stepName] = $(if ($step) { $step.status } else { "(no such step)" })
    Write-Host ("  " + $stepName.PadRight(8) + ": " + $stepStatus[$stepName])
  }
  $allSucceeded = ($stepStatus["BUILD"] -eq "SUCCEED") -and ($stepStatus["DEPLOY"] -eq "SUCCEED") -and ($stepStatus["VERIFY"] -eq "SUCCEED")
  return @{ AllSucceeded = $allSucceeded; Steps = $stepStatus }
}

# ============================================================================
# STATE 10a: FAILURE_DIAGNOSE
# ============================================================================
function Invoke-FailureDiagnose {
  param($Job)
  Write-StateBanner "STATE 10: FAILURE_DIAGNOSE"
  $combinedLogText = ""
  $tempLogFile = Join-Path $env:TEMP ("bello-staging-build-log-" + [Guid]::NewGuid().ToString("N") + ".txt")
  $script:tempLogFiles += $tempLogFile

  foreach ($step in $Job.steps) {
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
  Write-Host ("Full readable log saved to (deleted when this script exits): " + $tempLogFile) -ForegroundColor Cyan

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
  Stop-Runner
}

# ============================================================================
# STATE 10b: HTTP_VALIDATE
# ============================================================================
function Invoke-HttpValidate {
  param($App, $Branch)
  Write-StateBanner "STATE 10: HTTP_VALIDATE"

  if ($App.platform -ne "WEB_COMPUTE" -or $Branch.framework -ne "Next.js - SSR") {
    Write-Host "Platform/framework no longer match WEB_COMPUTE / Next.js - SSR at HTTP-check time - stopping." -ForegroundColor Red
    Stop-Runner
  }
  if (-not $App.defaultDomain) {
    Write-Host "get-app did not return a defaultDomain - cannot build the staging URL without hardcoding it." -ForegroundColor Red
    Stop-Runner
  }

  $urlSafeBranch = $BranchName -replace "/", "-"
  $stagingUrl = "https://" + $urlSafeBranch + "." + $App.defaultDomain
  Write-Host ("Staging URL (from get-app's defaultDomain, not hardcoded): " + $stagingUrl)

  $pathsToCheck = @("/", "/inventory", "/inventory/login")
  $httpResults = @{}
  $anyHardFailure = $false
  foreach ($path in $pathsToCheck) {
    $checkUrl = $stagingUrl + $path
    try {
      $response = Invoke-WebRequest -Uri $checkUrl -UseBasicParsing -MaximumRedirection 0 -ErrorAction Stop
      $httpResults[$path] = [int]$response.StatusCode
      Write-Host ("  " + $path + " -> HTTP " + $httpResults[$path]) -ForegroundColor Green
    } catch {
      if ($_.Exception.Response) {
        $statusCode = [int]$_.Exception.Response.StatusCode
        $httpResults[$path] = $statusCode
        # 200/301/302/307 are all acceptable - a redirect to a login page for
        # a protected route is expected behavior, not a failure.
        $isOk = ($statusCode -eq 200) -or ($statusCode -eq 301) -or ($statusCode -eq 302) -or ($statusCode -eq 307)
        if (-not $isOk) { $anyHardFailure = $true }
        Write-Host ("  " + $path + " -> HTTP " + $statusCode) -ForegroundColor $(if ($isOk) { "Green" } else { "Red" })
        if ($statusCode -eq 301 -or $statusCode -eq 302 -or $statusCode -eq 307) {
          Write-Host ("    Redirect location: " + $_.Exception.Response.Headers["Location"])
        }
      } else {
        $httpResults[$path] = -1
        $anyHardFailure = $true
        Write-Host ("  " + $path + " -> request failed without an HTTP response (DNS/connection failure): " + $_.Exception.Message) -ForegroundColor Red
      }
    }
  }

  if ($anyHardFailure) {
    Write-Host ""
    Write-Host "One or more paths returned a non-success status (404/5xx/DNS failure) - HTTP_VALIDATE failed." -ForegroundColor Red
    Stop-Runner
  }
  return @{ StagingUrl = $stagingUrl; Results = $httpResults }
}

# ============================================================================
# STATE 11: BACKEND_RESOURCE_VALIDATE (+ SSR Compute Role)
# ============================================================================
function Test-BackendResources {
  Write-StateBanner "STATE 11: BACKEND_RESOURCE_VALIDATE"
  Write-Host "Best-effort read-only presence checks, filtered by this app's ID appearing in the resource" -ForegroundColor Cyan
  Write-Host "name - naming conventions can vary, so a miss here is reported as a warning, not a hard failure." -ForegroundColor Cyan

  $checks = @{}

  $poolsResult = Invoke-AwsCli -ArgList @("cognito-idp", "list-user-pools", "--max-results", "60", "--query", "UserPools[?contains(Name, '$StagingAppId')].{Name:Name,Id:Id}", "--profile", $ProfileName, "--region", $Region, "--output", "json")
  if ($poolsResult.Ok) {
    $pools = @($poolsResult.Raw | ConvertFrom-Json)
    $checks["Cognito User Pool"] = $pools.Count -gt 0
    foreach ($p in $pools) { Write-Host ("  Cognito User Pool : " + $p.Name + " (" + $p.Id + ")") -ForegroundColor Green }
  }

  $apisResult = Invoke-AwsCli -ArgList @("appsync", "list-graphql-apis", "--query", "graphqlApis[?contains(name, '$StagingAppId')].{name:name,apiId:apiId}", "--profile", $ProfileName, "--region", $Region, "--output", "json")
  if ($apisResult.Ok) {
    $apis = @($apisResult.Raw | ConvertFrom-Json)
    $checks["AppSync API"] = $apis.Count -gt 0
    foreach ($a in $apis) { Write-Host ("  AppSync API       : " + $a.name + " (" + $a.apiId + ")") -ForegroundColor Green }
  }

  $tablesResult = Invoke-AwsCli -ArgList @("dynamodb", "list-tables", "--query", "TableNames[?contains(@, '$StagingAppId')]", "--profile", $ProfileName, "--region", $Region, "--output", "json")
  if ($tablesResult.Ok) {
    $tables = @($tablesResult.Raw | ConvertFrom-Json)
    $checks["DynamoDB tables"] = $tables.Count -gt 0
    foreach ($t in $tables) { Write-Host ("  DynamoDB table    : " + $t) -ForegroundColor Green }
  }

  $bucketsResult = Invoke-AwsCli -ArgList @("s3api", "list-buckets", "--query", "Buckets[?contains(Name, '$StagingAppId')].Name", "--profile", $ProfileName, "--region", $Region, "--output", "json")
  if ($bucketsResult.Ok) {
    $buckets = @($bucketsResult.Raw | ConvertFrom-Json)
    $checks["S3 / Storage bucket"] = $buckets.Count -gt 0
    foreach ($b in $buckets) { Write-Host ("  S3 bucket         : " + $b) -ForegroundColor Green }
  }

  foreach ($name in $checks.Keys) {
    if (-not $checks[$name]) {
      Write-Host ("  [WARNING] " + $name + " was not found by name-matching - verify manually if this matters; naming") -ForegroundColor Yellow
      Write-Host "  conventions for this resource type may not embed the app ID the way this check assumes." -ForegroundColor Yellow
    }
  }

  # ---- SSR Compute Role (distinct from the backend deployment role) ------
  # Amplify Hosting's SSR compute execution role is a separate App-level
  # field (computeRoleArn) from iamServiceRoleArn (the backend/CDK deploy
  # role used above in STATE 3). This is best-effort: whether the installed
  # AWS CLI/Amplify API version exposes/accepts computeRoleArn depends on
  # its version, so an absent field here is reported, not treated as fatal.
  Write-Host ""
  Write-Host "Checking the SSR Hosting Compute Role (separate from the backend deployment role)..."
  $appResult = Invoke-AwsCli -ArgList @("amplify", "get-app", "--app-id", $StagingAppId, "--profile", $ProfileName, "--region", $Region, "--output", "json")
  $computeRoleArn = $null
  if ($appResult.Ok) {
    $appNow = ($appResult.Raw | ConvertFrom-Json).app
    $computeRoleArn = $appNow.computeRoleArn
  }
  if ($computeRoleArn) {
    Write-Host ("  computeRoleArn already set: " + $computeRoleArn) -ForegroundColor Green
  } else {
    Write-Host "  computeRoleArn is not set (or this AWS CLI/API version does not return it)." -ForegroundColor Yellow
    Write-Host "  If lib/zaico/secretStore.ts's Secrets Manager calls need to run under a real IAM identity in" -ForegroundColor Yellow
    Write-Host "  Amplify Hosting (rather than falling back to ZAICO_API_TOKEN env var), a dedicated compute" -ForegroundColor Yellow
    Write-Host ("  role (" + $StagingComputeRoleName + ") with GetSecretValue/PutSecretValue scoped to only") -ForegroundColor Yellow
    Write-Host "  bello/zaico-api-token needs to be created and attached via 'aws amplify update-app" -ForegroundColor Yellow
    Write-Host "  --compute-role-arn' - not done automatically here since it is untested against this" -ForegroundColor Yellow
    Write-Host "  account's actual AWS CLI/Amplify API version. Until then, ZAICO_API_TOKEN env var fallback" -ForegroundColor Yellow
    Write-Host "  keeps the app working (see lib/zaico/client.ts) - this is not a regression." -ForegroundColor Yellow
  }

  return @{ Checks = $checks; ComputeRoleArn = $computeRoleArn }
}

# ============================================================================
# MAIN
# ============================================================================
Write-Host "BELLO Amplify staging deployment runner - idempotent, re-runnable, never touches production." -ForegroundColor Green

if (-not (Test-LogDecoder)) {
  Write-Host "Refusing to continue - the log decoder self-test failed, so failure diagnosis cannot be trusted." -ForegroundColor Red
  Stop-Runner
}

$identity = Test-AwsAuth
$envState = Test-StagingEnvironment
$roleArn = Test-StagingIamRole -App $envState.App -AccountId $identity.Account
$secretState = Test-ZaicoSecret
Wait-CloudFormationStable
$jobId = Invoke-AmplifyJobDiscoverAndStart
$finalJob = Wait-AmplifyJob -JobId $jobId
$stepResult = Test-AmplifyJobSteps -Job $finalJob

if (-not $stepResult.AllSucceeded) {
  Invoke-FailureDiagnose -Job $finalJob
}

$httpResult = Invoke-HttpValidate -App $envState.App -Branch $envState.Branch
$backendResult = Test-BackendResources

Write-StateBanner "STATE 12: COMPLETE"
Write-Host ("Staging app        : " + $StagingAppId + " (" + $StagingAppName + ")")
Write-Host ("Staging role       : " + $roleArn)
Write-Host ("Secret             : " + $secretState.Arn)
Write-Host ("Job ID             : " + $jobId)
Write-Host ("BUILD              : " + $stepResult.Steps["BUILD"])
Write-Host ("DEPLOY             : " + $stepResult.Steps["DEPLOY"])
Write-Host ("VERIFY             : " + $stepResult.Steps["VERIFY"])
Write-Host ("Staging URL        : " + $httpResult.StagingUrl)
foreach ($path in $httpResult.Results.Keys) {
  Write-Host ("  HTTP " + $path.PadRight(20) + ": " + $httpResult.Results[$path])
}
foreach ($name in $backendResult.Checks.Keys) {
  Write-Host ("Backend resource   : " + $name.PadRight(20) + ": " + $(if ($backendResult.Checks[$name]) { "FOUND" } else { "NOT FOUND (see warning above)" }))
}
Write-Host ("SSR Compute Role   : " + $(if ($backendResult.ComputeRoleArn) { $backendResult.ComputeRoleArn } else { "not configured - see note above" }))
Write-Host ("Existing production app " + $ExistingProductionAppId + ": NOT modified.") -ForegroundColor Green
Write-Host ("Existing production role " + $ExistingBackendRoleName + ": NOT modified.") -ForegroundColor Green
Write-Host "main branch: NOT touched." -ForegroundColor Green
Write-Host ""
Write-Host "BUILD/DEPLOY/VERIFY all SUCCEED and HTTP checks passed - staging Hosting is confirmed working." -ForegroundColor Green
Write-Host "This does NOT by itself confirm an authenticated session can read/write Cognito/AppSync/S3" -ForegroundColor Yellow
Write-Host "data, or that ZAICO sync works end to end - those need an actual login and a real ZAICO test" -ForegroundColor Yellow
Write-Host "sync (5 items max), which are the next steps, not yet done by this script." -ForegroundColor Yellow

Stop-Runner -Code 0
