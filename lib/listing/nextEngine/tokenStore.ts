import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { assertNextEngineServerRuntime } from "./serverBoundary";

type TokenPair = { accessToken: string; refreshToken: string };
type SecretClient = Pick<SecretsManagerClient, "send">;

const invalid = () => new Error("ネクストエンジンの接続情報を安全に確認できませんでした。");
const configuredSecret = (env: Record<string, string | undefined>): string => {
  const id = env.NEXT_ENGINE_TOKEN_SECRET_ID?.trim();
  if (!id || /\s/.test(id)) throw new Error("ネクストエンジンの接続情報の保存先が未設定です。");
  return id;
};
const validTokens = (value: unknown): value is TokenPair => {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.accessToken === "string" && !!row.accessToken.trim() &&
    typeof row.refreshToken === "string" && !!row.refreshToken.trim();
};

/** Read only from a pre-provisioned server-side secret. Never serialize this result to a client. */
export async function readNextEngineTokens(
  client: SecretClient = new SecretsManagerClient({ region: "us-west-2" }),
  env: Record<string, string | undefined> = process.env,
): Promise<TokenPair | null> {
  assertNextEngineServerRuntime();
  try {
    const response = await client.send(new GetSecretValueCommand({ SecretId: configuredSecret(env) }));
    if (!response.SecretString) return null;
    const parsed: unknown = JSON.parse(response.SecretString);
    if (!validTokens(parsed)) throw invalid();
    return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
  } catch {
    throw invalid();
  }
}

/** Write the complete rotated pair to an existing secret; no browser or log output. */
export async function saveNextEngineTokens(
  tokens: TokenPair,
  client: SecretClient = new SecretsManagerClient({ region: "us-west-2" }),
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  assertNextEngineServerRuntime();
  if (!validTokens(tokens)) throw invalid();
  try {
    await client.send(new PutSecretValueCommand({
      SecretId: configuredSecret(env),
      SecretString: JSON.stringify(tokens),
    }));
  } catch {
    throw new Error("ネクストエンジンの接続情報を保存できませんでした。");
  }
}
