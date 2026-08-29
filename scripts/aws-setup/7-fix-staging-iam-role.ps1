<#
.SYNOPSIS
  Fix "Unable to assume specified IAM Role" on the dedicated staging
  Amplify app by creating a SEPARATE staging-only backend deployment
  role (never touching the existing production role or app), then
  rebuild and verify.

.DESCRIPTION
  Root cause of job 1's BUILD failure on the new staging app
  (d4hkkg7dty2du): that app's iamServiceRoleArn was left pointing at
  BelloAmplifyBackendDeploymentRole, which is the role the EXISTING
  production app (d1uy61lbnqm8ae) uses. That role's trust policy
  restricts aws:SourceArn to the production app's own ARN, so Amplify
  cannot assume it on behalf of the new staging app - AssumeRole is
  denied by the trust policy's own condition, which is exactly the
  "Unable to assume specified IAM Role" message Amplify surfaces.

  The fix is NOT to widen the existing production role's trust policy
  (that role must keep serving only the production app, undisturbed).
  Instead this script creates a brand new role,
  BelloAmplifyStagingBackendDeploymentRole, whose trust policy's
  aws:SourceArn condition is scoped ONLY to the new staging app's own
  ARN (arn:aws:amplify:<region>:<account>:apps/<staging-app-id>/branches/*)
  - it can never be assumed on behalf of the production app, by
  construction.

  Steps performed:
    1. Identity / root check.
    2. Read-only: list the existing production role's attached managed
       policies and inline policies (BelloAmplifyBackendDeploymentRole
       itself is never modified - this is purely to learn what
       permissions the staging role needs to replicate).
    3. Create (or, if this script is re-run, reuse and update the trust
       policy of) BelloAmplifyStagingBackendDeploymentRole, with a
       trust policy scoped to ONLY the new staging app's ARN.
    4. Attach the same managed policies, and copy the same inline
       policies, found in step 2, onto the new staging role.
    5. Update ONLY the staging app's iamServiceRoleArn to point at the
       new staging role (aws amplify update-app --iam-service-role-arn
       ... - no other app settings are touched). The production app ID
       is hard-refused as a target for this or any mutating call in
       this script (see $ExistingProductionAppId below).
    6. Confirm the staging app's only branch is the target branch.
    7. Wait briefly for IAM eventual consistency, then start a new
       RELEASE build.
    8. Poll every 15 seconds until terminal (up to ~20 minutes).
    9. If the build fails again with the same
       "Unable to assume specified IAM Role" pattern, this is a known
       IAM propagation-delay class of failure (very common right after
       creating a role / attaching policies) rather than a
       configuration mistake - the script automatically waits longer
       and retries the build itself, up to 3 attempts total, with no
       user action needed.
   10. On a FAILED build for any other reason: fetch and print every
       step's log for further analysis.
   11. On SUCCEED: request the public staging URL and print its HTTP
       status, and print the app's platform/branch framework to
       confirm WEB_COMPUTE / Next.js SSR.

  This script does NOT set up a Secrets Manager "compute role" (the
  role Next.js SSR requests use at runtime to read secrets) - that is
  a distinct role from this backend-deployment role and is configured
  separately, after the staging site is confirmed reachable. See
  2-apply-secrets-policy.ps1 for that step, run against the compute
  role once it exists.

  This script is plain ASCII on purpose - see 1-discover.ps1's header
  comment for why (Windows PowerShell 5.1 + non-ASCII text without a
  BOM can corrupt string literals and produce ParserError).

.PARAMETER StagingAppId
  The dedicated staging Amplify app ID (default: d4hkkg7dty2du - created
  by 6-create-staging-app.ps1). This script hard-refuses to ever target
  the existing production app ID with a mutating call.

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
  Name for the new, staging-only backend deployment role (default:
  BelloAmplifyStagingBackendDeploymentRole).

.PARAMETER Force
  Skip the confirmation prompt before making changes.

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
  [switch]$Force
)

$ErrorActionPreference = "Stop"

# Defense in depth: this script must never operate against the existing
# production-hosting app or its role, under any circumstance.
$ExistingProductionAppId = "d1uy61lbnqm8ae"

function Write-Section {
  param([string]$Title)
  Write-Host ""
  Write-Host ("==== " + $Title + " ====") -ForegroundColor Cyan
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

Write-Host "BELLO Amplify - staging-only IAM role fix (existing production app/role are never touched)" -ForegroundColor Green

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

# ---- 1. Read-only: what does the existing production role look like? -------
Write-Section "1. Reading the existing production role's policies (read-only, not modified)"
$managedPolicyArns = @()
$inlinePolicies = @{}

$attachedResult = Invoke-AwsCli -ArgList @("iam", "list-attached-role-policies", "--role-name", $ExistingBackendRoleName, "--profile", $ProfileName, "--region", $Region, "--output", "json")
if ($attachedResult.Ok) {
  $attached = ($attachedResult.Raw | ConvertFrom-Json).AttachedPolicies
  foreach ($p in $attached) {
    Write-Host ("  Managed policy: " + $p.PolicyName + " (" + $p.PolicyArn + ")")
    $managedPolicyArns += $p.PolicyArn
    if ($p.PolicyName -eq "AdministratorAccess-Amplify") {
      Write-Host "  [NOTE] The production role uses the broad AdministratorAccess-Amplify managed policy." -ForegroundColor Yellow
      Write-Host "  [NOTE] For initial staging bring-up, the same managed policy will be attached to the" -ForegroundColor Yellow
      Write-Host "  [NOTE] new staging role too, to avoid unknown missing-permission build failures during" -ForegroundColor Yellow
      Write-Host "  [NOTE] first setup. This is scoped to a SEPARATE role whose trust policy only allows" -ForegroundColor Yellow
      Write-Host "  [NOTE] assumption for the staging app's own ARN, so the blast radius of a compromised" -ForegroundColor Yellow
      Write-Host "  [NOTE] staging build is still limited to what can assume that specific role. This should" -ForegroundColor Yellow
      Write-Host "  [NOTE] be revisited and scoped down once staging is verified working end-to-end." -ForegroundColor Yellow
    }
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

if ($managedPolicyArns.Count -eq 0 -and $inlinePolicies.Count -eq 0) {
  Write-Host "  [WARNING] Found no managed or inline policies on the existing role - the staging role may end up under-permissioned. Continuing anyway." -ForegroundColor Yellow
}

# ---- 2. Create (or update) the new staging-only role -----------------------
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
Write-Host ("  New role name     : " + $NewStagingRoleName)
Write-Host ("  Trust policy scope: " + $stagingAppArn + " ONLY (production app is not in this trust policy)")

# Build the trust policy as a real JSON file rather than an inline CLI
# argument - see New-TempJsonFile's header comment for why. The temp file is
# never part of the git-tracked tree and is deleted in the finally block
# below regardless of success or failure.
$trustPolicyPath = New-TempJsonFile -Object $trustPolicyObj -Prefix "bello-staging-trust-policy"
Write-Section "2a. Trust policy structure (no secrets in this document - safe to print)"
Write-Host ("  Version                                    : " + $trustPolicyObj.Version)
Write-Host ("  Effect                                     : " + $trustPolicyObj.Statement[0].Effect)
Write-Host ("  Principal.Service                          : " + ($trustPolicyObj.Statement[0].Principal.Service -join ", "))
Write-Host ("  Action                                     : " + $trustPolicyObj.Statement[0].Action)
Write-Host ("  Condition.StringEquals.aws:SourceAccount   : " + $trustPolicyObj.Statement[0].Condition.StringEquals["aws:SourceAccount"])
Write-Host ("  Condition.ArnLike.aws:SourceArn            : " + $trustPolicyObj.Statement[0].Condition.ArnLike["aws:SourceArn"])
Write-Host "  (Re-parsed successfully via ConvertFrom-Json before being written to a temp file - see above.)" -ForegroundColor Green

if (-not $Force) {
  Write-Host ""
  Write-Host "About to create/update this IAM role and point the staging app at it." -ForegroundColor Cyan
  Write-Host ("Production app " + $ExistingProductionAppId + " and its role (" + $ExistingBackendRoleName + ") will NOT be touched.") -ForegroundColor Green
  $confirmation = Read-Host "Continue? (type yes to continue)"
  if ($confirmation -ne "yes") {
    Write-Host "Cancelled. No changes were made." -ForegroundColor Yellow
    Remove-Item -Force -ErrorAction SilentlyContinue $trustPolicyPath
    exit 0
  }
}

try {
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
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $trustPolicyPath
}
Write-Host ("  Staging role ARN: " + $newRoleArn) -ForegroundColor Green

# ---- 3. Replicate the permissions found in step 1 onto the new role --------
Write-Section "3. Attaching/copying the same permissions onto the staging role"
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
  # Same file:// approach as the trust policy above, for the same reason -
  # an inline policy document copied from the production role can be
  # arbitrarily large/complex and is not safe to pass as an inline CLI
  # argument on Windows.
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

# ---- 4. Point ONLY the staging app's iamServiceRoleArn at the new role -----
Write-Section "4. Updating the staging app's iamServiceRoleArn (no other settings touched)"
$updateAppResult = Invoke-AwsCli -ArgList @("amplify", "update-app", "--app-id", $StagingAppId, "--iam-service-role-arn", $newRoleArn, "--profile", $ProfileName, "--region", $Region, "--output", "json")
if (-not $updateAppResult.Ok) {
  Write-Host "update-app failed:" -ForegroundColor Red
  Write-Host $updateAppResult.Raw
  exit 1
}
Write-Host "  Staging app now uses the new staging-only role." -ForegroundColor Green

# ---- 5. Confirm the staging app only has the target branch -----------------
Write-Section "5. Confirming the staging app's branches (safety check)"
$branchesResult = Invoke-AwsCli -ArgList @("amplify", "list-branches", "--app-id", $StagingAppId, "--profile", $ProfileName, "--region", $Region, "--output", "json")
if (-not $branchesResult.Ok) {
  Write-Host "list-branches failed:" -ForegroundColor Red
  Write-Host $branchesResult.Raw
  exit 1
}
$branches = ($branchesResult.Raw | ConvertFrom-Json).branches
$unexpectedBranches = $branches | Where-Object { $_.branchName -ne $BranchName }
foreach ($b in $branches) {
  Write-Host ("  - " + $b.branchName + " (framework=" + $(if ($b.framework) { $b.framework } else { "(null)" }) + ")")
}
if ($unexpectedBranches) {
  Write-Host "[SAFETY ABORT] The staging app has a branch other than the expected target branch. Stopping before starting a build." -ForegroundColor Red
  exit 1
}
Write-Host ("  Confirmed: only '" + $BranchName + "' is connected to this staging app.") -ForegroundColor Green

# ---- 6. Build/poll/retry loop -----------------------------------------------
Write-Section "6. Waiting briefly for IAM propagation before the first build attempt"
Write-Host "  (Newly created/attached IAM permissions can take a short time to become usable" -ForegroundColor Yellow
Write-Host "  by AssumeRole across AWS - this is normal AWS-side eventual consistency, not an" -ForegroundColor Yellow
Write-Host "  error, so this script waits before starting the build rather than failing early.)" -ForegroundColor Yellow
Start-Sleep -Seconds 20

$maxAttempts = 3
$attempt = 0
$finalStatus = $null
$finalJob = $null
$newJobId = $null
$urlSafeBranch = $BranchName -replace "/", "-"
$newSiteUrl = "https://" + $urlSafeBranch + "." + $StagingAppId + ".amplifyapp.com"

while ($attempt -lt $maxAttempts) {
  $attempt++
  Write-Section ("7. Build attempt " + $attempt + " of " + $maxAttempts + " (RELEASE job)")
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
    Write-Section ("Build attempt " + $attempt + " FAILED - fetching step logs")
    $combinedLogText = ""
    foreach ($step in $finalJob.steps) {
      Write-Host ("--- step: " + $step.stepName + " status=" + $step.status + " ---") -ForegroundColor Yellow
      if ($step.logUrl) {
        try {
          $logText = (Invoke-WebRequest -Uri $step.logUrl -UseBasicParsing).Content
          Write-Host $logText
          $combinedLogText += $logText
        } catch {
          Write-Host ("Could not fetch log for this step: " + $_.Exception.Message) -ForegroundColor Red
        }
      } else {
        Write-Host "(no logUrl for this step)"
      }
    }

    if ($combinedLogText -match "Unable to assume specified IAM Role" -and $attempt -lt $maxAttempts) {
      Write-Host ""
      Write-Host "  Detected the same IAM role propagation-delay pattern as before." -ForegroundColor Yellow
      Write-Host "  This is expected occasionally right after creating/attaching a new IAM role -" -ForegroundColor Yellow
      Write-Host "  waiting longer and retrying automatically (no user action needed)." -ForegroundColor Yellow
      Start-Sleep -Seconds 30
      continue
    } else {
      Write-Host ""
      Write-Host "Build failed for a reason other than (or persisting past retries of) IAM propagation delay. Stopping - review the logs above." -ForegroundColor Red
      exit 1
    }
  }

  # CANCELLED or any other terminal state that isn't SUCCEED/FAILED
  Write-Host ("Build ended with status " + $finalStatus + " - stopping.") -ForegroundColor Red
  exit 1
}

# ---- 7. On SUCCEED: verify the public URL and platform/framework -----------
Write-Section "8. Job SUCCEED - verifying the public URL and app settings"
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
Write-Host ("Staging app ID   : " + $StagingAppId)
Write-Host ("Staging role ARN : " + $newRoleArn)
Write-Host ("Trust policy scope: " + $stagingAppArn)
Write-Host ("Build attempts   : " + $attempt + " of " + $maxAttempts)
Write-Host ("Final job ID     : " + $newJobId)
Write-Host ("Final job status : " + $finalStatus)
Write-Host ("Staging URL      : " + $newSiteUrl)
Write-Host ("Platform         : " + $finalPlatform)
Write-Host ("Branch framework : " + $finalFramework)
Write-Host ("Existing app " + $ExistingProductionAppId + " (production): NOT modified.") -ForegroundColor Green
Write-Host ("Existing role " + $ExistingBackendRoleName + " (production): NOT modified.") -ForegroundColor Green
Write-Host "main branch: NOT touched." -ForegroundColor Green
Write-Host ""
Write-Host "Next step (separate, later): the SSR runtime Secrets Manager compute role is a" -ForegroundColor Cyan
Write-Host "different role from this backend deployment role - configure it after confirming" -ForegroundColor Cyan
Write-Host "the staging site loads correctly, using 2-apply-secrets-policy.ps1." -ForegroundColor Cyan
