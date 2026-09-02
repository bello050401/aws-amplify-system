import { calculateItemGrossProfit, type SalesSourceRecord } from "./sales";

/**
 * 売上集計の read model(2026-09-02 指示書§15〜§20)。
 *
 * 純粋関数のみ。DBアクセスは呼び出し側(scripts/rebuild-sales-aggregate.ts /
 * lib/inventory/salesAggregateStore.ts)の責務。
 *
 * ── なぜ絞り込みでは足りなかったのか(実測) ──────────────────────
 *
 *   在庫総数            5,313
 *   saleEndDate あり    4,511 (85%)
 *   全件のバイト        8,163KB
 *   売上ありのみ        7,056KB (14%しか減らない)
 *
 * 集計対象が母集団の85%を占めるので、「売れたものだけ引く」ではほとんど
 * 減らない。効くのは**集計そのものを事前に持つこと**。
 *
 * ── 派生データであることを守る ──────────────────────────────────
 *
 * 正本は今までどおり Inventory。この集計は**いつでも捨てて作り直せる**
 * 派生データで、以下を満たす:
 *
 *   ・二重計上しない  … 加算ではなく、対象月のレコードから毎回作り直す
 *   ・idempotent      … 同じ入力なら同じ結果。何度実行しても変わらない
 *   ・update/delete/取消に対応 … 再構築すれば消えたものは消えたまま反映
 *   ・rebuild可能     … それが唯一の更新手段
 *   ・drift検出可能   … 保存済みの値と、いま計算した値を突き合わせられる
 *
 * 「加算していく」設計にしなかったのは、加算はイベントを1つ取りこぼした
 * だけで静かにズレ、しかも**ズレたことに気づけない**から。作り直しなら
 * ズレようがないし、ズレていたら比較で分かる。
 */

/** 集計の1行。yearMonth は "2026-09" 形式。 */
export interface SalesMonthlyAggregateRow {
  yearMonth: string;
  count: number;
  totalSales: number;
  totalPurchase: number;
  totalShipping: number;
  totalCost: number;
  totalProfit: number;
}

export function formatYearMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function parseYearMonth(yearMonth: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

/**
 * saleEndDate から集計対象の年月を取り出す。
 *
 * `isInYearMonth` と**同じ判定**でなければならないので、あちらと同じく
 * 文字列の先頭7文字(YYYY-MM)だけを見る —— Date へ通すとタイムゾーンで
 * 1日ずれ、月境界の売上が隣の月へ移りうる。
 */
export function yearMonthOf(saleEndDate: string | null | undefined): string | null {
  if (!saleEndDate) return null;
  const m = /^(\d{4})-(\d{2})/.exec(saleEndDate.trim());
  return m ? `${m[1]}-${m[2]}` : null;
}

/**
 * 在庫レコードから月次集計を作り直す。
 *
 * 合計の出し方は summarizeSales と**同じ式**を使う。別の式を並行して
 * 持つと、いつか片方だけ直されて数字が食い違う。
 */
export function buildMonthlyAggregates(records: SalesSourceRecord[]): SalesMonthlyAggregateRow[] {
  const byMonth = new Map<string, SalesMonthlyAggregateRow>();

  for (const r of records) {
    const ym = yearMonthOf(r.saleEndDate);
    if (!ym) continue; // 販売終了日が無いものは集計対象外(既存の判定と同じ)

    let row = byMonth.get(ym);
    if (!row) {
      row = { yearMonth: ym, count: 0, totalSales: 0, totalPurchase: 0, totalShipping: 0, totalCost: 0, totalProfit: 0 };
      byMonth.set(ym, row);
    }
    row.count += 1;
    row.totalSales += r.salePrice ?? 0;
    row.totalPurchase += r.purchasePrice ?? 0;
    row.totalShipping += r.shippingCost ?? 0;
    // 原価 = purchasePrice のみ。shippingCost は加算しない
    // (sales.ts の totalCost のコメント参照 —— purchasePrice が
    //  既に送料込みの最終原価なので、足すと二重計上になる)。
    row.totalCost += r.purchasePrice ?? 0;
    row.totalProfit += calculateItemGrossProfit(r.salePrice, r.purchasePrice);
  }

  return [...byMonth.values()].sort((a, b) => (a.yearMonth < b.yearMonth ? -1 : 1));
}

export interface AggregateDrift {
  yearMonth: string;
  field: keyof SalesMonthlyAggregateRow;
  stored: number;
  recomputed: number;
}

/**
 * 保存済みの集計と、いま計算した集計を突き合わせる。
 *
 * 1円でも違えば drift として返す。「だいたい合っている」は無い ——
 * 売上の数字を近似しない、という要件そのもの。
 */
export function compareAggregates(
  stored: SalesMonthlyAggregateRow[],
  recomputed: SalesMonthlyAggregateRow[],
): AggregateDrift[] {
  const drift: AggregateDrift[] = [];
  const storedByMonth = new Map(stored.map((r) => [r.yearMonth, r]));
  const recomputedByMonth = new Map(recomputed.map((r) => [r.yearMonth, r]));
  const months = [...new Set([...storedByMonth.keys(), ...recomputedByMonth.keys()])].sort();

  const FIELDS: (keyof SalesMonthlyAggregateRow)[] = [
    "count",
    "totalSales",
    "totalPurchase",
    "totalShipping",
    "totalCost",
    "totalProfit",
  ];

  for (const ym of months) {
    const s = storedByMonth.get(ym);
    const r = recomputedByMonth.get(ym);
    for (const field of FIELDS) {
      const sv = s ? (s[field] as number) : 0;
      const rv = r ? (r[field] as number) : 0;
      if (sv !== rv) drift.push({ yearMonth: ym, field, stored: sv, recomputed: rv });
    }
  }
  return drift;
}

/**
 * 集計行から SalesSummary の合計部分を組み立てる。
 *
 * `items`(対象商品の一覧)は集計に含めない —— 一覧は月を開いたときに
 * だけ要るもので、集計へ抱えると行数ぶん際限なく膨らむ。
 */
export interface SalesTotals {
  year: number;
  month: number;
  count: number;
  totalSales: number;
  totalPurchase: number;
  totalShipping: number;
  totalCost: number;
  costRate: number;
  totalProfit: number;
  averageSalePrice: number;
}

export function totalsFromAggregate(row: SalesMonthlyAggregateRow | null, year: number, month: number): SalesTotals {
  const r = row ?? {
    yearMonth: formatYearMonth(year, month),
    count: 0,
    totalSales: 0,
    totalPurchase: 0,
    totalShipping: 0,
    totalCost: 0,
    totalProfit: 0,
  };
  return {
    year,
    month,
    count: r.count,
    totalSales: r.totalSales,
    totalPurchase: r.totalPurchase,
    totalShipping: r.totalShipping,
    totalCost: r.totalCost,
    // 率と平均は保存しない。保存すると丸めた値が正本になってしまうので、
    // 合計から毎回導く(summarizeSales と同じ式)。
    costRate: r.totalSales === 0 ? 0 : (r.totalCost / r.totalSales) * 100,
    totalProfit: r.totalProfit,
    averageSalePrice: r.count === 0 ? 0 : r.totalSales / r.count,
  };
}
