/**
 * 売上集計(夜間開発指示書 §12)。純粋なロジックのみ — Amplify/Dataアク
 * セスは一切ない(server-onlyではない)。DBから在庫全件を取得するオー
 * ケストレーションはapp/inventory/(protected)/sales/page.tsxが
 * lib/inventory/queries.tsのlistAllInventoryを呼んで行う(そちらは
 * server-only)。この分離により集計ロジック単体をユニットテストしや
 * すい形に保つ。
 *
 * 集計基準は販売終了日(saleEndDate) — 指定年月に販売終了したInventory
 * を対象とする。空欄は対象外(spec: 「販売終了日空欄は対象外」)。
 */

export interface SalesTargetItem {
  id: string;
  displayId: string;
  sku: string;
  name: string;
  saleEndDate: string; // AWSDate "YYYY-MM-DD"
  salePrice: number | null;
  purchasePrice: number | null;
  shippingCost: number | null;
}

export interface SalesSummary {
  year: number;
  month: number; // 1-12
  count: number;
  /** 売上高 = 販売価格合計。 */
  totalSales: number;
  /** 購入金額 = 購入価格合計。 */
  totalPurchase: number;
  /** 送料 = 仕入送料合計。 */
  totalShipping: number;
  /** 原価 = 購入価格 + 送料。 */
  totalCost: number;
  /** 原価率(%) = 原価 ÷ 売上高 × 100。売上高が0の場合は0として安全に扱う(0除算しない)。 */
  costRate: number;
  /** 平均販売単価 = 売上高 ÷ 件数。件数が0の場合は0。 */
  averageSalePrice: number;
  items: SalesTargetItem[];
}

/** AWSDate("YYYY-MM-DD")の文字列が指定年月と一致するか。 */
export function isInYearMonth(dateStr: string | null | undefined, year: number, month: number): boolean {
  if (!dateStr) return false;
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(dateStr);
  if (!m) return false;
  return Number(m[1]) === year && Number(m[2]) === month;
}

export interface SalesSourceRecord {
  id: string;
  displayId: string;
  sku: string;
  name: string;
  saleEndDate: string | null;
  salePrice: number | null;
  purchasePrice: number | null;
  shippingCost: number | null;
}

/**
 * `records`は呼び出し側が在庫全件(現在ページだけではない — spec:
 * 「現在ページだけではなく、該当Inventory全件を集計してください」)を
 * 渡す前提。この関数自体はDBアクセスせず、渡された配列をフィルタ・集
 * 計するだけ。
 */
export function summarizeSales(records: SalesSourceRecord[], year: number, month: number): SalesSummary {
  const matched = records.filter((r) => isInYearMonth(r.saleEndDate, year, month));

  let totalSales = 0;
  let totalPurchase = 0;
  let totalShipping = 0;
  for (const r of matched) {
    totalSales += r.salePrice ?? 0;
    totalPurchase += r.purchasePrice ?? 0;
    totalShipping += r.shippingCost ?? 0;
  }
  const totalCost = totalPurchase + totalShipping;
  const costRate = totalSales === 0 ? 0 : (totalCost / totalSales) * 100;
  const averageSalePrice = matched.length === 0 ? 0 : totalSales / matched.length;

  return {
    year,
    month,
    count: matched.length,
    totalSales,
    totalPurchase,
    totalShipping,
    totalCost,
    costRate,
    averageSalePrice,
    items: matched.map((r) => ({
      id: r.id,
      displayId: r.displayId,
      sku: r.sku,
      name: r.name,
      saleEndDate: r.saleEndDate ?? "",
      salePrice: r.salePrice,
      purchasePrice: r.purchasePrice,
      shippingCost: r.shippingCost,
    })),
  };
}

/** year/monthの安全な加減算(月の繰り上がり/繰り下がりで年をまたぐ)。 */
export function shiftYearMonth(year: number, month: number, deltaMonths: number): { year: number; month: number } {
  const zeroBased = (year * 12 + (month - 1)) + deltaMonths;
  const nextYear = Math.floor(zeroBased / 12);
  const nextMonth = (zeroBased % 12) + 1;
  return { year: nextYear, month: nextMonth };
}
