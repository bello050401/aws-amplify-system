/**
 * Claude の構造化完了報告 (指示書 §6-5)。
 *
 * このスキーマは 2 か所で使う:
 *  1. `claude -p --json-schema <これ>` に渡し、CLI 側で検証させる
 *  2. 受け取った JSON をこちら側でも検証する (CLI を信用しきらない)
 */
export const COMPLETION_REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["taskId", "status", "summary", "changes", "tests", "git"],
  properties: {
    taskId: { type: "string" },
    status: { type: "string", enum: ["completed", "partial", "blocked", "failed"] },
    summary: { type: "string" },
    investigation: { type: "array", items: { type: "string" } },
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["decision"],
        properties: {
          decision: { type: "string" },
          evidence: { type: "string" },
          tradeoff: { type: "string" },
        },
      },
    },
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "purpose"],
        properties: { path: { type: "string" }, purpose: { type: "string" } },
      },
    },
    commandsRun: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["commandRedacted", "exitCode"],
        properties: {
          commandRedacted: { type: "string" },
          exitCode: { type: "integer" },
          purpose: { type: "string" },
        },
      },
    },
    tests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "result"],
        properties: {
          name: { type: "string" },
          result: { type: "string", enum: ["passed", "failed", "skipped"] },
          evidencePath: { type: "string" },
        },
      },
    },
    git: {
      type: "object",
      additionalProperties: false,
      required: ["branch", "commitCreated"],
      properties: {
        branch: { type: "string" },
        startCommit: { type: "string" },
        endCommit: { type: "string" },
        commitCreated: { type: "boolean" },
        workingTreeSummary: { type: "string" },
      },
    },
    remainingIssues: { type: "array", items: { type: "string" } },
    userActions: {
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
    recommendedNextActions: { type: "array", items: { type: "string" } },
    riskFlags: { type: "array", items: { type: "string" } },
    evidencePaths: { type: "array", items: { type: "string" } },
  },
};

/**
 * すべてのタスク指示の先頭に自動付加する共通実行契約 (指示書 §6-4)。
 */
export function buildExecutionContract({ taskId, repoPath, branch }) {
  return `# 実行契約（BELLO 自律開発管理システム）

あなたは BELLO の開発タスクを 1 件担当します。以下は例外なく守ってください。

- タスクID: ${taskId}
- リポジトリ: ${repoPath}
- 想定ブランチ: ${branch ?? "(現在のブランチ)"}

## 守ること

1. 既存実装を推測で重複実装しない。必ず検索・読解・実測してから変更する。
2. ユーザーの未コミット変更を保存する。git reset --hard、無差別な削除、履歴改変、既存変更の上書きをしない。
3. 危険操作・本人操作（認証、MFA、OAuth、CAPTCHA、課金、本番デプロイ、本番データ破壊、保護ブランチへのマージ、IAM 等の権限拡大）は自分で実行せず、完了報告の userActions として報告し、それ以外の作業は続行する。
4. 調査 → 設計 → 実装 → テスト → 修正 → 再テストまで行う。「実装したが未検証」を完了と呼ばない。
5. 完了条件を満たすまで、途中報告だけで終了しない。
6. 秘密情報（APIキー、トークン、Cookie、認証情報）を出力・記録しない。コマンドは秘密を除去した形で報告する。
7. 最後に、指定された JSON スキーマの完了報告を必ず出力する。taskId には ${taskId} を入れる。

## 開発指示

`;
}
