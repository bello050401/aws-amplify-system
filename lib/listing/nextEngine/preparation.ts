/** Next Engine product-master upload preparation. This does not publish a mall listing.
 * https://developer.next-engine.com/api/api_v1_master_goods/upload/
 */
export type NextEngineProductInput = {
  sku: string;
  title: string;
  description: string;
  price: number;
  supplierCode: string;
};

export type NextEnginePreparation = {
  csv: string;
  endpoint: "/api_v1_master_goods/upload";
  publicationState: "NOT_PUBLISHED";
  requiredSteps: readonly string[];
};

const quote = (value: string | number): string => `"${String(value).replace(/"/g, '""')}"`;
const length = (value: string): number => Array.from(value).length;

export function prepareNextEngineProduct(input: NextEngineProductInput): NextEnginePreparation {
  if (!/^[A-Za-z0-9_-]{1,49}$/.test(input.sku)) throw new Error("商品コードは49文字以内の英数字・ハイフン・アンダーバーで指定してください。");
  const title = input.title.trim();
  const description = input.description.replace(/\r\n?/g, "\n").trim();
  if (!title || length(title) > 130) throw new Error("メルカリShops用商品名は130文字以内で指定してください。");
  if (!description || length(description) > 3000) throw new Error("メルカリShops用商品説明は3000文字以内で指定してください。");
  if (!Number.isSafeInteger(input.price) || input.price < 300 || input.price > 9_999_999)
    throw new Error("販売価格は300〜9,999,999円の整数で指定してください。");
  if (!/^[A-Za-z0-9_-]+$/.test(input.supplierCode)) throw new Error("ネクストエンジンに登録した仕入先コードを指定してください。");
  // Never set stock, listing tags, visibility or publication state by implication.
  // The supplier must be selected from this company's real master, never guessed.
  const header = ["syohin_code", "sire_code", "syohin_name", "baika_tnk", "syohin_setumei_text"];
  const values = [input.sku, input.supplierCode, title, input.price, description];
  return {
    csv: header.join(",") + "\r\n" + values.map(quote).join(",") + "\r\n",
    endpoint: "/api_v1_master_goods/upload",
    publicationState: "NOT_PUBLISHED",
    requiredSteps: ["商品マスタのアップロード結果確認", "ページ情報・画像分類タグの登録", "メルカリShops連携設定", "新規出品操作と結果確認"],
  };
}
