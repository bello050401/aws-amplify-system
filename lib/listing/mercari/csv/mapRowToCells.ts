import type { MercariCsvRowFields } from "./types";

/** 論理フィールド(MercariCsvRowFields)を88列の順序に沿ったセル配列へ変換する。 */
export function mapRowToCells(fields: MercariCsvRowFields): string[] {
  const cells: string[] = [];

  for (let i = 0; i < 20; i++) {
    cells.push(fields.images[i] ?? "");
  }
  cells.push(fields.productName, fields.productDescription);

  // SKU1のみ使用(単一SKU商品のみ対象——複数SKUを1SKUへ潰さない方針の
  // ため、複数SKU商品は呼び出し側でそもそも対象外にする)。SKU2〜10は
  // 空欄のまま保持する。
  cells.push(
    fields.skuType ?? "",
    String(fields.quantity),
    fields.managementCode,
    fields.janCode ?? "",
    fields.catalogId ?? "",
  );
  for (let sku = 2; sku <= 10; sku++) {
    cells.push("", "", "", "", "");
  }

  cells.push(
    fields.brandId ?? "",
    String(fields.salePrice),
    fields.categoryId,
    String(fields.condition),
    String(fields.shippingMethod),
    fields.shippingOriginArea,
    String(fields.shippingDays),
    String(fields.productStatus),
    String(fields.shippingPayer),
    fields.shippingFeeId ?? "",
    // 83〜87列目(予約関連、未確認) — 通常商品では空欄。
    "",
    "",
    "",
    "",
    "",
    fields.bizCoolCategory != null ? String(fields.bizCoolCategory) : "",
  );

  return cells;
}
