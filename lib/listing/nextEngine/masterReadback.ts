/** Confirm the exact private test SKU in the goods master after queue success. */
export function parsePrivateMasterReadback(value: unknown, sku: string) {
  const invalid = () => new Error("専用テスト商品の商品マスタ反映を確認できませんでした。");
  if (!/^[A-Za-z0-9-]{1,49}$/.test(sku) || !value || typeof value !== "object") throw invalid();
  const payload = value as Record<string, unknown>;
  if (payload.result !== "success" || !Array.isArray(payload.data) || payload.data.length !== 1) throw invalid();
  const row = payload.data[0];
  if (!row || typeof row !== "object") throw invalid();
  const goods = row as Record<string, unknown>;
  if (goods.goods_id !== sku || typeof goods.goods_name !== "string" || !goods.goods_name.trim()) throw invalid();
  return { sku, state: "MASTER_CONFIRMED" as const, publicationConfirmed: false as const };
}
