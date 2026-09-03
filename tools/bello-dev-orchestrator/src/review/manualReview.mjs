/**
 * 手動審査 — 人が判定する方式。
 *
 * AI を一切呼ばないので、利用上限にも認証切れにも影響されない。
 * Claude 審査が上限に達したときの避難先でもある。
 *
 * 判定は「ユーザー TODO の回答」として受け取り、他の審査方式と同じ
 * REVIEW_SCHEMA の形に直してから保存する。保存も状態遷移も共通経路を通るので、
 * 監査ログ・履歴・ダッシュボード表示が方式によってばらつかない。
 */
import { REVIEW_DECISIONS } from "./reviewSchema.mjs";

export const MANUAL_REVIEW_TODO_KIND = "manual_review";

/** 「合格」と読める入力。前後の空白と記号は落としてから判定する。 */
const ACCEPT_WORDS = ["合格", "ok", "承認", "完了", "approve", "accept", "問題なし"];
const CANCEL_WORDS = ["取消", "取り消し", "中止", "キャンセル", "cancel"];

/**
 * 回答文を審査結果へ変換する。
 * - 「合格」だけ → accept_and_continue
 * - 「取消」だけ → fail_safely（タスクを止める）
 * - それ以外の本文 → revision_required（本文をそのまま実装担当への修正指示にする）
 */
export function parseManualAnswer(answer) {
  const raw = String(answer ?? "").trim();
  if (!raw) {
    return { decision: null, reason: "回答が空です。", nextClaudeInstruction: null };
  }
  const normalized = raw.toLowerCase().replace(/[。.!！\s]+$/g, "");

  if (ACCEPT_WORDS.some((w) => normalized === w.toLowerCase())) {
    return { decision: "accept_and_continue", reason: `手動審査で合格と判定されました（回答: ${raw}）`, nextClaudeInstruction: null };
  }
  if (CANCEL_WORDS.some((w) => normalized === w.toLowerCase())) {
    return { decision: "fail_safely", reason: `手動審査で中止と判定されました（回答: ${raw}）`, nextClaudeInstruction: null };
  }
  return {
    decision: "revision_required",
    reason: "手動審査で修正が必要と判定されました。",
    nextClaudeInstruction: raw,
  };
}

/** 他の審査方式と同じ形の審査結果を作る。 */
export function toReviewRecord({ decision, reason, nextClaudeInstruction }, { evidence } = {}) {
  const safeDecision = REVIEW_DECISIONS.includes(decision) ? decision : "pause_for_user_review";
  const criteria = (evidence?.checks ?? []).map((c) => ({
    criterion: String(c.criterion ?? ""),
    result: c.result === "passed" || c.result === "failed" ? c.result : "unknown",
    evidence: String(c.evidence ?? ""),
  }));
  return {
    decision: safeDecision,
    reason: String(reason ?? ""),
    acceptanceCriteriaResults: criteria.length
      ? criteria
      : [{ criterion: "手動審査", result: safeDecision === "accept_and_continue" ? "passed" : "unknown", evidence: "人が判定" }],
    nextClaudeInstruction: nextClaudeInstruction ?? null,
    userTodos: [],
    riskFlags: [],
    shouldRunNextQueuedTask: safeDecision === "accept_and_continue",
    // 人が見て判断した結果なので、機械の推定確信度より高く扱う。
    confidence: 1,
  };
}

/**
 * 手動審査を依頼する TODO の内容を組み立てる。
 * 証拠ゲートの結果を必ず載せる。人が完了報告だけを見て「合格」と打つのを防ぐため。
 */
export function buildManualReviewTodo({ task, report, evidence }) {
  const gateLines = evidence?.checks?.length
    ? evidence.checks.map((c) => `  ・${c.criterion}: ${c.result}（${c.evidence}）`).join("\n")
    : "  ・（証拠ゲートの記録がありません）";

  const testLines = (report?.tests ?? []).map((t) => `  ・${t.name}: ${t.result}`).join("\n") || "  ・（テストの報告なし）";
  const commandLines =
    (report?.commandsRun ?? []).map((c) => `  ・${c.commandRedacted} → exit ${c.exitCode}`).join("\n") || "  ・（コマンドの報告なし）";
  const changeLines = (report?.changes ?? []).map((c) => `  ・${c.path}（${c.purpose}）`).join("\n") || "  ・（変更なし）";

  return {
    category: "approval",
    kind: MANUAL_REVIEW_TODO_KIND,
    title: `審査してください: ${task.title}`,
    reason:
      `審査方式が「手動審査」に設定されているため、この完了報告はあなたの判定を待っています。\n\n` +
      `【実装担当の主張】\n${String(report?.summary ?? "(要約なし)").slice(0, 600)}\n\n` +
      `【機械的な証拠ゲートの結果】${evidence?.passed ? "合格" : "不合格"}\n${gateLines}\n\n` +
      `【報告されたテスト】\n${testLines}\n\n` +
      `【実行されたコマンド】\n${commandLines}\n\n` +
      `【変更ファイル】\n${changeLines}`,
    steps: [
      "ダッシュボードのタスク詳細で、完了報告と状態履歴を確認する",
      `git diff ${task.git_start_commit ?? "HEAD~1"}..HEAD で実際の差分を確認する`,
      "問題なければ回答欄に「合格」とだけ入力する",
      "直してほしいことがあれば、その内容を回答欄に書く（そのまま実装担当への修正指示になります）",
      "このタスク自体をやめる場合は「取消」と入力する",
    ],
    completionCondition:
      "差分とテスト結果を自分で確認したうえで、「合格」「修正内容」「取消」のいずれかを回答したこと",
    answerFormat: "text",
    answerRequired: true,
    canUseIPhone: true,
    estimatedMinutes: 10,
    priority: evidence?.passed ? "normal" : "urgent",
  };
}
