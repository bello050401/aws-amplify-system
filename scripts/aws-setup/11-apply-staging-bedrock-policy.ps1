# Grants the STAGING Amplify SSR compute role permission to invoke Anthropic
# models on Amazon Bedrock. Staging only - the Production app, Production role
# and Production data are never touched by this script.
#
# Why these actions and resources:
#   - The app calls Bedrock through AnthropicBedrock (the regular Bedrock
#     runtime). An earlier revision used the Mantle endpoint, which needs
#     bedrock-mantle:CreateInference - that permission is removed here because
#     this account's Mantle project exposes no models at all (every model id
#     returns 404 'does not exist'), so the app no longer uses that path.
#   - Model ids are cross-region inference profiles (us.anthropic.*). Bedrock
#     routes those to the underlying foundation model in us-west-2, us-east-1
#     or us-east-2, so the foundation-model ARNs of all three regions must be
#     allowed alongside the inference-profile ARN.
#
# NOTE: permission alone is not enough. This account has not submitted the
# Anthropic use case details form, so Bedrock answers every Anthropic model
# with HTTP 404 'Model use case details have not been submitted for this
# account.' Verify with:
#   aws bedrock get-use-case-for-model-access --profile Bello --region us-west-2
# Submit the form in the AWS console (Bedrock -> Model access) to clear it.

$ErrorActionPreference = 'Stop'

$Profile    = 'Bello'
$Region     = 'us-west-2'
$AccountId  = (aws sts get-caller-identity --profile $Profile --query Account --output text)
$RoleName   = 'BelloAmplifyStagingComputeRole'
$PolicyName = 'BelloBedrockInvoke'

if ($RoleName -notlike '*Staging*') { throw 'Refusing to run: this script only targets the Staging role.' }

$policy = @{
  Version   = '2012-10-17'
  Statement = @(
    @{
      Sid      = 'BelloBedrockInvokeAnthropic'
      Effect   = 'Allow'
      Action   = @('bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:Converse', 'bedrock:ConverseStream')
      Resource = @(
        "arn:aws:bedrock:${Region}:${AccountId}:inference-profile/us.anthropic.claude-*",
        'arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-*',
        'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-*',
        'arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-*'
      )
    }
  )
} | ConvertTo-Json -Depth 6

# Write without a BOM - the AWS CLI rejects a UTF-8 BOM with
# 'text contents could not be decoded'. Set-Content -Encoding utf8 adds one.
$tmp = Join-Path $env:TEMP 'bello-bedrock-policy.json'
[System.IO.File]::WriteAllText($tmp, $policy, (New-Object System.Text.UTF8Encoding($false)))

aws iam put-role-policy --role-name $RoleName --policy-name $PolicyName --policy-document file://$tmp --profile $Profile
Remove-Item $tmp -Force

Write-Host 'Applied. Current policy:'
aws iam get-role-policy --role-name $RoleName --policy-name $PolicyName --profile $Profile --query PolicyDocument --output json

Write-Host ''
Write-Host 'Use case form status (ResourceNotFoundException = not submitted yet):'
aws bedrock get-use-case-for-model-access --profile $Profile --region $Region
