import "server-only";
import { listInventoryBySaleMonth } from "./queries";
import { formatYearMonth, totalsFromAggregate, type SalesTotals } from "./salesAggregate";
import { getMonthlyAggregates, type MonthlyAggregatesResult } from "./salesAggregateStore";
import { summarizeSales, shiftYearMonth, type SalesTargetItem } from "./sales";

/**
 * 売上画面が読むデータの入口(2026-09-02 指示書§20、2026-09-11 追加修正
 * 「開いたとき即表示する」、2026-09-11 世代整合性修正で
 * salesAggregateStore.ts の内部実装のみ差し替え)。
 *
 * ── 何が変わったか ─────────────────────────────────────────────
 *
 * 合計・推移(loadSalesSummary)と明細(loadSalesItems)を完全に分離した:
 *
 *   loadSalesSummary … SalesAggregateSnapshot への GetItem 1回のみ。
 *                       **どんな状態でもInventoryへは一切アクセスしない。**
 *                       集計がまだ無い/読めない月は、その場でInventoryへ
 *                       読みに行かず「未集計」「取得エラー」という状態を
 *                       返す(0円と混同させない)。
 *   loadSalesItems   … 対象商品一覧(明細)専用。呼び出し側
 *                       (SalesItemsSectionからのServer Action)が
 *                       ユーザーの明示的な操作(「明細を表示」)を受けて
 *                       初めて呼ぶ — ページの初期描画経路には含まれない。
 *
 * `getMonthlyAggregates`(lib/inventory/salesAggregateStore.ts)の外部
 * 契約({aggregates, failedMonths}を返す、例外を投げない)は変わって
 * いないため、このファイル自体には変更が無い——内部が月ごとの複数行
 * (SalesMonthlyAggregate)から単一スナップショット(SalesAggregateSnapshot)
 * へ置き換わったのは salesAggregateStore.ts 側だけの話(docs/
 * sales-aggregate-snapshot-consistency-20260911.md参照)。
 */

export type MonthAggregateStatus = "ok" | "missing" | "error";

/** 12ヶ月推移グラフの1点。status !== "ok" のとき totalSales/totalGrossProfit は 0 だが、これは「実績が0円」ではなく「値を持たない」ことを表す — 呼び出し側(SalesTrendChart)は必ずstatusを見て描き分ける。 */
export interface SalesTrendPoint {
  year: number;
  month: number;
  status: MonthAggregateStatus;
  totalSales: number;
  totalGrossProfit: number;
}

export interface SalesSummaryView {
  year: number;
  month: number;
  status: MonthAggregateStatus;
  /** status === "ok" のときだけ意味を持つ。missing/errorのときは0埋めのプレースホルダ(UIはstatusを見て"—"を出す)。 */
  totals: SalesTotals;
  /** 集計をいつ作り直したか。status === "ok" のときだけ入る。 */
  aggregateRebuiltAt: string | null;
  trend: SalesTrendPoint[];
}

function emptyTotals(year: number, month: number): SalesTotals {
  return totalsFromAggregate(null, year, month);
}

/**
 * 合計・12ヶ月推移。**Inventoryへは一切アクセスしない** — 集計テーブル
 * (SalesAggregateSnapshot)へのGetItem(1回)のみ。
 */
export async function loadSalesSummary(year: number, month: number): Promise<SalesSummaryView> {
  const months: { year: number; month: number }[] = [];
  for (let i = 11; i >= 0; i--) months.push(shiftYearMonth(year, month, -i));
  const keys = months.map((m) => formatYearMonth(m.year, m.month));

  const { aggregates, failedMonths } = await getMonthlyAggregates(keys).catch((err): MonthlyAggregatesResult => {
    // getMonthlyAggregates自体は例外を投げない設計だが、テーブル未
    // デプロイ等でモジュール読み込み自体が失敗するような想定外の
    // ケースに備え、呼び出し側でも黙って画面を落とさない。
    console.warn("[sales] 集計テーブルを読めませんでした(全月をerror扱い)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { aggregates: new Map(), failedMonths: keys };
  });
  const failedSet = new Set(failedMonths);

  const statusOf = (ym: string): MonthAggregateStatus => {
    if (aggregates.has(ym)) return "ok";
    if (failedSet.has(ym)) return "error";
    return "missing";
  };

  const trend: SalesTrendPoint[] = months.map((m) => {
    const ym = formatYearMonth(m.year, m.month);
    const agg = aggregates.get(ym);
    const status = statusOf(ym);
    return {
      year: m.year,
      month: m.month,
      status,
      totalSales: agg?.totalSales ?? 0,
      totalGrossProfit: agg?.totalProfit ?? 0,
    };
  });

  const currentKey = formatYearMonth(year, month);
  const currentAggregate = aggregates.get(currentKey) ?? null;
  const status = statusOf(currentKey);

  return {
    year,
    month,
    status,
    totals: currentAggregate ? totalsFromAggregate(currentAggregate, year, month) : emptyTotals(year, month),
    aggregateRebuiltAt: currentAggregate?.rebuiltAt ?? null,
    trend,
  };
}

/**
 * 対象商品一覧(明細)。合計と違って行数ぶん際限なく膨らむ実データな
 * ので集計には持てない——ここだけは在庫を読む
 * (listInventoryBySaleMonth、月フィルタ付き)。
 *
 * ページの初期描画からは呼ばない。ユーザーが明細を明示的に開いたとき
 * だけ、Server Action(app/actions/salesItems.ts)経由で呼ぶ。
 *
 * 集計の状態(ok/missing/error)には依存しない——明細は集計を経由せず、
 * 常に独立して在庫から取得できる(既存設計のまま)。取得に失敗したら
 * 例外をそのまま投げる(黙って0件にしない、呼び出し側=Server Actionが
 * 失敗として扱う)。
 */
export async function loadSalesItems(year: number, month: number): Promise<SalesTargetItem[]> {
  const records = await listInventoryBySaleMonth(year, month);
  return summarizeSales(records, year, month).items;
}
