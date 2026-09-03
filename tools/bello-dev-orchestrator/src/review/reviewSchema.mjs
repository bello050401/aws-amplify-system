/**
 * OpenAI 審査エンジンの構造化出力 (指示書 §7-3)。
 */
export const REVIEW_DECISIONS = Object.freeze([
  "accept_and_continue",
  "revision_required",
  "request_user_action",
  "pause_for_user_review",
  "fail_safely",
]);

export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "reason", "acceptanceCriteriaResults", "userTodos", "riskFlags", "shouldRunNextQueuedTask", "confidence", "nextClaudeInstruction"],
  properties: {
    decision: { type: "string", enum: [...REVIEW_DECISIONS] },
    reason: { type: "string" },
    acceptanceCriteriaResults: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "result", "evidence"],
        properties: {
          criterion: { type: "string" },
          result: { type: "string", enum: ["passed", "failed", "unknown"] },
          evidence: { type: "string" },
        },
      },
    },
    nextClaudeInstruction: { type: ["string", "null"] },
    userTodos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "title", "reason", "completionCondition"],
        properties: {
          category: { type: "string" },
          title: { type: "string" },
          reason: { type: "string" },
          steps: { type: "array", items: { type: "string" } },
          completionCondition: { type: "string" },
          canUseIPhone: { type: "boolean" },
          estimatedMinutes: { type: "integer" },
        },
      },
    },
    riskFlags: { type: "array", items: { type: "string" } },
    shouldRunNextQueuedTask: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

export const REVIEW_PROMPT_VERSION = "bello-review-v1";

export const REVIEW_SYSTEM_PROMPT = `あなたは BELLO 開発の審査担当です。Claude Code が提出した完了報告と証拠を審査し、次の処理を決めます。

厳守事項:
- 「完了しました」という文章だけで合格にしない。tests の結果、commandsRun の exitCode、git の差分、evidencePaths を突合すること。
- テストが未実行または failed なら accept_and_continue にしない。
- 本人にしかできない操作 (認証, MFA, OAuth, CAPTCHA, 課金, 本番デプロイ, 本番データ破壊, 保護ブランチへのマージ, 権限拡大) が必要なら request_user_action にし、userTodos に具体的な手順と完了条件を入れる。
- 受入条件が不明な場合や自信が持てない場合は、勝手に仕様を広げず pause_for_user_review にする。
- あなた自身はシェルを実行しない。次の指示か TODO だけを返す。
- revision_required の場合、nextClaudeInstruction には「何が不足していて、次に何を検証すべきか」を具体的に書く。
- 出力は指定された JSON スキーマに厳密に従う。`;

/** 審査へ渡す入力を組み立てる (§7-2: 必要最小限)。 */
export function buildReviewInput({ task, report, gitStat, testSummary, priorReviews, maxDiffChars }) {
  const trimmedDiff = (gitStat ?? "").slice(0, maxDiffChars ?? 60000);
  return {
    originalInstruction: task.instruction,
    taskTitle: task.title,
    taskState: task.state,
    attempt: task.attempts,
    revisionCount: task.revision_count,
    maxRevisions: task.max_revisions,
    claudeReport: report,
    gitStat: trimmedDiff,
    testSummary: testSummary ?? null,
    priorReviewDecisions: (priorReviews ?? []).map((r) => ({
      decision: r.decision,
      reason: r.review?.reason ?? null,
      at: r.created_at,
    })),
    riskBoundary: [
      "本番データ削除・大量更新",
      "本番DBの不可逆マイグレーション",
      "本番デプロイ・公開",
      "保護ブランチへの自動マージ",
      "課金サービスの有効化・購入",
      "OAuth / MFA / CAPTCHA / 本人確認",
      "認証情報の生成・変更・表示",
      "IAM 等の権限拡大",
      "外部ユーザーへのメッセージ送信",
    ],
  };
}
