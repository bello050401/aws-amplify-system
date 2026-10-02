import "server-only";

import { assertNextEngineServerRuntime } from "./serverBoundary";
import { withBoundNextEngineRead } from "./boundRead";
import { resolveNextEngineTokenRotation } from "./tokenRotation";
import { parseNextEngineOrderWindow, validateNextEngineOrderWindow, type NextEngineOrderWindow } from "./orderWindow";

type Tokens = { accessToken: string; refreshToken: string };

/** Read one shop and one at-most-24h import window. Never returns partial pages. */
export async function readNextEngineOrderWindow(
  tokens: Tokens,
  persistTokens: (tokens: Tokens) => Promise<void>,
  window: NextEngineOrderWindow,
  request: typeof fetch = fetch,
) {
  assertNextEngineServerRuntime();
  validateNextEngineOrderWindow(window);
  if (!tokens.accessToken?.trim() || !tokens.refreshToken?.trim()) throw new Error("ネクストエンジンの認証接続が必要です。");
  const body = new URLSearchParams({
    access_token: tokens.accessToken, refresh_token: tokens.refreshToken, wait_flag: "1",
    fields: "receive_order_id,receive_order_shop_id,receive_order_import_date,receive_order_order_status_id",
    "receive_order_shop_id-eq": window.shopId,
    "receive_order_import_date-gte": window.from,
    "receive_order_import_date-lt": window.before,
    // Ask for one sentinel row because NE's count may be limited to the requested page.
    offset: "0", limit: "51",
  });
  let response: Response;
  let payload: unknown;
  try {
    response = await request("https://api.next-engine.org/api_v1_receiveorder_base/search", {
      method: "POST", body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    if (!response.body) throw new Error("empty response");
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > 65_536) throw new Error("large response");
    payload = JSON.parse(raw);
  } catch {
    throw new Error("受注情報の取得に失敗しました。接続を確認してください。");
  }
  let rotation: ReturnType<typeof resolveNextEngineTokenRotation>;
  try { rotation = resolveNextEngineTokenRotation(tokens, payload); }
  catch { throw new Error("認証情報を確認できませんでした。接続を確認してください。"); }
  if (rotation.rotated) {
    try { await persistTokens({ accessToken: rotation.accessToken, refreshToken: rotation.refreshToken }); }
    catch { throw new Error("認証情報を安全に保存できませんでした。接続を確認してください。"); }
  }
  if (!response.ok) throw new Error("受注情報の取得に失敗しました。接続を確認してください。");
  return parseNextEngineOrderWindow(payload, window);
}

/** Caller supplies a verified NE shop ID; no automatic scan is performed. */
export async function readBoundNextEngineOrderWindow(window: NextEngineOrderWindow) {
  return withBoundNextEngineRead((tokens, persist) => readNextEngineOrderWindow(tokens, persist, window));
}
