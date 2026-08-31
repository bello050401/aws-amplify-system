import "server-only";
import { getZaicoTokenFromSecretsManager } from "./secretStore";

/**
 * GET-only ZAICO API client. This file has NO write methods — not "we
 * just don't call them", there is no `post`/`put`/`patch`/`delete` helper
 * anywhere below for a future call site to accidentally reach for. This
 * is intentional and absolute for the current sync phase: ZAICO→BELLO is
 * a one-way read, BELLO must never write anything back to ZAICO. If a
 * future phase genuinely needs a ZAICO write, that is a new, separate,
 * explicitly-reviewed file — never an addition to this one.
 *
 * Token handling (夜間開発指示書 §14で更新): まずAWS Secrets Manager
 * (lib/zaico/secretStore.ts、設定画面から書き込める)を確認し、無ければ
 * サーバー環境変数`ZAICO_API_TOKEN`(ローカル開発の.env.local、または
 * Amplify Hosting環境変数)へフォールバックする — getZaicoApiToken()が
 * その一本化された入口。値はNEVER logged、NEVER included in a thrown
 * Error's message、NEVER returned to any caller(呼び出し元はcredential
 * を直接fetchのAuthorizationヘッダへ渡すだけ) — every error below
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

/**
 * 唯一の入口(spec §14: 「共通：getZaicoApiToken()等でZAICO clientから
 * 利用」) — AWS Secrets Manager優先、無ければサーバー環境変数
 * `ZAICO_API_TOKEN`。値はこの関数の戻り値としてのみ存在し、呼び出し元
 * (getJson)がfetchのAuthorizationヘッダへ直接渡す以外の用途では一切
 * 使わない。
 */
export async function getZaicoApiToken(): Promise<string> {
  const fromSecretsManager = await getZaicoTokenFromSecretsManager();
  const token = fromSecretsManager ?? process.env.ZAICO_API_TOKEN;
  if (!token) {
    throw new Error(
      "ZAICO API TOKENが設定されていません。設定画面のZAICO同期タブから登録するか、サーバー環境変数ZAICO_API_TOKENを設定してください（値そのものはログに出力されません）。",
    );
  }
  return token;
}

/**
 * 設定画面の「ZAICO API接続設定」表示用 — AWS Secrets Managerまたは
 * サーバー環境変数`ZAICO_API_TOKEN`のいずれかにトークンが設定されて
 * いるかどうかの真偽値だけを返す。トークンの値そのものは一切返さな
 * い・伏字表示すら作らない設計(spec: 「伏字表示すら不要」) —
 * この関数の戻り値をクライアントコンポーネントへpropsとして渡して
 * も、渡っているのは真偽値1つだけでトークン本体は一度もJavaScriptの
 * 実行環境(サーバーどちらのプロセス境界も含め)を越えない。
 */
export async function isZaicoConnected(): Promise<boolean> {
  if (await getZaicoTokenFromSecretsManager()) return true;
  return Boolean(process.env.ZAICO_API_TOKEN);
}

export type ZaicoTokenSource = "secrets-manager" | "env-fallback" | "unconfigured";

/**
 * どちらの経路からTOKENが得られているかだけを返す診断用関数(値は一切
 * 含まない)。AWS staging環境でのSSR Compute Role設定確認(AWSテスト環境
 * 構築指示: 「ZAICO_API_TOKEN env var fallbackが存在していても、成功条件
 * はSecrets Manager経由で取得できること。fallbackだけで成功扱いしない」)
 * のために追加した — isZaicoConnected()の真偽値だけでは「Secrets Manager
 * 経由で本当に取れているのか、単に環境変数フォールバックで動いている
 * だけなのか」を区別できなかったため。設定画面(ADMIN限定)にこの区別を
 * 表示することで、Compute Roleのtrust policy/権限設定が正しく効いてい
 * るかどうかを、Secret値を一切表示せずにブラウザから確認できる。
 */
export async function getZaicoTokenSource(): Promise<ZaicoTokenSource> {
  if (await getZaicoTokenFromSecretsManager()) return "secrets-manager";
  if (process.env.ZAICO_API_TOKEN) return "env-fallback";
  return "unconfigured";
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
async function getJson<T>(
  path: string,
  searchParams?: Record<string, string | number | undefined>,
  tokenOverride?: string,
): Promise<T> {
  const token = tokenOverride ?? (await getZaicoApiToken());
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
  // `items.length === perPage` で最終ページを判定してはいけない。
  //
  // ZAICOの `/inventories` は **per_page を無視して常に1,000件返す**。
  // 2026-08-31に実測で確認した(per_page=10 / 50 / 100 / 500 / 1000 / 2000 /
  // 未指定、さらに limit / count / size / per / page_size / perPage の
  // いずれを付けても応答は1,000件)。
  //
  // そのため要求値と比較すると `1000 === 50` が偽になり、**1ページ目だけを
  // 処理して同期が完了扱いになっていた**。これが「ZAICOが1,000件で止まる」の
  // 正体で、コード上の固定上限ではない。実際の在庫は5,312件あり、
  // 4,312件が一度も同期されていなかった。
  //
  // サーバが返す件数に依存しない判定にする: 件が返る限り次ページがあり、
  // 空ページで終わる。per_pageが将来効くようになっても正しく動く。
  return { items, hasMore: items.length > 0 };
}

export type ZaicoTokenValidationResult =
  | { ok: true }
  | { ok: false; reason: "unauthorized" | "network"; message: string };

/**
 * 設定画面からTOKENを保存する前の疎通確認(spec §14: 「保存前にZAICO
 * GET APIで成功/認証失敗/通信エラーを判定」)。まだSecrets Managerへ
 * 保存していない値をその場で試すため、`tokenOverride`でgetJsonの
 * トークン解決(getZaicoApiToken、Secrets Manager優先)を明示的にバイ
 * パスする — ここだけの特別な経路で、通常の同期処理は一切この関数を
 * 経由しない。最も軽い呼び出し(1件だけの一覧取得)で確認する。
 */
export async function validateZaicoToken(token: string): Promise<ZaicoTokenValidationResult> {
  const trimmed = token.trim();
  if (!trimmed) return { ok: false, reason: "unauthorized", message: "TOKENを入力してください。" };
  try {
    await getJson<ZaicoInventory[]>("/inventories", { page: 1, per_page: 1 }, trimmed);
    return { ok: true };
  } catch (err) {
    if (err instanceof ZaicoApiError && (err.status === 401 || err.status === 403)) {
      return { ok: false, reason: "unauthorized", message: "認証に失敗しました。TOKENが正しいか確認してください。" };
    }
    if (err instanceof ZaicoApiError) {
      return { ok: false, reason: "network", message: `ZAICO APIエラー（HTTP ${err.status ?? "不明"}）が発生しました。時間をおいて再度お試しください。` };
    }
    return { ok: false, reason: "network", message: "ZAICO APIへ接続できませんでした（通信エラー）。ネットワーク状況を確認してください。" };
  }
}
