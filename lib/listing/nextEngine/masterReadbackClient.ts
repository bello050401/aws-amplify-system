import { parsePrivateMasterReadback, type ExpectedPrivateMaster } from "./masterReadback";
import { isReservedNextEngineTestCode } from "./privateTestPolicy";
import { assertNextEngineServerRuntime } from "./serverBoundary";
import { resolveNextEngineTokenRotation } from "./tokenRotation";

/** One read-only exact-SKU check; never interprets master presence as mall publication. */
export async function confirmPrivateTestMaster(
  tokens: { accessToken: string; refreshToken: string },
  persistTokens: (tokens: { accessToken: string; refreshToken: string }) => Promise<void>,
  expected: ExpectedPrivateMaster, request: typeof fetch = fetch,
) {
  assertNextEngineServerRuntime();
  if (!isReservedNextEngineTestCode(expected.sku)) throw new Error("専用テスト商品コードが必要です。");
  if (!tokens.accessToken?.trim() || !tokens.refreshToken?.trim()) throw new Error("ネクストエンジンの認証接続が必要です。");
  const body = new URLSearchParams({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken,
    fields: "goods_id,goods_name,goods_supplier_id,goods_cost_price,goods_selling_price", "goods_id-eq": expected.sku, offset: "0", limit: "2" });
  let payload: unknown;
  let httpOk = false;
  try {
    const response = await request("https://api.next-engine.org/api_v1_master_goods/search", {
      method: "POST", body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    httpOk = response.ok;
    payload = await response.json();
  } catch {
    throw new Error("商品マスタの確認に失敗しました。接続を確認してください。");
  }
  const rotated = resolveNextEngineTokenRotation(tokens, payload);
  if (rotated.rotated) {
    try {
      await persistTokens({ accessToken: rotated.accessToken, refreshToken: rotated.refreshToken });
    } catch {
      throw new Error("認証情報を安全に保存できませんでした。接続を確認してください。");
    }
  }
  if (!httpOk) throw new Error("商品マスタの確認に失敗しました。接続を確認してください。");
  return parsePrivateMasterReadback(payload, expected);
}
