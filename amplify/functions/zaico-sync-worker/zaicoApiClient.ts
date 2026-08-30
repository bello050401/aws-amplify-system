import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import type { ZaicoInventory } from "@/lib/zaico/client";

/**
 * BELLO統合業務OS 第五ラウンド §4(P0-A): `lib/zaico/client.ts`/
 * `lib/zaico/secretStore.ts`はどちらも`import "server-only"`を持つ
 * (前者は後者に依存)——実際の中身(AWS SDK直呼び + 生fetch)自体は
 * Next.js依存が無く、`server-only`は「クライアントバンドルへ混入させ
 * ない」ための安全弁として意図的に付けられたものなので、その安全弁を
 * 外すのではなく、Lambda用に薄いコピーをこのファイルへ作る(値・分岐
 * は同一、「小さな重複を許容し誤った依存結合を避ける」という
 * lib/inventory/zaicoSyncEngine.tsと同じ既存方針)。
 *
 * `ZaicoInventory`型自体は`import type`(実行時に一切importされず
 * 完全に消去される)なので、`lib/zaico/client.ts`からそのまま安全に
 * 借用できる——型を複製する理由が無い。
 */

const SECRET_NAME = "bello/zaico-api-token";
const DEFAULT_BASE_URL = "https://web.zaico.co.jp/api/v1";
const MIN_REQUEST_INTERVAL_MS = 400; // lib/zaico/client.tsと同じZAICOレート制限順守
const MAX_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 500;

interface ZaicoTokenSecretPayload {
  configured: boolean;
  token?: string;
}

let cachedClient: SecretsManagerClient | null = null;
function getSecretsClient(): SecretsManagerClient {
  if (!cachedClient) cachedClient = new SecretsManagerClient({});
  return cachedClient;
}

/** lib/zaico/secretStore.tsのgetZaicoTokenFromSecretsManagerと同じ読み取り+パース。 */
async function getTokenFromSecretsManager(): Promise<string | null> {
  try {
    const res = await getSecretsClient().send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
    if (!res.SecretString) return null;
    const parsed = JSON.parse(res.SecretString) as unknown;
    if (parsed && typeof parsed === "object" && "configured" in parsed) {
      const payload = parsed as ZaicoTokenSecretPayload;
      return payload.configured && payload.token ? payload.token : null;
    }
    return null;
  } catch (err) {
    console.error("[zaico-sync-worker] failed to read ZAICO token from Secrets Manager (non-fatal, will retry next invocation):", err instanceof Error ? err.name : err);
    return null;
  }
}

async function getToken(): Promise<string> {
  const fromSecretsManager = await getTokenFromSecretsManager();
  const token = fromSecretsManager ?? process.env.ZAICO_API_TOKEN;
  if (!token) throw new Error("ZAICO API TOKENが設定されていません(Secrets Manager `bello/zaico-api-token`、または環境変数ZAICO_API_TOKEN)。");
  return token;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let lastRequestAt = 0;
async function throttle(): Promise<void> {
  const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

export class ZaicoApiError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
  ) {
    super(message);
    this.name = "ZaicoApiError";
  }
}

/** lib/zaico/client.tsのgetJson/listInventoriesと同じretry/throttle方針(重複だが値は同一)。 */
export async function listInventories(page: number, perPage = 50): Promise<{ items: ZaicoInventory[]; hasMore: boolean }> {
  const token = await getToken();
  const baseUrl = process.env.ZAICO_API_BASE_URL ?? DEFAULT_BASE_URL;
  const url = new URL(`${baseUrl}/inventories`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(perPage));

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await throttle();
    let res: Response;
    try {
      res = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(INITIAL_BACKOFF_MS * 2 ** (attempt - 1));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new ZaicoApiError(`ZAICO API ${res.status} (/inventories)`, res.status);
      if (attempt === MAX_ATTEMPTS) break;
      const retryAfterHeader = res.headers.get("Retry-After");
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
      const backoff = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
      await sleep(backoff);
      continue;
    }
    if (!res.ok) throw new ZaicoApiError(`ZAICO APIエラー: HTTP ${res.status} (/inventories)`, res.status);
    const items = (await res.json()) as ZaicoInventory[];
    return { items, hasMore: items.length === perPage };
  }
  throw lastErr instanceof Error ? lastErr : new Error("ZAICO APIへの接続に失敗しました。");
}
