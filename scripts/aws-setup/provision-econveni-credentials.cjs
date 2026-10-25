// Creates an empty dedicated secret and grants the existing web role access to that secret only.
// Existing credential values and other role policies are never replaced.
const { SecretsManagerClient, DescribeSecretCommand, CreateSecretCommand } = require("@aws-sdk/client-secrets-manager");
const { IAMClient, PutRolePolicyCommand } = require("@aws-sdk/client-iam");
const { STSClient, GetCallerIdentityCommand } = require("@aws-sdk/client-sts");
const { fromIni } = require("@aws-sdk/credential-providers");
async function main() {
  const config = { region: "us-west-2", credentials: fromIni({ profile: "Bello" }) };
  const identity = await new STSClient(config).send(new GetCallerIdentityCommand({}));
  if (identity.Account !== "203918843421") throw new Error("Unexpected AWS account");
  const secrets = new SecretsManagerClient(config);
  const Name = "bello/econveni-credentials";
  let ARN;
  try { ({ ARN } = await secrets.send(new DescribeSecretCommand({ SecretId: Name }))); }
  catch (error) {
    if (error.name !== "ResourceNotFoundException") throw error;
    ({ ARN } = await secrets.send(new CreateSecretCommand({
      Name, Description: "BELLO e-conveni server-side login credentials",
      SecretString: JSON.stringify({ schemaVersion: 1, configured: false }),
      Tags: [{ Key: "Application", Value: "BELLO" }, { Key: "Purpose", Value: "econveni-login" }],
    })));
  }
  if (!ARN) throw new Error("Missing secret ARN");
  await new IAMClient(config).send(new PutRolePolicyCommand({
    RoleName: "BelloAmplifyStagingComputeRole",
    PolicyName: "BelloEconveniCredentials",
    PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: [{
      Effect: "Allow", Action: ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"], Resource: ARN,
    }] }),
  }));
  console.log(JSON.stringify({ secret: Name, role: "BelloAmplifyStagingComputeRole", provisioned: true }));
}
main().catch(() => { console.error("e-conveni credential provisioning failed; no credential values logged."); process.exitCode = 1; });
