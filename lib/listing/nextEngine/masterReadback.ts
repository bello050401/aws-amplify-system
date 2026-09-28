/** Confirm the exact private test SKU in the goods master after queue success. */
export type ExpectedPrivateMaster = { sku: string; title: string; supplierCode: string; cost: number; price: number };

export function parsePrivateMasterReadback(value: unknown, expected: ExpectedPrivateMaster) {
  const invalid = () => new Error("専用テスト商品の商品マスタ反映を確認できませんでした。");
  if (!/^[A-Za-z0-9-]{1,49}$/.test(expected.sku) || !value || typeof value !== "object") throw invalid();
  const payload = value as Record<string, unknown>;
  if (payload.result !== "success" || !Array.isArray(payload.data) || payload.data.length !== 1) throw invalid();
  const row = payload.data[0];
  if (!row || typeof row !== "object") throw invalid();
  const goods = row as Record<string, unknown>;
  if (goods.goods_id !== expected.sku || goods.goods_name !== expected.title ||
    goods.goods_supplier_id !== expected.supplierCode ||
    goods.goods_cost_price == null || Number(goods.goods_cost_price) !== expected.cost ||
    goods.goods_selling_price == null || Number(goods.goods_selling_price) !== expected.price) throw invalid();
  return { sku: expected.sku, state: "MASTER_CONFIRMED" as const, publicationConfirmed: false as const };
}
