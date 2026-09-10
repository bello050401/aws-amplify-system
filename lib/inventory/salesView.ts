import "server-only";
import { listAllInventory, listInventoryBySaleMonth, type InventorySearchRecord } from "./queries";
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
  // GetItemは、明細(Inventory)の読み取りとは別テーブル・互いに依存し
  // ない読み取り。ただし2026-09-10 追加修正(§速度、下のコメント参照)で
  // 「明細読み取りのどちらを呼ぶか」自体が集計の結果に依存するように
  // なったため、ここは先に集計だけを待つ(集計はyearMonthを主キーに
  // した点読みGetItem×12で、在庫Scanより桁違いに軽い)。
  const aggregates = await getMonthlyAggregates(keys).catch((err) => {
    // 集計テーブルがまだデプロイされていない/読めない場合も、画面は
    // 従来どおり出さなければならない。黙って0にしない。
    console.warn("[sales] 集計テーブルを読めなかったため、その場で計算します", {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map<string, StoredAggregate>();
  });

  const currentKey = formatYearMonth(year, month);
  const currentAggregate = aggregates.get(currentKey) ?? null;

  // 過去月(当月を除く)に集計欠損が残っているか。残っていれば、その
  // 埋め合わせとして在庫全件走査(listAllInventory)がどのみち必要になる
  // ——当月の集計が有る/無いに関わらない(推移12ヶ月ぶんの判定なので)。
  const missingPastMonths = months.filter(
    (m) => (m.year !== year || m.month !== month) && !aggregates.has(formatYearMonth(m.year, m.month)),
  );
  const needsFullScan = missingPastMonths.length > 0;

  // 2026-09-10 追加修正(§速度、当月欠損時の重複Scan): 以前はここで
  // 「明細(その月に売れた商品の一覧、listInventoryBySaleMonth)」を
  // 常に無条件で呼んだうえで、過去月の集計欠損があれば別途
  // listAllInventory も呼んでいた。しかし lib/inventory/queries.ts の
  // listInventoryBySaleMonth 自身のコメントにある通り、DynamoDBは
  // フィルタを適用する前に行を読むため「月で絞っても往復回数は
  // listAllInventory と同じ」——つまり過去月にも欠損があるケースでは、
  // 実質「全件相当のScan」を同じリクエスト内で二重に(月フィルタ付き
  // 1回+フィルタ無し1回)行っていた。
  //
  // 全件走査がどのみち必要(needsFullScan)なら、その1回の結果を明細にも
  // 転用する(summarizeSalesは受け取った配列を年月でさらに絞り込むので、
  // 全件を渡しても月フィルタ付きの結果と同じ値になる) —— 全件走査が
  // 不要なとき(推移12ヶ月すべて集計がそろっている)だけ、従来どおり
  // 月フィルタ付きの1回で済ませる。どちらの分岐でも在庫の読み取りは
  // 高々1回。
  let allRecords: InventorySearchRecord[] = [];
  let monthRecords: InventorySearchRecord[];
  if (needsFullScan) {
    allRecords = await listAllInventory();
    monthRecords = allRecords;
  } else {
    // 明細(その月に売れた商品の一覧)は集計に持てないので在庫を読む。
    // ただし**その月のぶんだけ**。以前はここで全件(5,313件)読んでいた。
    monthRecords = await listInventoryBySaleMonth(year, month);
  }

  const live = summarizeSales(monthRecords, year, month);

  if (!currentAggregate) {
    // 当月の集計が無い場合。合計と明細は monthRecords(または全件走査の
    // 結果)から正しく出せる。12ヶ月推移は、集計がある月はそれを使い、
    // 無い月(=missingPastMonths、上ですでに全件走査済み)だけ
    // allRecords から実数を埋める —— 「集計が無いから0円」には絶対に
    // しない。
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

  // 推移。集計が無い月(= missingPastMonths、上ですでに全件走査済みか
  // どうかが決まっている)だけ、allRecords から引いて埋める(0で埋め
  // ない)。過去に欠損月が何ヶ月あっても、在庫の読み取りは上の1回のみ。
  const trend: MonthlyTrendPoint[] = months.map((m) => {
    const agg = aggregates.get(formatYearMonth(m.year, m.month));
    if (agg) return { year: m.year, month: m.month, totalSales: agg.totalSales, totalGrossProfit: agg.totalProfit };
    const one = summarizeSales(allRecords, m.year, m.month);
    return { year: m.year, month: m.month, totalSales: one.totalSales, totalGrossProfit: one.totalProfit };
  });

  return { summary, trend, servedFromAggregate: true, aggregateRebuiltAt: currentAggregate.rebuiltAt };
}

