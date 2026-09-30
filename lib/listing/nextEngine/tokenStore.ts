import "server-only";
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { NextEngineAppConfiguration } from "./appConfiguration";
import { assertNextEngineServerRuntime } from "./serverBoundary";
import { exactNextEngineSecretArn } from "./secretReference";

export type NextEngineTokenPair = { accessToken: string; refreshToken: string };
export type NextEngineTokenStatus = "EMPTY" | "CREDENTIAL_VERSION_MISMATCH" | "COMPANY_MISMATCH" |
  "INVALID_FORMAT" | "READ_ERROR" | "REFERENCE_INVALID" | "READY";
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

/** Keep the stored pair on the server; only a fixed reason code may reach the ADMIN settings UI. */
async function loadNextEngineTokens(
  binding: Binding,
  client: SecretClient,
  env: Record<string, string | undefined>,
): Promise<{ status: NextEngineTokenStatus; tokens: NextEngineTokenPair | null }> {
  assertNextEngineServerRuntime();
  let secretId: string;
  try { secretId = configuredSecret(env); }
  catch { return { status: "REFERENCE_INVALID", tokens: null }; }
  let secretString: string | undefined;
  try {
    secretString = (await client.send(new GetSecretValueCommand({ SecretId: secretId }))).SecretString;
  } catch { return { status: "READ_ERROR", tokens: null }; }
  if (!secretString) return { status: "EMPTY", tokens: null };
  try {
    const parsed: unknown = JSON.parse(secretString);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0) {
      return { status: "EMPTY", tokens: null };
    }
    if (!validPair(parsed)) throw invalid();
    const stored = parsed as StoredTokens;
    if (stored.credentialVersionId !== binding.credentialVersionId) return { status: "CREDENTIAL_VERSION_MISMATCH", tokens: null };
    if (stored.companyNeId !== binding.expectedCompanyNeId) return { status: "COMPANY_MISMATCH", tokens: null };
    if (Object.keys(stored).sort().join(",") !== "accessToken,companyNeId,credentialVersionId,refreshToken") throw invalid();
    return { status: "READY", tokens: { accessToken: stored.accessToken, refreshToken: stored.refreshToken } };
  } catch { return { status: "INVALID_FORMAT", tokens: null }; }
}

const defaultEnv = () => ({
  NEXT_ENGINE_TOKEN_SECRET_ID: process.env.NEXT_ENGINE_TOKEN_SECRET_ID,
  NEXT_ENGINE_APP_SECRET_ID: process.env.NEXT_ENGINE_APP_SECRET_ID,
});

/** A legacy or differently bound pair is disconnected, never usable. */
export async function readNextEngineTokens(
  binding: Binding,
  client: SecretClient = new SecretsManagerClient({ region: "us-west-2" }),
  env: Record<string, string | undefined> = defaultEnv(),
): Promise<NextEngineTokenPair | null> {
  const loaded = await loadNextEngineTokens(binding, client, env);
  if (loaded.status === "INVALID_FORMAT" || loaded.status === "READ_ERROR" || loaded.status === "REFERENCE_INVALID") throw invalid();
  return loaded.tokens;
}

export async function inspectNextEngineTokens(
  binding: Binding,
  client: SecretClient = new SecretsManagerClient({ region: "us-west-2" }),
  env: Record<string, string | undefined> = defaultEnv(),
): Promise<NextEngineTokenStatus> {
  return (await loadNextEngineTokens(binding, client, env)).status;
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
