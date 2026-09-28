import { parseNextEngineUploadReceipt } from "./uploadReceipt";
import { prepareNextEngineProduct, type NextEnginePreparation } from "./preparation";
import { assertNextEngineServerRuntime } from "./serverBoundary";
import { resolveNextEngineTokenRotation } from "./tokenRotation";

const CSV_HEADER = "syohin_code,sire_code,syohin_name,baika_tnk,syohin_setumei_text\r\n";
const QUOTED_FIELD = '"(?:[^"]|"")*"';
const SINGLE_ROW = new RegExp(`^(${QUOTED_FIELD}),(${QUOTED_FIELD}),(${QUOTED_FIELD}),(${QUOTED_FIELD}),(${QUOTED_FIELD})\\r\\n$`);
const unquote = (field: string) => field.slice(1, -1).replace(/""/g, '"');

function assertCanonicalPrivateCsv(csv: string, testCode: string): void {
  if (!csv.startsWith(CSV_HEADER)) throw new Error("専用テスト商品のCSVではありません。");
  const match = SINGLE_ROW.exec(csv.slice(CSV_HEADER.length));
  if (!match) throw new Error("専用テスト商品のCSVではありません。");
  const [sku, supplierCode, title, priceText, description] = match.slice(1).map(unquote);
  if (sku !== testCode) throw new Error("専用テスト商品のCSVではありません。");
  try {
    const canonical = prepareNextEngineProduct({ sku, supplierCode, title, price: Number(priceText), description });
    if (canonical.csv !== csv) throw new Error("noncanonical");
  } catch {
    throw new Error("専用テスト商品のCSVではありません。");
  }
}

/** Upload only an explicitly reserved test SKU. A receipt is not a listing. */
export async function enqueuePrivateTestMaster(
  tokens: { accessToken: string; refreshToken: string },
  persistTokens: (tokens: { accessToken: string; refreshToken: string }) => Promise<void>,
  testCode: string, reservedCode: string,
  prepared: NextEnginePreparation, request: typeof fetch = fetch,
) {
  assertNextEngineServerRuntime();
  if (!tokens.accessToken?.trim() || !tokens.refreshToken?.trim()) throw new Error("ネクストエンジンの認証接続が必要です。");
  if (!/^BELLO-NE-TEST-[A-Za-z0-9_-]+$/.test(reservedCode) || testCode !== reservedCode)
    throw new Error("予約した専用テスト商品と一致しないため送信しません。");
  if (prepared.publicationState !== "NOT_PUBLISHED" || prepared.endpoint !== "/api_v1_master_goods/upload")
    throw new Error("商品登録の送信内容が不正です。");
  assertCanonicalPrivateCsv(prepared.csv, testCode);
  let payload: unknown;
  let httpOk = false;
  try {
    const response = await request("https://api.next-engine.org/api_v1_master_goods/upload", {
      method: "POST", body: new URLSearchParams({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken, data_type: "csv", data: prepared.csv }),
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    httpOk = response.ok;
    payload = await response.json();
  } catch {
    // Timeout is ambiguous: the server may have queued the upload. Never retry automatically.
    throw new Error("登録受付を確認できません。再送信せず、ネクストエンジンの登録状況を確認してください。");
  }
  // Next Engine may rotate tokens even when the API reports an error. Store the
  // complete pair before interpreting the upload result or making another call.
  const rotated = resolveNextEngineTokenRotation(tokens, payload);
  if (rotated.rotated) {
    await persistTokens({ accessToken: rotated.accessToken, refreshToken: rotated.refreshToken });
  }
  if (!httpOk) throw new Error("ネクストエンジンの商品登録に失敗しました。登録状況を確認してください。");
  return parseNextEngineUploadReceipt(payload);
}
