import "server-only";
import { getLineConnectionFromSecretsManager } from "./secretStore";

/**
 * lib/listing/mercari/tokenAccess.tsと同一の設計(AWS Secrets Manager
 * 優先、無ければサーバー環境変数LINE_CHANNEL_SECRET/
 * LINE_CHANNEL_ACCESS_TOKENへフォールバック)。
 */
export type LineTokenSource = "secrets-manager" | "env-fallback" | "unconfigured";

export async function getLineChannelSecret(): Promise<string | null> {
  const fromSecretsManager = (await getLineConnectionFromSecretsManager()).channelSecret;
  return fromSecretsManager ?? process.env.LINE_CHANNEL_SECRET ?? null;
}

export async function getLineAccessToken(): Promise<string | null> {
  const fromSecretsManager = (await getLineConnectionFromSecretsManager()).accessToken;
  return fromSecretsManager ?? process.env.LINE_CHANNEL_ACCESS_TOKEN ?? null;
}

export async function getLineTokenSource(): Promise<LineTokenSource> {
  const fromSecretsManager = await getLineConnectionFromSecretsManager();
  if (fromSecretsManager.channelSecret && fromSecretsManager.accessToken) return "secrets-manager";
  if (process.env.LINE_CHANNEL_SECRET && process.env.LINE_CHANNEL_ACCESS_TOKEN) return "env-fallback";
  return "unconfigured";
}

export async function isLineConnected(): Promise<boolean> {
  return (await getLineTokenSource()) !== "unconfigured";
}
