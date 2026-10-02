import "server-only";

import { assertNextEngineServerRuntime } from "./serverBoundary";
import { resolveNextEngineTokenRotation } from "./tokenRotation";
import { parseNextEnginePageVisibility } from "./pageVisibilityReadback";

type Tokens = { accessToken: string; refreshToken: string };

/** Exact-SKU page search; never creates a page or sends anything to a marketplace. */
export async function readNextEnginePageVisibility(
  tokens: Tokens,
  persistTokens: (tokens: Tokens) => Promise<void>,
  sku: string,
  request: typeof fetch = fetch,
) {
  assertNextEngineServerRuntime();
  if (!/^[A-Za-z0-9-]{1,49}$/.test(sku)) throw new Error("商品コードを確認できませんでした。");
  if (!tokens.accessToken?.trim() || !tokens.refreshToken?.trim()) throw new Error("ネクストエンジンの認証接続が必要です。");
  const body = new URLSearchParams({
    access_token: tokens.accessToken, refresh_token: tokens.refreshToken, wait_flag: "1",
    fields: "goods_page_goods_code,goods_page_display_flag",
    "goods_page_goods_code-eq": sku, offset: "0", limit: "2",
  });
  let response: Response;
  let payload: unknown;
  try {
    response = await request("https://api.next-engine.org/api_v1_master_goods_page/search", {
      method: "POST", body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    if (!response.body) throw new Error("empty response");
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > 65_536) throw new Error("large response");
    payload = JSON.parse(raw);
  } catch {
    throw new Error("NEの商品ページの取得に失敗しました。接続を確認してください。");
  }
  let rotation: ReturnType<typeof resolveNextEngineTokenRotation>;
  try { rotation = resolveNextEngineTokenRotation(tokens, payload); }
  catch { throw new Error("認証情報を確認できませんでした。接続を確認してください。"); }
  if (rotation.rotated) {
    try { await persistTokens({ accessToken: rotation.accessToken, refreshToken: rotation.refreshToken }); }
    catch { throw new Error("認証情報を安全に保存できませんでした。接続を確認してください。"); }
  }
  if (!response.ok) throw new Error("NEの商品ページの取得に失敗しました。接続を確認してください。");
  return parseNextEnginePageVisibility(payload, sku);
}
