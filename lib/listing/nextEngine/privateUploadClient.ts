import { parseNextEngineUploadReceipt } from "./uploadReceipt";
import type { NextEnginePreparation } from "./preparation";

/** Upload only an explicitly reserved test SKU. A receipt is not a listing. */
export async function enqueuePrivateTestMaster(
  accessToken: string, testCode: string, reservedCode: string,
  prepared: NextEnginePreparation, request: typeof fetch = fetch,
) {
  if (!accessToken.trim()) throw new Error("ネクストエンジンの認証接続が必要です。");
  if (!/^BELLO-NE-TEST-[A-Za-z0-9_-]+$/.test(reservedCode) || testCode !== reservedCode)
    throw new Error("予約した専用テスト商品と一致しないため送信しません。");
  if (prepared.publicationState !== "NOT_PUBLISHED" || prepared.endpoint !== "/api_v1_master_goods/upload")
    throw new Error("商品登録の送信内容が不正です。");
  const rows = prepared.csv.split("\r\n").filter(Boolean);
  if (rows.length !== 2 || !rows[1].startsWith(`"${testCode}",`))
    throw new Error("専用テスト商品のCSVではありません。");
  let payload: unknown;
  try {
    const response = await request("https://api.next-engine.org/api_v1_master_goods/upload", {
      method: "POST", body: new URLSearchParams({ access_token: accessToken, data_type: "csv", data: prepared.csv }),
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error("HTTP failure");
    payload = await response.json();
  } catch {
    // Timeout is ambiguous: the server may have queued the upload. Never retry automatically.
    throw new Error("登録受付を確認できません。再送信せず、ネクストエンジンの登録状況を確認してください。");
  }
  return parseNextEngineUploadReceipt(payload);
}
