import "server-only";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { assertNextEngineServerRuntime } from "./serverBoundary";
import { exactNextEngineSecretArn } from "./secretReference";

export type NextEngineAppConfiguration = {
  clientId: string;
  clientSecret: string;
  expectedCompanyNeId: string;
  credentialVersionId: string;
};

type SecretClient = Pick<SecretsManagerClient, "send">;
const invalid = () => new Error("ネクストエンジンのアプリ設定を確認できませんでした。");

/** Only the exact pre-provisioned secret ID is accepted; values never enter build artifacts. */
export async function getNextEngineAppConfiguration(
  client: SecretClient = new SecretsManagerClient({ region: "us-west-2" }),
  env: Record<string, string | undefined> = {
    NEXT_ENGINE_APP_SECRET_ID: process.env.NEXT_ENGINE_APP_SECRET_ID,
    NEXT_ENGINE_TOKEN_SECRET_ID: process.env.NEXT_ENGINE_TOKEN_SECRET_ID,
  },
): Promise<NextEngineAppConfiguration | null> {
  assertNextEngineServerRuntime();
  if (!env.NEXT_ENGINE_APP_SECRET_ID?.trim()) return null;
  const secretId = exactNextEngineSecretArn(env.NEXT_ENGINE_APP_SECRET_ID);
  if (!secretId || secretId === env.NEXT_ENGINE_TOKEN_SECRET_ID?.trim()) throw invalid();
  try {
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (!response.SecretString || !response.VersionId) throw invalid();
    const value: unknown = JSON.parse(response.SecretString);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    const row = value as Record<string, unknown>;
    if (Object.keys(row).sort().join(",") !== "clientId,clientSecret,companyNeId") throw invalid();
    const { clientId, clientSecret, companyNeId } = row;
    if (typeof clientId !== "string" || !clientId || /\s/.test(clientId) ||
        typeof clientSecret !== "string" || !clientSecret || /\s/.test(clientSecret) ||
        typeof companyNeId !== "string" || !companyNeId || companyNeId.length > 128 ||
        /[\x00-\x1f\x7f\u2028\u2029]/.test(companyNeId) ||
        typeof response.VersionId !== "string" || !response.VersionId.trim()) throw invalid();
    return { clientId, clientSecret, expectedCompanyNeId: companyNeId, credentialVersionId: response.VersionId };
  } catch { throw invalid(); }
}
