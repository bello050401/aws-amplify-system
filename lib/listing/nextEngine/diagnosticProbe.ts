import "server-only";
import { createHash } from "node:crypto";
import { GetSecretValueCommand, PutSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { getNextEngineAppConfiguration } from "./appConfiguration";
import { assertNextEngineServerRuntime } from "./serverBoundary";

export const NEXT_ENGINE_STAGING_ORIGIN = "https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com";
export const NEXT_ENGINE_DIAGNOSTIC_STAGE = "BELLO_DIAGNOSTIC_ONCE";
const ACCOUNT = "203918843421";
const SYNTHETIC = { clientId: "bello-diagnostic-only", clientSecret: "bello-diagnostic-only", companyNeId: "0" } as const;
type Client = Pick<SecretsManagerClient, "send">;
type Env = Record<string, string | undefined>;

function exactStagingArns(env: Env): { app: string; token: string } | null {
  const app = env.NEXT_ENGINE_APP_SECRET_ID?.trim();
  const token = env.NEXT_ENGINE_TOKEN_SECRET_ID?.trim();
  const prefix = `arn:aws:secretsmanager:us-west-2:${ACCOUNT}:secret:bello/`;
  if (!app || !token || !new RegExp(`^${prefix}next-engine-app-credentials-staging-[A-Za-z0-9]{6}$`).test(app) ||
      !new RegExp(`^${prefix}next-engine-tokens-staging-[A-Za-z0-9]{6}$`).test(token)) return null;
  return { app, token };
}

function emptyCurrent(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const value: unknown = JSON.parse(raw);
    return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
  } catch { return false; }
}

/** Writes only a synthetic, non-current version. Never changes AWSCURRENT. */
export async function runNextEngineDiagnosticProbe(client: Client, env: Env): Promise<boolean> {
  assertNextEngineServerRuntime();
  const ids = exactStagingArns(env);
  if (!ids) return false;
  try {
    const config = await getNextEngineAppConfiguration(client, {
      NEXT_ENGINE_APP_SECRET_ID: ids.app, NEXT_ENGINE_TOKEN_SECRET_ID: ids.token,
    });
    if (!config || config.clientId !== SYNTHETIC.clientId || config.clientSecret !== SYNTHETIC.clientSecret ||
        config.expectedCompanyNeId !== SYNTHETIC.companyNeId) return false;
    const current = await client.send(new GetSecretValueCommand({ SecretId: ids.token, VersionStage: "AWSCURRENT" }));
    if (!emptyCurrent(current.SecretString)) return false;
    try {
      // A previous run must be cleaned up by an administrator before retrying.
      await client.send(new GetSecretValueCommand({ SecretId: ids.token, VersionStage: NEXT_ENGINE_DIAGNOSTIC_STAGE }));
      return false;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "ResourceNotFoundException") return false;
    }
    const stillSynthetic = await getNextEngineAppConfiguration(client, {
      NEXT_ENGINE_APP_SECRET_ID: ids.app, NEXT_ENGINE_TOKEN_SECRET_ID: ids.token,
    });
    if (!stillSynthetic || stillSynthetic.credentialVersionId !== config.credentialVersionId ||
        stillSynthetic.clientId !== SYNTHETIC.clientId || stillSynthetic.clientSecret !== SYNTHETIC.clientSecret ||
        stillSynthetic.expectedCompanyNeId !== SYNTHETIC.companyNeId) return false;
    const fixedPair = {
      accessToken: "bello-diagnostic-access-only",
      refreshToken: "bello-diagnostic-refresh-only",
      credentialVersionId: config.credentialVersionId,
      companyNeId: SYNTHETIC.companyNeId,
    };
    const token = createHash("sha256").update(`bello-next-engine-diagnostic-v1:${ids.token}`).digest("hex");
    await client.send(new PutSecretValueCommand({
      SecretId: ids.token,
      ClientRequestToken: token,
      VersionStages: [NEXT_ENGINE_DIAGNOSTIC_STAGE],
      SecretString: JSON.stringify(fixedPair),
    }));
    const [readBack, after] = await Promise.all([
      client.send(new GetSecretValueCommand({ SecretId: ids.token, VersionStage: NEXT_ENGINE_DIAGNOSTIC_STAGE })),
      client.send(new GetSecretValueCommand({ SecretId: ids.token, VersionStage: "AWSCURRENT" })),
    ]);
    return readBack.SecretString === JSON.stringify(fixedPair) && emptyCurrent(after.SecretString);
  } catch { return false; }
}
