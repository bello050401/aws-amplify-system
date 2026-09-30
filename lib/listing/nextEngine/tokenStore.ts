import "server-only";
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { NextEngineAppConfiguration } from "./appConfiguration";
import { assertNextEngineServerRuntime } from "./serverBoundary";
import { exactNextEngineSecretArn } from "./secretReference";

export type NextEngineTokenPair = { accessToken: string; refreshToken: string };
type StoredTokens = NextEngineTokenPair & { credentialVersionId: string; companyNeId: string };
type SecretClient = Pick<SecretsManagerClient, "send">;
type Binding = Pick<NextEngineAppConfiguration, "credentialVersionId" | "expectedCompanyNeId">;

const invalid = () => new Error("ネクストエンジンの接続情報を安全に確認できませんでした。");
const configuredSecret = (env: Record<string, string | undefined>): string => {
  const id = exactNextEngineSecretArn(env.NEXT_ENGINE_TOKEN_SECRET_ID);
  if (!id || id === env.NEXT_ENGINE_APP_SECRET_ID?.trim()) throw invalid();
  return id;
};
const validPair = (value: unknown): value is NextEngineTokenPair => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.accessToken === "string" && !!row.accessToken.trim() &&
    typeof row.refreshToken === "string" && !!row.refreshToken.trim();
};

/** A legacy or differently bound pair is disconnected, never usable. */
export async function readNextEngineTokens(
  binding: Binding,
  client: SecretClient = new SecretsManagerClient({ region: "us-west-2" }),
  env: Record<string, string | undefined> = {
    NEXT_ENGINE_TOKEN_SECRET_ID: process.env.NEXT_ENGINE_TOKEN_SECRET_ID,
    NEXT_ENGINE_APP_SECRET_ID: process.env.NEXT_ENGINE_APP_SECRET_ID,
  },
): Promise<NextEngineTokenPair | null> {
  assertNextEngineServerRuntime();
  try {
    const response = await client.send(new GetSecretValueCommand({ SecretId: configuredSecret(env) }));
    if (!response.SecretString) return null;
    const parsed: unknown = JSON.parse(response.SecretString);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0) return null;
    if (!validPair(parsed)) throw invalid();
    const stored = parsed as StoredTokens;
    if (stored.credentialVersionId !== binding.credentialVersionId || stored.companyNeId !== binding.expectedCompanyNeId) return null;
    if (Object.keys(stored).sort().join(",") !== "accessToken,companyNeId,credentialVersionId,refreshToken") throw invalid();
    return { accessToken: stored.accessToken, refreshToken: stored.refreshToken };
  } catch { throw invalid(); }
}

/** Write the complete rotated pair to the exact pre-provisioned secret. */
export async function saveNextEngineTokens(
  tokens: NextEngineTokenPair,
  binding: Binding,
  client: SecretClient = new SecretsManagerClient({ region: "us-west-2" }),
  env: Record<string, string | undefined> = {
    NEXT_ENGINE_TOKEN_SECRET_ID: process.env.NEXT_ENGINE_TOKEN_SECRET_ID,
    NEXT_ENGINE_APP_SECRET_ID: process.env.NEXT_ENGINE_APP_SECRET_ID,
  },
): Promise<void> {
  assertNextEngineServerRuntime();
  if (!validPair(tokens) || !binding.credentialVersionId || !binding.expectedCompanyNeId) throw invalid();
  try {
    await client.send(new PutSecretValueCommand({
      SecretId: configuredSecret(env),
      SecretString: JSON.stringify({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        credentialVersionId: binding.credentialVersionId,
        companyNeId: binding.expectedCompanyNeId,
      }),
    }));
  } catch { throw new Error("ネクストエンジンの接続情報を保存できませんでした。"); }
}
