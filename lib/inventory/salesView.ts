import "server-only";
import { listAllInventory, listInventoryBySaleMonth } from "./queries";
import { formatYearMonth, totalsFromAggregate, type SalesTotals } from "./salesAggregate";
import { getMonthlyAggregates } from "./salesAggregateStore";
import { summarizeSales, shiftYearMonth, type MonthlyTrendPoint, type SalesSummary } from "./sales";

/**
 * 売上画面が読むデータの入口(2026-09-02 指示書§20)。
 *
 * ── 何が変わったか ──────────────────────────────────────────────
 *
 * 以前はこの画面を開くたびに在庫を全件読み(5,313件・8,163KB)、その場で
 * 集計し、さらに12ヶ月ぶん同じ配列を12回走査していた。集計対象が母集団の
 * 85%を占めるため、絞り込みでは14%しか減らない(実測)。
 *
 * いまは合計と推移を月次集計(read model)から読む:
 *
 *   当月の合計   … GetItem 1回
 *   12ヶ月推移   … GetItem 12回
 *
 * 実測で 5,313件 / 1,546KB → 13件 / 1.6KB。
 *
 * ── 対象商品の一覧について ──────────────────────────────────────
 *
 * 画面下部の「その月に売れた商品の一覧」は、合計と違って**明細そのもの**
 * なので集計には持てない(行数ぶん際限なく膨らむ)。ここだけは在庫を読む。
 * ただし検索projectionが効くので、以前より転送量は小さい。
 *
 * ── 集計が無い/古い場合 ─────────────────────────────────────────
 *
 * 集計が見つからない月は**その場で計算する**。「集計がまだ無いので0円です」
 * と表示するのが最悪 —— 売上が消えたように見える。数字は必ず正しく、
 * 遅いか速いかだけが変わる、という形にしてある。
 */

export interface SalesViewData {
  summary: SalesSummary;
  trend: MonthlyTrendPoint[];
  /** 合計を集計テーブルから取れたか。falseならその場で計算した。 */
  servedFromAggregate: boolean;
  /** 集計をいつ作り直したか(画面に「○○時点」と出すため)。 */
  aggregateRebuiltAt: string | null;
}

export async function loadSalesView(year: number, month: number): Promise<SalesViewData> {
  const months: { year: number; month: number }[] = [];
  for (let i = 11; i >= 0; i--) months.push(shiftYearMonth(year, month, -i));
  const keys = months.map((m) => formatYearMonth(m.year, m.month));

  let aggregates: Awaited<ReturnType<typeof getMonthlyAggregates>>;
  try {
    aggregates = await getMonthlyAggregates(keys);
  } catch (err) {
    // 集計テーブルがまだデプロイされていない/読めない場合も、画面は
    // 従来どおり出さなければならない。黙って0にしない。
    console.warn("[sales] 集計テーブルを読めなかったため、その場で計算します", {
      error: err instanceof Error ? err.message : String(err),
    });
    aggregates = new Map();
  }

  const currentKey = formatYearMonth(year, month);
  const currentAggregate = aggregates.get(currentKey) ?? null;

  // 明細(その月に売れた商品の一覧)は集計に持てないので在庫を読む。
  // ただし**その月のぶんだけ**。以前はここで全件(5,313件)読んでいた。
  const monthRecords = await listInventoryBySaleMonth(year, month);
  const live = summarizeSales(monthRecords, year, month);

  if (!currentAggregate) {
    // 当月の集計が無い場合。合計と明細は monthRecords から正しく出せる
    // が、12ヶ月推移だけは他の月のデータが要る。集計がある月はそれを
    // 使い、無い月だけ全件走査へ落ちる —— 「集計が無いから0円」には
    // 絶対にしない。
    const missingTrendMonths = months.filter((m) => !aggregates.has(formatYearMonth(m.year, m.month)));
    const allRecords = missingTrendMonths.length > 0 ? await listAllInventory() : [];
    return {
      summary: live,
      trend: months.map((m) => {
        const agg = aggregates.get(formatYearMonth(m.year, m.month));
        if (agg) return { year: m.year, month: m.month, totalSales: agg.totalSales, totalGrossProfit: agg.totalProfit };
        const one = summarizeSales(allRecords, m.year, m.month);
        return { year: m.year, month: m.month, totalSales: one.totalSales, totalGrossProfit: one.totalProfit };
      }),
      servedFromAggregate: false,
      aggregateRebuiltAt: null,
    };
  }

  const totals: SalesTotals = totalsFromAggregate(currentAggregate, year, month);
  const summary: SalesSummary = {
    ...totals,
    // 明細は在庫から。合計は集計から。両者が食い違っていたら集計が古い
    // ということなので、その事実を隠さず servedFromAggregate と
    // aggregateRebuiltAt で画面へ出す。
    items: live.items,
  };

  // 推移。集計が無い月だけ、その月ぶんを引いて埋める(0で埋めない)。
  const trend: MonthlyTrendPoint[] = await Promise.all(
    months.map(async (m) => {
      const agg = aggregates.get(formatYearMonth(m.year, m.month));
      if (agg) return { year: m.year, month: m.month, totalSales: agg.totalSales, totalGrossProfit: agg.totalProfit };
      const one = summarizeSales(await listInventoryBySaleMonth(m.year, m.month), m.year, m.month);
      return { year: m.year, month: m.month, totalSales: one.totalSales, totalGrossProfit: one.totalProfit };
    }),
  );

  return { summary, trend, servedFromAggregate: true, aggregateRebuiltAt: currentAggregate.rebuiltAt };
}
