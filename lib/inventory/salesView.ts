import "server-only";
import { listAllInventory, listInventoryBySaleMonth } from "./queries";
import { formatYearMonth, totalsFromAggregate, type SalesTotals } from "./salesAggregate";
import { getMonthlyAggregates, type StoredAggregate } from "./salesAggregateStore";
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

  // 2026-09-09 追加指示(§5 速度): 集計テーブル(SalesMonthlyAggregate)の
  // GetItemと、明細(Inventoryのその月ぶん)の読み取りは別テーブル・
  // 互いに依存しない読み取りなので、直列awaitを並列化する。エラー処理は
  // 従来どおり集計側だけに掛ける(明細取得が失敗した場合は例外がそのまま
  // 呼び出し元へ伝播する、という挙動も変えない)。
  const [aggregates, monthRecords] = await Promise.all([
    getMonthlyAggregates(keys).catch((err) => {
      // 集計テーブルがまだデプロイされていない/読めない場合も、画面は
      // 従来どおり出さなければならない。黙って0にしない。
      console.warn("[sales] 集計テーブルを読めなかったため、その場で計算します", {
        error: err instanceof Error ? err.message : String(err),
      });
      return new Map<string, StoredAggregate>();
    }),
    // 明細(その月に売れた商品の一覧)は集計に持てないので在庫を読む。
    // ただし**その月のぶんだけ**。以前はここで全件(5,313件)読んでいた。
    listInventoryBySaleMonth(year, month),
  ]);

  const currentKey = formatYearMonth(year, month);
  const currentAggregate = aggregates.get(currentKey) ?? null;

  const live = summarizeSales(monthRecords, year, month);

  if (!currentAggregate) {
    // 当月の集計が無い場合。合計と明細は monthRecords から正しく出せる
    // が、12ヶ月推移だけは他の月のデータが要る。集計がある月はそれを
    // 使い、無い月だけ全件走査へ落ちる —— 「集計が無いから0円」には
    // 絶対にしない。
    //
    // 当月ぶんは上ですでに monthRecords を取得・集計済み(= live)なので、
    // 走査要否の判定(と、実際の推移値の穴埋め)からは当月を除く ——
    // 除かないと「当月の集計だけ無い」というごく普通のケース(集計バッチ
    // はまだ回っていない)でも毎回、全在庫(5,313件)を余分に読みに行って
    // しまう(当月分は live で足りているのに)。過去月にも集計欠損が
    // 残っている場合だけ、その埋め合わせとして全件走査へ落ちる。
    const missingTrendMonths = months.filter(
      (m) => (m.year !== year || m.month !== month) && !aggregates.has(formatYearMonth(m.year, m.month)),
    );
    const allRecords = missingTrendMonths.length > 0 ? await listAllInventory() : [];
    return {
      summary: live,
      trend: months.map((m) => {
        if (m.year === year && m.month === month) {
          return { year: m.year, month: m.month, totalSales: live.totalSales, totalGrossProfit: live.totalProfit };
        }
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
  //
  // 2026-09-10 追加修正(§速度): 以前はここを Promise.all で「月ごとに
  // listInventoryBySaleMonth(=在庫全件Scan)を個別に呼ぶ」形にしていた
  // ——集計テーブルの再構築バッチがまだ追いついておらず、推移対象の
  // 12ヶ月のうち複数が集計欠損だと、**欠損月の数だけ在庫全件Scanが
  // 並列で走る**(5,313件 × 欠損月数、同期中にDynamoDBの
  // 負荷が重なる可能性がある。実エラーとの因果は未確認)。
  // 上の「当月の集計が無い」分岐(2abfc95で先に直した側)と同じ考え方
  // ——欠損月が1つでもあれば listAllInventory を1回だけ呼び、その1回の
  // 結果から欠損月ぶんをまとめて計算する。DBへの往復も転送量も
  // 「欠損月の数」に比例しなくなる(常に高々1回)。並列awaitが不要に
  // なったため同期のPromise.allも外した。
  const missingPastMonths = months.filter((m) => !aggregates.has(formatYearMonth(m.year, m.month)));
  const allRecordsForTrend = missingPastMonths.length > 0 ? await listAllInventory() : [];
  const trend: MonthlyTrendPoint[] = months.map((m) => {
    const agg = aggregates.get(formatYearMonth(m.year, m.month));
    if (agg) return { year: m.year, month: m.month, totalSales: agg.totalSales, totalGrossProfit: agg.totalProfit };
    const one = summarizeSales(allRecordsForTrend, m.year, m.month);
    return { year: m.year, month: m.month, totalSales: one.totalSales, totalGrossProfit: one.totalProfit };
  });

  return { summary, trend, servedFromAggregate: true, aggregateRebuiltAt: currentAggregate.rebuiltAt };
}

