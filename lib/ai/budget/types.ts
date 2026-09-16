import type { Schema } from "@/amplify/data/resource";

/**
 * AI利用予算の予約台帳(2026-09-11)。
 *
 * task_7c64が最初に着手した「予約→確定」の型を、本ラウンドで見直した。
 * amplify/data/resource.tsのAIBudgetLedger/AIBudgetReservationモデルから
 * 型を取る — SDKへ渡すキー名を手で書き写すと、スキーマを直したときに
 * 静かにズレる(実際にamplify/data/resource.tsのフィールド名と
 * ledgerCommands.tsの文字列リテラルを突き合わせて確認済み)。
 */
export type AIBudgetLedgerRecord = Schema["AIBudgetLedger"]["type"];
export type AIBudgetReservationRecord = Schema["AIBudgetReservation"]["type"];
export type BudgetReservationStatus = Schema["AIBudgetReservationStatus"]["type"];

/** "YYYY-MM" 形式であることを呼び出し側にも明示するための別名(型では強制できない)。 */
export type YearMonth = string;

export interface ReserveBudgetInput {
  /**
   * 呼び出し側が発行する冪等キー。**1回の生成試行につき新しいidを使うこと**
   * — 同じidを使い回した2回目の呼び出しは、1回目と完全に同じmonth/amount
   * であっても常に ok:false になる(呼び出し側契約。二重生成防止のため)。
   */
  id: string;
  month: YearMonth;
  /** 見積りコスト。有限の正整数(単位は呼び出し側で統一する)。 */
  amount: number;
  /** 当月の上限。当月のledgerが未作成のときに限り、この値で初期化される。 */
  cap: number;
  priorSpent?: number;
}

export type ReserveBudgetFailureReason =
  /** amount/cap/month/idが型・範囲の条件を満たさない。 */
  | "invalid_input"
  /** 同一id・同一month・同一amountの予約が既に存在する(意図的な再送とみなせる)。 */
  | "already_reserved"
  /** 同一idに別のmonthまたはamountが指定された(プログラムの不具合の疑いが強い)。 */
  | "id_conflict"
  /** 当月の残り予算が不足している、または既存capと異なるcapが指定された。 */
  | "insufficient_budget"
  /** 条件チェック以外の理由でトランザクションが中断された。 */
  | "transaction_canceled";

export type ReserveBudgetResult =
  | { ok: true; id: string; month: YearMonth; amount: number }
  | {
      ok: false;
      reason: ReserveBudgetFailureReason;
      message: string;
      id: string;
      month?: YearMonth;
      amount?: number;
    };

export interface SettleReservationInput {
  id: string;
  /** 実際にかかった額。0を渡すと予約額を全額返金する(生成が失敗し課金が発生しなかった場合)。 */
  actualAmount: number;
}

export type SettleReservationFailureReason =
  | "invalid_input"
  /** そのidの予約が存在しない。 */
  | "not_found"
  /** 既にCONFIRMED/CANCELLEDだが、今回のactualAmountが確定済みの値と食い違う。 */
  | "already_settled_mismatch"
  /** 条件チェック以外の理由でトランザクションが中断された。 */
  | "transaction_canceled";

export type SettleReservationResult =
  | { ok: true; id: string; actualAmount: number; refunded: number }
  | { ok: false; reason: SettleReservationFailureReason; message: string; id: string };
