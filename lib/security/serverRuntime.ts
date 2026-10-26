import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { DynamoSecurityStore } from "./awsStore";
import { KmsVault } from "./awsVault";
import { CognitoProvider } from "./cognito";
import { SecurityService } from "./service";
import { SecurityError } from "./types";

export const deviceSecurityEnabled = () => process.env.BELLO_DEVICE_SECURITY === "enforced";
let runtime: Promise<{ service: SecurityService; contextKey: string; dataGate: string }> | undefined;
export function securityRuntime() {
  if (!runtime) runtime = load().catch(error => { runtime = undefined; throw error; });
  return runtime;
}
async function load() {
  const region = process.env.SECURITY_REGION || process.env.AWS_REGION;
  const required = [region, process.env.SECURITY_TABLE, process.env.SECURITY_KEY_ARN, process.env.SECURITY_DEPLOYMENT,
    process.env.SECURITY_POOL_ID, process.env.SECURITY_CLIENT_ID, process.env.SECURITY_CLIENT_SECRET_ARN, process.env.SECURITY_ORIGIN, process.env.SECURITY_APPSYNC_GATE_SECRET_ARN];
  if (required.some(x => !x)) throw new SecurityError("SECURITY_NOT_CONFIGURED", 503);
  const secret = await new SecretsManagerClient({ region }).send(new GetSecretValueCommand({ SecretId: process.env.SECURITY_CLIENT_SECRET_ARN }));
  const credentials = JSON.parse(secret.SecretString ?? "{}");
  if (typeof credentials.clientSecret !== "string" || credentials.clientSecret.length < 16 ||
    typeof credentials.contextKey !== "string" || credentials.contextKey.length < 43) throw new SecurityError("SECURITY_NOT_CONFIGURED", 503);
  const service = new SecurityService(new DynamoSecurityStore(process.env.SECURITY_TABLE!, region!),
    new KmsVault(process.env.SECURITY_KEY_ARN!, region!, process.env.SECURITY_DEPLOYMENT!),
    new CognitoProvider(process.env.SECURITY_POOL_ID!, process.env.SECURITY_CLIENT_ID!, region!, credentials.clientSecret), process.env.SECURITY_ORIGIN!);
  const gate = await new SecretsManagerClient({region}).send(new GetSecretValueCommand({SecretId:process.env.SECURITY_APPSYNC_GATE_SECRET_ARN}));
  const dataGate=JSON.parse(gate.SecretString??'{}').value;
  if(typeof dataGate!=='string'||dataGate.length<43)throw new SecurityError('SECURITY_NOT_CONFIGURED',503);
  return { service, contextKey: credentials.contextKey, dataGate };
}
