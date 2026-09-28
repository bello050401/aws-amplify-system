import { parseGoodsUploadQueue } from "./uploadQueue";
import { assertNextEngineServerRuntime } from "./serverBoundary";
import { resolveNextEngineTokenRotation } from "./tokenRotation";

/** One read-only check per call. Caller schedules bounded checks; no blind upload retries. */
export async function checkGoodsUploadQueue(
  tokens: { accessToken: string; refreshToken: string },
  persistTokens: (tokens: { accessToken: string; refreshToken: string }) => Promise<void>,
  queueId: string, request: typeof fetch = fetch,
) {
  assertNextEngineServerRuntime();
  if (!tokens.accessToken?.trim() || !tokens.refreshToken?.trim()) throw new Error("ネクストエンジンの認証接続が必要です。");
  if (!/^[1-9][0-9]*$/.test(queueId)) throw new Error("有効な商品登録受付番号が必要です。");
  const body = new URLSearchParams({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken,
    fields: "que_id,que_method_name,que_status_id", "que_id-eq": queueId, offset: "0", limit: "2" });
  let payload: unknown;
  let httpOk = false;
  try {
    const response = await request("https://api.next-engine.org/api_v1_system_que/search", {
      method: "POST", body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    httpOk = response.ok;
    payload = await response.json();
  } catch {
    throw new Error("商品登録状況の確認に失敗しました。再送信せず、接続を確認してください。");
  }
  const rotated = resolveNextEngineTokenRotation(tokens, payload);
  if (rotated.rotated) {
    await persistTokens({ accessToken: rotated.accessToken, refreshToken: rotated.refreshToken });
  }
  if (!httpOk) throw new Error("商品登録状況の確認に失敗しました。再送信せず、接続を確認してください。");
  return parseGoodsUploadQueue(payload, queueId);
}
