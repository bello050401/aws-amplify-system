import "server-only";

/**
 * GET-only ZAICO API client. This file has NO write methods — not "we
 * just don't call them", there is no `post`/`put`/`patch`/`delete` helper
 * anywhere below for a future call site to accidentally reach for. This
 * is intentional and absolute for the current sync phase: ZAICO→BELLO is
 * a one-way read, BELLO must never write anything back to ZAICO. If a
 * future phase genuinely needs a ZAICO write, that is a new, separate,
 * explicitly-reviewed file — never an addition to this one.
 *
 * Token handling: `ZAICO_API_TOKEN` is read from `process.env` inside
 * each call (not hoisted to a module-level constant) so importing this
 * file never throws just because the env var happens to be unset at
 * import time (e.g. during `next build`) — only an actual attempt to
 * call ZAICO does. The token is NEVER logged, NEVER included in a thrown
 * Error's message, and NEVER returned to any caller — every error below
 * describes the failure (status code, endpoint, retry count) but not the
 * credential used to make the request.
 */

const DEFAULT_BASE_URL = "https://web.zaico.co.jp/api/v1";

/** ZAICO's documented rate limit is ~3 req/sec/user (per the implementation instructions — not re-confirmed live in this environment, no network path to ZAICO exists here). Spacing every GET at least this far apart keeps this client comfortably under that regardless of how many items a full-catalog sync walks, without ever needing a burst of concurrent requests. */
const MIN_REQUEST_INTERVAL_MS = 400;
const MAX_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 500;

let lastRequestAt = 0;

/** Blocks until at least MIN_REQUEST_INTERVAL_MS has passed since the previous request this process made — the throttle that replaces "just don't await Promise.all" with an actual enforced floor. */
async function throttle(): Promise<void> {
  const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

function getToken(): string {
  const token = process.env.ZAICO_API_TOKEN;
  if (!token) {
    throw new Error("ZAICO_API_TOKENが設定されていません。サーバー環境変数として設定してください（値そのものはログに出力されません）。");
  }
  return token;
}

function getBaseUrl(): string {
  return process.env.ZAICO_API_BASE_URL ?? DEFAULT_BASE_URL;
}

/**
 * One throttled, retried GET. Retries on network failure, 429 (honoring
 * `Retry-After` when present), and 5xx — never on 4xx other than 429,
 * since those are a real client-side problem (bad id, bad token) that
 * retrying can't fix. Every retry still passes through `throttle()`, so
 * a burst of 429s can't turn into a burst of retries either.
 */
async function getJson<T>(path: string, searchParams?: Record<string, string | number | undefined>): Promise<T> {
  const token = getToken();
  const url = new URL(`${getBaseUrl()}${path}`);
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await throttle();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(INITIAL_BACKOFF_MS * 2 ** (attempt - 1));
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      lastErr = new ZaicoApiError(`ZAICO API ${res.status} (${path})`, res.status);
      if (attempt === MAX_ATTEMPTS) break;
      const retryAfterHeader = res.headers.get("Retry-After");
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
      const backoff = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
      await sleep(backoff);
      continue;
    }

    if (!res.ok) {
      // Not retryable — 401/403/404 etc. Surface status + endpoint only,
      // never the token/headers used to make the request.
      throw new ZaicoApiError(`ZAICO APIエラー: HTTP ${res.status} (${path})`, res.status);
    }

    return (await res.json()) as T;
  }

  throw new ZaicoApiError(
    `ZAICO APIへの接続に失敗しました（${MAX_ATTEMPTS}回試行、${path}）: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    lastErr instanceof ZaicoApiError ? lastErr.status : null,
  );
}

export interface ZaicoOptionalAttribute {
  name: string;
  value: string | null;
}

/**
 * Shape confirmed from a real `GET /inventories/:id` response (see
 * zaico-verification/output/inventory-detail.json). `categories`/`state`/
 * `group_tag`/`created_at`/`updated_at` are typed defensively (optional)
 * since the confirmed sample either left them empty or their presence
 * across every possible item hasn't been separately verified — the
 * mapping layer (lib/inventory/zaicoMapping.ts) treats every one of
 * these as optional input regardless.
 */
export interface ZaicoInventory {
  id: number;
  title: string;
  quantity: number | null;
  unit: string | null;
  category: string | null;
  categories?: string[] | null;
  state?: string | null;
  place: string | null;
  etc: string | null;
  code: string | null;
  group_tag?: string | null;
  item_image?: { url: string } | null;
  optional_attributes?: ZaicoOptionalAttribute[] | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** `GET /inventories/:id` — the only call the single-item sync path needs. */
export async function getInventory(id: string): Promise<ZaicoInventory> {
  return getJson<ZaicoInventory>(`/inventories/${encodeURIComponent(id)}`);
}

export interface ZaicoListPage {
  items: ZaicoInventory[];
  hasMore: boolean;
}

/**
 * `GET /inventories` for the full-catalog sync path. Pagination
 * convention (page/per_page query params, "fewer items than requested ⇒
 * last page") is a best-effort assumption based on ZAICO's general REST
 * API style — it was NOT re-confirmed against a real multi-page response
 * in this environment (no network path to ZAICO exists here; only a
 * single detail object and a `?limit=5` list sample were available). If
 * the real API uses a different pagination mechanism (cursor/nextToken,
 * a different param name, a Link header), this is the one function that
 * needs adjusting — every caller (lib/inventory/zaicoSync.ts) only relies
 * on `hasMore` becoming false eventually, not on this exact convention.
 */
export async function listInventories(page: number, perPage = 50): Promise<ZaicoListPage> {
  const items = await getJson<ZaicoInventory[]>("/inventories", { page, per_page: perPage });
  return { items, hasMore: items.length === perPage };
}
