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
  /**
   * 購入金額 = purchasePrice合計。追加修正指示により、purchasePriceは
   * 「送料等の諸経費込みの最終原価」を直接入力する運用へ統一された
   * ため、原価(totalCost)そのものと同じ値になる —
   * 詳しくはtotalCost/totalShippingのコメント参照。
   */
  totalPurchase: number;
  /**
   * 送料 = shippingCost合計。今後の新規レコードはshippingCostへ値を
   * 入力しない運用(extendedFields.tsで入力欄自体を撤去済み)のため、
   * 新規データでは常に0になる。過去データの送料実績を参照用として
   * 残しているだけで、**原価(totalCost)・利益(totalProfit)の計算には
   * 一切使わない**(shippingCostをpurchasePriceへ加算すると、
   * purchasePrice自体が既に送料込みの最終原価であるレコードで二重計上
   * になってしまうため)。
   */
  totalShipping: number;
  /**
   * 原価 = purchasePrice合計(totalPurchaseと同じ値)。
   *
   * 【重要・追加修正指示】purchasePriceは「商品購入代金+送料+その他
   * 仕入れに伴う費用」をすべて含めた最終原価として直接入力する運用に
   * 統一されたため、原価 = purchasePriceが正しい基本ルールであり、
   * shippingCostを重ねて加算してはいけない(過去に
   * `totalPurchase + totalShipping`だった旧ロジックは、purchasePrice
   * とは別に送料を入力していた旧運用でのみ正しく、新運用のレコードに
   * 適用すると送料が二重計上されてしまうため撤廃した)。
   */
  totalCost: number;
  /** 原価率(%) = 原価 ÷ 売上高 × 100。売上高が0の場合は0として安全に扱う(0除算しない)。 */
  costRate: number;
  /** 利益 = 売上高 − 原価(= totalSales − totalCost、totalCost = totalPurchaseのため実質 売上高 − purchasePrice合計)。 */
  totalProfit: number;
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
  // 【重要】原価 = purchasePrice合計のみ。shippingCostは加算しない
  // (二重計上防止 — 上のtotalCostのコメント参照)。totalShippingは
  // 過去データの参照用としてSalesSummaryへ残すが、原価・利益の計算式
  // には一切使わない。
  const totalCost = totalPurchase;
  const costRate = totalSales === 0 ? 0 : (totalCost / totalSales) * 100;
  const totalProfit = totalSales - totalCost;
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
    totalProfit,
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

/**
 * 今月の売上着地予測(追加修正指示 §3-§8)。
 *
 * サーバーの実行タイムゾーン(AWS/Amplify Hostingは通常UTC)に一切依存
 * せず、常にJST(Asia/Tokyo)を基準に「今日は何年何月何日か」を求める
 * (§5: 「UTCとJSTのズレにより、夜間~早朝に日付がずれて着地予測が変わ
 * ってしまう」ことを防ぐ)。Intl.DateTimeFormatのtimeZone指定は
 * Node.js標準のICUデータで動作するため、追加の日付ライブラリ導入は
 * 不要。
 */
export interface JstDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

/** `referenceDate`(既定: 現在時刻)をJSTのカレンダー日付に変換する。 */
export function nowInJst(referenceDate: Date = new Date()): JstDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(referenceDate);
  const get = (type: "year" | "month" | "day") => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/**
 * 指定年月の実際の日数(28/29/30/31)。固定値(30等)は一切使わず(§4:
 * 「平均売上×30のような固定値計算は禁止」)、「その月の翌月の0日目 =
 * 当月の末日」というDate仕様を利用して求める — 閏年の2月29日も
 * new Date自身が判定するため、閏年判定を自前で書く必要がない。
 * UTC基準(Date.UTC)で計算しており、「ある年月の末日が何日か」という
 * 問いはタイムゾーンに依存しない値なので、これ自体にJST変換は不要
 * (JST変換が必要なのは「今日は何月何日か」という現在時刻依存の部分
 * だけ — nowInJst側で行っている)。
 */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 指定年月がJSTで見た「現在進行中の月」かどうか(§7: 過去の確定月は着地予測の対象外とするための判定)。 */
export function isCurrentJstYearMonth(year: number, month: number, referenceDate: Date = new Date()): boolean {
  const jstNow = nowInJst(referenceDate);
  return jstNow.year === year && jstNow.month === month;
}

export interface SalesForecast {
  year: number;
  month: number;
  /** JSTでの「今日」の日(1-31) — 経過日数の算出根拠。 */
  today: number;
  /** 当月の総日数(28〜31、閏年2月は29)。 */
  totalDaysInMonth: number;
  /** 経過日数(月初1日から今日まで、§5: 8/1→1, 8/29→29)。0除算防止のため最低1にクランプする。 */
  elapsedDays: number;
  /** 1日あたり平均売上 = 当月累計売上 ÷ 経過日数。 */
  averageDailySales: number;
  /** 今月の売上着地予測 = 1日あたり平均売上 × 当月の総日数。 */
  projectedMonthEndSales: number;
}

/**
 * 今月の売上着地予測を計算する(§3の計算式そのもの)。
 *
 *   1日あたり平均売上 = 当月累計売上(totalSales) ÷ 経過日数
 *   今月の売上着地予測 = 1日あたり平均売上 × 当月の総日数
 *
 * 呼び出し側は、表示対象の年月が実際に「JSTで見た現在進行中の月」であ
 * る場合にのみこの関数を呼ぶ(isCurrentJstYearMonthで判定) — 過去の確
 * 定月に対して呼んでも数値としては計算できてしまうが、意味を持たない
 * ため(§7)、この関数自体はその判定を行わず呼び出し側の責務とする。
 *
 * 0円運用でも安全(§8): totalSalesが0なら平均・着地予測とも0を返す。
 * elapsedDaysは1〜当月日数の範囲にクランプするため、todayDayにどんな
 * 値が渡ってもNaN/Infinity/0除算が発生することはない。
 */
export function calculateMonthEndForecast(totalSales: number, year: number, month: number, todayDay: number): SalesForecast {
  const totalDaysInMonth = daysInMonth(year, month);
  const elapsedDays = Math.min(Math.max(Math.trunc(todayDay) || 1, 1), totalDaysInMonth);
  const averageDailySales = totalSales === 0 ? 0 : totalSales / elapsedDays;
  const projectedMonthEndSales = totalSales === 0 ? 0 : averageDailySales * totalDaysInMonth;
  return { year, month, today: todayDay, totalDaysInMonth, elapsedDays, averageDailySales, projectedMonthEndSales };
}
