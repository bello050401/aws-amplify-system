/**
 * タスク状態機械 (指示書 §5-2)。
 *
 * 「許可された遷移をコードで制限し、任意の状態書換えで矛盾を作らない」ため、
 * 遷移表をここに一本化する。状態を変えるコードは必ず assertTransition を通す。
 */

export const STATES = Object.freeze({
  QUEUED: "queued",
  PREFLIGHT: "preflight",
  RUNNING: "running",
  VERIFYING: "verifying",
  AWAITING_AI_REVIEW: "awaiting_ai_review",
  REVISION_REQUIRED: "revision_required",
  AWAITING_USER: "awaiting_user",
  PAUSED: "paused",
  RETRY_WAIT: "retry_wait",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const ALL_STATES = Object.freeze(Object.values(STATES));

/** 終端状態。ここから先へは (再試行の明示操作を除いて) 進まない。 */
export const TERMINAL_STATES = Object.freeze([STATES.COMPLETED, STATES.FAILED, STATES.CANCELLED]);

/**
 * 子プロセスを抱えて「実際に動いていた」状態。Orchestrator が落ちるとこれらの
 * 追跡は不能になるため、復旧時に作り直す対象になる (§6-3-3)。
 *
 * awaiting_ai_review をここへ入れてはいけない。あれは待っているだけの状態で、
 * 完了報告は既に保存済みである。作り直すと成功した Claude 実行を丸ごと捨てて
 * しまう (実 E2E で実際に起きた)。
 */
export const ACTIVE_STATES = Object.freeze([STATES.PREFLIGHT, STATES.RUNNING]);

/**
 * 落ちた時点で完了報告が残っている可能性がある状態。
 * 報告があれば審査から再開でき、Claude を走らせ直さずに済む。
 */
export const RESUMABLE_STATES = Object.freeze([STATES.VERIFYING]);

const TRANSITIONS = Object.freeze({
  [STATES.QUEUED]: [STATES.PREFLIGHT, STATES.PAUSED, STATES.CANCELLED, STATES.AWAITING_USER, STATES.FAILED],
  [STATES.PREFLIGHT]: [
    STATES.RUNNING,
    STATES.AWAITING_USER,
    STATES.RETRY_WAIT,
    STATES.FAILED,
    STATES.CANCELLED,
    STATES.PAUSED,
  ],
  [STATES.RUNNING]: [
    STATES.VERIFYING,
    STATES.RETRY_WAIT,
    STATES.AWAITING_USER,
    STATES.FAILED,
    STATES.CANCELLED,
    STATES.PAUSED,
  ],
  [STATES.VERIFYING]: [
    STATES.AWAITING_AI_REVIEW,
    STATES.RETRY_WAIT,
    STATES.AWAITING_USER,
    STATES.FAILED,
    STATES.CANCELLED,
  ],
  [STATES.AWAITING_AI_REVIEW]: [
    STATES.COMPLETED,
    STATES.REVISION_REQUIRED,
    STATES.AWAITING_USER,
    STATES.PAUSED,
    STATES.FAILED,
    STATES.CANCELLED,
    STATES.RETRY_WAIT,
  ],
  [STATES.REVISION_REQUIRED]: [STATES.QUEUED, STATES.AWAITING_USER, STATES.FAILED, STATES.CANCELLED, STATES.PAUSED],
  [STATES.AWAITING_USER]: [STATES.QUEUED, STATES.CANCELLED, STATES.FAILED, STATES.PAUSED],
  [STATES.PAUSED]: [STATES.QUEUED, STATES.CANCELLED, STATES.FAILED],
  [STATES.RETRY_WAIT]: [STATES.QUEUED, STATES.FAILED, STATES.CANCELLED, STATES.PAUSED],
  // 終端。ダッシュボードからの明示的な再試行だけが queued へ戻せる。
  [STATES.COMPLETED]: [],
  [STATES.FAILED]: [STATES.QUEUED],
  [STATES.CANCELLED]: [STATES.QUEUED],
});

export function canTransition(from, to) {
  if (!ALL_STATES.includes(to)) return false;
  if (from === to) return false;
  return (TRANSITIONS[from] ?? []).includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(from, to) {
    super(`状態遷移が許可されていません: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** UI 表示用の日本語ラベル。色だけに依存しない表示のため文言を持つ (§10-3)。 */
export const STATE_LABELS_JA = Object.freeze({
  [STATES.QUEUED]: "待機中",
  [STATES.PREFLIGHT]: "事前確認中",
  [STATES.RUNNING]: "実行中",
  [STATES.VERIFYING]: "検証中",
  [STATES.AWAITING_AI_REVIEW]: "AI審査待ち",
  [STATES.REVISION_REQUIRED]: "修正指示あり",
  [STATES.AWAITING_USER]: "ユーザー様の操作待ち",
  [STATES.PAUSED]: "一時停止",
  [STATES.RETRY_WAIT]: "再試行待ち",
  [STATES.COMPLETED]: "完了",
  [STATES.FAILED]: "失敗",
  [STATES.CANCELLED]: "取消",
});
