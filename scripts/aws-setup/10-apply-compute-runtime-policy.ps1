<#
.SYNOPSIS
  Grant the Amplify SSR compute role the runtime permissions it is missing:
  read/write on the Mercari and LINE secrets, and CloudWatch Logs.

.DESCRIPTION
  Why this exists
  ---------------
  Two gaps were measured on BelloAmplifyStagingComputeRole (the role the
  staging app's `computeRoleArn` actually points at):

  1. Its only inline policy, BelloZaicoComputeSecretAccess, grants
     GetSecretValue/PutSecretValue on bello/zaico-api-token and nothing
     else. bello/mercari-access-token and bello/line-channel-secret are
     not reachable at runtime. There is also no environment-variable
     fallback: the staging app and branch both have zero environment
     variables, so MERCARI_ACCESS_TOKEN / the LINE equivalents are unset
     too.

     The effect is that lib/listing/mercari/secretStore.ts gets
     AccessDenied, swallows it (returns token: null by design), and
     getMercariAccessToken() then throws "Token is not configured". The
     Mercari connection test cannot even reach Mercari, so the reported
     HTTP 404 cannot be reproduced or diagnosed until this is fixed.
     amplify/backend.ts already documents this as a manual ADMIN step
     that CDK cannot perform, because the SSR compute role is not part of
     defineBackend()'s resources - see the comments above
     mercariTokenSecret and zaicoTokenSecret.

  2. It has no CloudWatch Logs permissions, and there is no
     /aws/amplify/* log group in the account at all. Everything the SSR
     runtime logs - including the endpoint / environment / GraphQL
     operation / User-Agent-present / token-present diagnostics added
     specifically to investigate the Mercari 404 - is written somewhere
     nobody can read. Granting logs access is what makes those
     diagnostics observable.

  This script adds a SEPARATE inline policy under its own name. It never
  touches BelloZaicoComputeSecretAccess, so the existing ZAICO grant
  cannot be clobbered by running this.

  Secret values are never read, written, or printed here - this only
  changes IAM.

.PARAMETER RoleName
  Compute role to modify. Defaults to the staging role. Pass the role that
  the target app's `computeRoleArn` actually names - verify with
  `aws amplify get-app --app-id <id> --query app.computeRoleArn`.

.PARAMETER AppId
  Amplify app whose compute role is being modified. Used only for the
  safety check below.

.EXAMPLE
  ./scripts/aws-setup/10-apply-compute-runtime-policy.ps1
  ./scripts/aws-setup/10-apply-compute-runtime-policy.ps1 -Force
#>
[CmdletBinding()]
param(
  [string]$RoleName = "BelloAmplifyStagingComputeRole",
  [string]$AppId = "d4hkkg7dty2du",
  [string]$PolicyName = "BelloComputeRuntimeAccess",
  [string]$ProfileName = "Bello",
  [string]$Region = "us-west-2",
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$env:AWS_PAGER = ""
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUTF8 = "1"

Write-Host "BELLO - grant SSR compute role its missing runtime permissions" -ForegroundColor Green

# Defense in depth, matching scripts 6 and 7: refuse to run against the
# production app or anything derived from it.
$productionAppId = "d1uy61lbnqm8ae"
if ($AppId -eq $productionAppId -or $RoleName -like "*Production*") {
  Write-Host "Refusing to run against the production app ($productionAppId). This script is staging-only." -ForegroundColor Red
  exit 1
}

$identityRaw = & aws sts get-caller-identity --profile $ProfileName --region $Region --output json
if ($LASTEXITCODE -ne 0) { Write-Host "Failed to get AWS identity." -ForegroundColor Red; exit 1 }
$identity = $identityRaw | ConvertFrom-Json
if ($identity.Arn -match ":root$") {
  Write-Host "Do not run this with root credentials." -ForegroundColor Red
  exit 1
}
$acct = $identity.Account

# Confirm the role we are about to change is really the one this app runs
# as - a policy applied to the wrong role fixes nothing and is easy to
# miss, since neither Amplify nor IAM complains.
$computeRole = & aws amplify get-app --app-id $AppId --profile $ProfileName --region $Region --no-cli-pager --query "app.computeRoleArn" --output text
if ($LASTEXITCODE -ne 0) { Write-Host "Failed to read the app's computeRoleArn." -ForegroundColor Red; exit 1 }
if ($computeRole -notlike "*/$RoleName") {
  Write-Host "App $AppId runs as '$computeRole', which is not '$RoleName'. Refusing to apply the policy to a role the app does not use." -ForegroundColor Red
  exit 1
}
Write-Host ("Verified: app " + $AppId + " runs as " + $computeRole)

