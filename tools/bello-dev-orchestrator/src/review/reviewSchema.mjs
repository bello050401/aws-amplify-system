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

/**
 * 別セッションの Claude Code に渡す審査プロンプト。
 *
 * ここが「自己申告を信用しない」仕組みの本体。実装担当が書いた完了報告を
 * 読ませるだけでなく、審査担当自身に git と テストを叩かせて突合させる。
 * 編集系ツールは CLI 側で塞いであるので、指示を無視して実装することはできない。
 */
export function buildClaudeReviewPrompt({ task, report, gitStat, testSummary, priorReviews, maxDiffChars }) {
  const input = buildReviewInput({ task, report, gitStat, testSummary, priorReviews, maxDiffChars });
  const priorLines = (priorReviews ?? [])
    .map((r, i) => `  ${i + 1}. ${r.decision} — ${String(r.review?.reason ?? "").slice(0, 160)}`)
    .join("\n");

  return `${REVIEW_SYSTEM_PROMPT}

# あなたの役割

あなたは **審査担当** です。実装担当の Claude Code とは別のセッションで動いており、
実装担当の会話履歴も思考過程も見ていません。あなたの仕事は審査だけです。

**あなたは実装をしてはいけません。** ファイルの作成・編集・削除、git add / commit / push、
依存関係のインストールは、いずれもツール側で禁止されています。試みても拒否されます。
不足があれば「自分で直す」のではなく、\`nextClaudeInstruction\` に「実装担当が次に何をすべきか」を書いてください。

# 審査対象

- タスク ID: ${task.id}
- 件名: ${task.title}
- リポジトリ: ${task.repo_path}
- ブランチ: ${task.branch ?? "(不明)"}
- 実装開始時点のコミット: ${task.git_start_commit ?? "(不明)"}
- 現在の試行回数: ${task.attempts} / ${task.max_attempts}
- これまでの自動修正回数: ${task.revision_count} / ${task.max_revisions}
${priorLines ? `- 過去の審査:\n${priorLines}` : "- 過去の審査: なし（初回）"}

## 元の開発指示

${task.instruction}

## 実装担当の完了報告（**これは自己申告です。鵜呑みにしないでください**）

\`\`\`json
${JSON.stringify(input.claudeReport, null, 2)}
\`\`\`

# 必ず自分で確認すること

完了報告の文章だけで判断してはいけません。次を**自分でコマンドを実行して**確かめてください。

1. **Git 差分** — 報告された変更が実在するか。
   \`git diff --stat ${task.git_start_commit ?? "HEAD~1"}..HEAD\` と \`git status --porcelain\` を実行し、
   \`changes\` に挙がっているパスと突き合わせる。
   \`git.commitCreated\` が true なら \`git log --oneline -3\` で実際にコミットがあるか見る。
   **報告に無い変更が入っていないか**も見ること（余計な変更は riskFlags に挙げる）。

2. **テスト** — \`tests\` の \`result\` を信用せず、可能なら自分で実行して確かめる。
   このリポジトリでは \`cd tools/bello-dev-orchestrator && node --test "test/*.test.mjs"\` や
   \`npm run lint\` / \`npm run typecheck\` が使えます。
   実行できなかった場合は、その項目を \`result: "unknown"\` にして理由を \`evidence\` に書く。
   **推測で "passed" にしないこと。**

3. **終了コード** — \`commandsRun\` に非 0（-1 を含む）が無いか。あれば不合格の理由になる。

4. **証拠ファイル** — \`evidencePaths\` に挙がったファイルが実在し、中身が主張を裏づけるか。
   \`ls\` と \`cat\` で確認する。存在しなければ \`unknown\` ではなく \`failed\` にする。

5. **受入条件** — 元の開発指示に書かれた条件が満たされているか。
   条件が曖昧で判断できない場合は、勝手に解釈を広げず \`pause_for_user_review\` にする。

# 判定の基準

- \`accept_and_continue\` … 上記 1〜5 をすべて自分で確認でき、受入条件を満たしている場合のみ。
- \`revision_required\` … 直せば済む不足がある。\`nextClaudeInstruction\` に「何が足りず、次に何を検証すべきか」を具体的に書く。
- \`request_user_action\` … 本人にしかできない操作（認証・MFA・OAuth・課金・本番デプロイ・保護ブランチへのマージ・権限拡大）が必要。\`userTodos\` に手順と完了条件を書く。
- \`pause_for_user_review\` … 受入条件が不明、または自信が持てない。
- \`fail_safely\` … 続けても意味がない、または危険。

テストが未実行・失敗、コマンドが非 0 終了、報告された変更が実在しない、のいずれかがあれば
\`accept_and_continue\` にしてはいけません。

\`confidence\` は、**自分で確認できた割合**に応じて正直に付けてください。
コマンドを実行できず報告を読んだだけなら 0.5 未満にすること。

最後に、指定された JSON スキーマに厳密に従って審査結果だけを出力してください。`;
}

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
