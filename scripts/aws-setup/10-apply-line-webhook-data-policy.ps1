<#
.SYNOPSIS
  Grant the Amplify SSR compute role exactly the DynamoDB permissions the
  LINE webhook needs to store an incoming message - no more.

.DESCRIPTION
  Why this exists at all
  ----------------------
  The LINE webhook is an UNAUTHENTICATED POST from the LINE platform. There
  is no cookie and no Cognito session, so the app's normal data path
  (`serverDataClient` + `authMode: "userPool"`) cannot be used - every write
  failed and the handler returned 500, which meant **no LINE message was
  ever stored in BELLO**. Reproduced with a correctly signed request on
  2026-08-31.

  `lib/messaging/webhookStore.ts` therefore writes to DynamoDB directly with
  the execution role's credentials - the same approach already used by the
  three background workers (zaico-sync / image-processing / pricing). That
  needs an IAM grant on the SSR compute role, which is NOT part of the CDK
  stack (Amplify Hosting owns it), so CDK cannot make this change.

  Least privilege
  ---------------
  The actions below are exactly what `webhookStore.ts` calls, verified by
  reading the source:

    Query      - dedupe lookup on the `messagesByExternalMessageId` GSI
    Scan       - find an existing Conversation by (channel, externalCustomerId);
                 that pair has no GSI, so this is a filtered Scan
    PutItem    - create the Conversation and the Message
    UpdateItem - bump unreadCount / lastMessageAt on an existing Conversation

  `GetItem` is deliberately NOT granted: nothing in the implementation calls
  it. An earlier version of this policy included it; it was removed once the
  call sites were checked. Wildcard resources (`Resource: "*"`) are likewise
  not used - only the two tables and their indexes.

  This script is idempotent: `put-role-policy` replaces the inline policy
  with the same content on every run.

.PARAMETER Profile
  AWS CLI profile to use. Defaults to "Bello".

.PARAMETER Region
  Region holding the tables. Defaults to "us-west-2".

.PARAMETER ApiId
  The AppSync API id that suffixes the Amplify-generated table names. Get it
  from `amplify_outputs.json` (the subdomain of `data.url`) or from
  `aws appsync list-graphql-apis`.

.PARAMETER RoleName
  The SSR compute role. Verify with:
    aws amplify get-app --app-id <id> --query app.computeRoleArn

.EXAMPLE
  ./10-apply-line-webhook-data-policy.ps1 -ApiId j6up24p7lnczdmklzjdt3vrp4y
#>
[CmdletBinding()]
param(
  [string]$Profile = "Bello",
  [string]$Region = "us-west-2",
  [Parameter(Mandatory = $true)][string]$ApiId,
  [string]$EnvName = "NONE",
  [string]$RoleName = "BelloAmplifyStagingComputeRole",
  [string]$PolicyName = "BelloLineWebhookDataAccess"
)

$ErrorActionPreference = "Stop"

$account = (aws sts get-caller-identity --profile $Profile --query Account --output text)
if (-not $account) { throw "Could not resolve the AWS account id. Is the SSO session current?" }

$conversation = "Conversation-$ApiId-$EnvName"
$message = "Message-$ApiId-$EnvName"

Write-Host "account : $account"
Write-Host "role    : $RoleName"
Write-Host "tables  : $conversation / $message"

# Confirm the tables actually exist before granting anything against them -
# a typo in ApiId would otherwise produce a policy that silently grants
# nothing useful and leaves the webhook failing with TABLE_NOT_FOUND.
foreach ($t in @($conversation, $message)) {
  aws dynamodb describe-table --table-name $t --region $Region --profile $Profile --query "Table.TableName" --output text | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Table not found: $t (check -ApiId / -EnvName / -Region)" }
}

$policy = @{
  Version   = "2012-10-17"
  Statement = @(
    @{
      Sid      = "LineWebhookConversationAndMessage"
      Effect   = "Allow"
      # Exactly the four operations webhookStore.ts performs. No GetItem.
      Action   = @("dynamodb:Query", "dynamodb:Scan", "dynamodb:PutItem", "dynamodb:UpdateItem")
      Resource = @(
        "arn:aws:dynamodb:${Region}:${account}:table/$conversation",
        "arn:aws:dynamodb:${Region}:${account}:table/$conversation/index/*",
        "arn:aws:dynamodb:${Region}:${account}:table/$message",
        "arn:aws:dynamodb:${Region}:${account}:table/$message/index/*"
      )
    }
  )
} | ConvertTo-Json -Depth 8 -Compress

$tmp = Join-Path $env:TEMP "bello-line-webhook-policy.json"
Set-Content -Path $tmp -Value $policy -Encoding utf8

aws iam put-role-policy --role-name $RoleName --policy-name $PolicyName `
  --policy-document "file://$tmp" --profile $Profile
if ($LASTEXITCODE -ne 0) { throw "put-role-policy failed" }

Remove-Item $tmp -Force

Write-Host ""
Write-Host "Applied. Verify the effective permissions with:"
Write-Host "  aws iam simulate-principal-policy --policy-source-arn arn:aws:iam::${account}:role/$RoleName \"
Write-Host "    --action-names dynamodb:PutItem dynamodb:Query dynamodb:Scan dynamodb:UpdateItem \"
Write-Host "    --resource-arns arn:aws:dynamodb:${Region}:${account}:table/$message --profile $Profile"
Write-Host ""
Write-Host "Note: the table NAMES also have to reach the SSR runtime. Amplify console"
Write-Host "environment variables do NOT appear in the Next.js server runtime's process.env;"
Write-Host "they are baked in at build time via next.config.mjs `env` - see"
Write-Host "docs/line-ai-mercari-staging-20260901.md."