# ─────────────────────────────────────────────────────────────────────
# WARNING - this script has DRIFTED from the live policy (2026-09-03).
#
# put-role-policy REPLACES the whole inline policy. The live
# BelloComputeRuntimeAccess on BelloAmplifyStagingComputeRole currently
# also grants things this script does NOT reproduce:
#
#   - secret bello/mercari-relay-??????
#   - secret bello/base-app-credentials-??????
#   - s3:PutObject/GetObject on the messaging attachments prefix
#     (Sid BelloMessagingAttachments)
#
# Running this script as-is would REMOVE those and break Mercari relay,
# BASE OAuth, and LINE attachment storage. Read the live policy first:
#
#   aws iam get-role-policy --role-name BelloAmplifyStagingComputeRole `
#     --policy-name BelloComputeRuntimeAccess
#
# and fold any missing statements in before applying. Left in place
# rather than deleted because the surrounding role/compute-role discovery
# logic is still correct and worth keeping.
# ─────────────────────────────────────────────────────────────────────

# The ?????? suffix matches Secrets Manager's random 6-character version
# suffix, the same convention the existing ZAICO policy uses.
$mercariArn = "arn:aws:secretsmanager:${Region}:${acct}:secret:bello/mercari-access-token-??????"
$lineArn = "arn:aws:secretsmanager:${Region}:${acct}:secret:bello/line-channel-secret-??????"
# 2026-09-03: the internal notification LINE Bot (lib/messaging/lineNotify/
# secretStore.ts). A SEPARATE channel from the customer-facing official
# LINE account above - see that file's header for why they are not shared.
$notifyBotArn = "arn:aws:secretsmanager:${Region}:${acct}:secret:bello/line-notify-bot-??????"
$logsArn = "arn:aws:logs:${Region}:${acct}:log-group:/aws/amplify/*"

# CreateSecret and DeleteSecret are deliberately NOT granted: both secrets
# already exist as resources owned elsewhere, and the runtime has no
# reason to create or destroy them - only to read and update their value.
$policyDocument = @"
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BelloMercariAndLineSecretAccess",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:PutSecretValue"
      ],
      "Resource": [
        "$mercariArn",
        "$lineArn",
        "$notifyBotArn"
      ]
    },
    {
      "Sid": "BelloSsrComputeLogs",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams"
      ],
      "Resource": "$logsArn"
    }
  ]
}
"@

Write-Host ""
Write-Host ("Target role  : " + $RoleName)
Write-Host ("Policy name  : " + $PolicyName + "  (separate from BelloZaicoComputeSecretAccess, which is left untouched)")
Write-Host "Policy to apply:"
Write-Host $policyDocument

if (-not $Force) {
  $confirmation = Read-Host ("Add this policy to role '" + $RoleName + "'? (type yes to continue)")
  if ($confirmation -ne "yes") {
    Write-Host "Cancelled. No changes were made." -ForegroundColor Yellow
    exit 0
  }
}

# Write the document to a file rather than passing it inline: inline JSON
# on the command line has already broken once in this repo (see commit
# dae0df8).
$tempFile = New-TemporaryFile
try {
  # Write WITHOUT a BOM. Windows PowerShell 5.1's `Set-Content -Encoding utf8`
  # emits a UTF-8 BOM, and the AWS CLI then refuses the file with
  #   "Unable to load paramfile ... text contents could not be decoded."
  # which reads like a malformed policy but is purely an encoding artifact.
  [System.IO.File]::WriteAllText($tempFile.FullName, $policyDocument, [System.Text.UTF8Encoding]::new($false))

  & aws iam put-role-policy `
    --role-name $RoleName `
    --policy-name $PolicyName `
    --policy-document ("file://" + $tempFile) `
    --profile $ProfileName --region $Region
  if ($LASTEXITCODE -ne 0) { Write-Host "Failed to apply the policy." -ForegroundColor Red; exit 1 }

  Write-Host ""
  Write-Host "Applied. Inline policies now on the role:" -ForegroundColor Green
  & aws iam list-role-policies --role-name $RoleName --profile $ProfileName --region $Region --no-cli-pager --query "PolicyNames" --output text
  Write-Host ""
  Write-Host "IAM changes reach a running SSR compute only on its next deployment;" -ForegroundColor Yellow
  Write-Host "redeploy the branch before concluding anything from the app's behaviour." -ForegroundColor Yellow
}
finally {
  Remove-Item -Path $tempFile -ErrorAction SilentlyContinue
}
