import type {SalesTotals} from "./salesAggregate";
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

