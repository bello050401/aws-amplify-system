import { assertPrivateTestPage } from "./privateTestPolicy";

/** Read-only official page search. Never uploads or publishes a product. */
export async function verifyNextEnginePrivateTestPage(
  accessToken: string,
  testCode: string,
  request: typeof fetch = fetch,
): Promise<{ productCode: string; visibility: "PRIVATE" }> {
  if (!accessToken.trim()) throw new Error("ネクストエンジンの認証接続が必要です。");
  if (!/^BELLO-NE-TEST-[A-Za-z0-9_-]+$/.test(testCode)) throw new Error("専用テスト商品コードが必要です。");
  const body = new URLSearchParams({
    access_token: accessToken,
    fields: "goods_page_goods_code,goods_page_display_flag",
    "goods_page_goods_code-eq": testCode,
    offset: "0", limit: "2",
  });
  let result: unknown;
  try {
    const response = await request("https://api.next-engine.org/api_v1_master_goods_page/search", {
      method: "POST", body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error("HTTP failure");
    result = await response.json();
  } catch {
    // JSON/network errors can contain response fragments. Never expose them.
    throw new Error("ネクストエンジンの商品ページ確認に失敗しました。認証と接続を確認してください。");
  }
  if (!result || typeof result !== "object") throw new Error("商品ページ確認の応答が不正です。");
  const payload = result as { result?: unknown; data?: unknown };
  // Do not return raw errors/tokens. An expired token requires normal reconnection.
  if (payload.result !== "success" || !Array.isArray(payload.data) || payload.data.length !== 1)
    throw new Error("非公開の専用テスト商品を一意に確認できませんでした。");
  const page: unknown = payload.data[0];
  if (!page || typeof page !== "object") throw new Error("商品ページの形式が不正です。");
  const record = page as Record<string, unknown>;
  assertPrivateTestPage({ goods_page_goods_code: record.goods_page_goods_code, goods_page_display_flag: record.goods_page_display_flag }, testCode);
  return { productCode: testCode, visibility: "PRIVATE" };
}
