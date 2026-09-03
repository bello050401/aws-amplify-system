/** 単体テスト (指示書 §14-1)。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { validate } from "../src/core/validate.mjs";
import { canTransition, assertTransition, InvalidTransitionError, STATES } from "../src/core/states.mjs";
import { redactText, redactValue, registerSecret, clearRegisteredSecrets } from "../src/log/redact.mjs";
import { Logger } from "../src/log/logger.mjs";
import { COMPLETION_REPORT_SCHEMA } from "../src/runner/reportSchema.mjs";
import { REVIEW_SCHEMA } from "../src/review/reviewSchema.mjs";
import { evaluateEvidence } from "../src/review/evidenceGate.mjs";
import { safeFileName, isIgnorableFile } from "../src/intake/documentIntake.mjs";
import { extractDocx } from "../src/intake/docxReader.mjs";
import { ZipError } from "../src/intake/zipReader.mjs";
import { validateConfig } from "../src/config.mjs";
import { makeReport } from "../src/runner/fakeRunner.mjs";
import { makeReview } from "../src/review/fakeReview.mjs";
import { buildHarness, makeDocx, makeZip, tempDir, makeConfig } from "./helpers.mjs";

// ---------------------------------------------------------------- 状態遷移
test("状態遷移: 許可された遷移だけが通る", () => {
  assert.equal(canTransition(STATES.QUEUED, STATES.PREFLIGHT), true);
  assert.equal(canTransition(STATES.QUEUED, STATES.COMPLETED), false);
  assert.equal(canTransition(STATES.COMPLETED, STATES.RUNNING), false);
  assert.equal(canTransition(STATES.RUNNING, STATES.RUNNING), false, "同じ状態への遷移は許さない");
  assert.equal(canTransition(STATES.FAILED, STATES.QUEUED), true, "明示的な再試行だけは許す");
  assert.throws(() => assertTransition(STATES.COMPLETED, STATES.RUNNING), InvalidTransitionError);
});

test("状態遷移: 未知の状態は拒否する", () => {
  assert.equal(canTransition(STATES.QUEUED, "nonsense"), false);
});

// ------------------------------------------------------------------ 検証
test("スキーマ検証: 完了報告の必須項目と enum", () => {
  const good = makeReport("task_1");
  assert.equal(validate(good, COMPLETION_REPORT_SCHEMA).valid, true);

  const missing = { ...good };
  delete missing.git;
  assert.equal(validate(missing, COMPLETION_REPORT_SCHEMA).valid, false);

  const badEnum = { ...good, status: "done" };
  const result = validate(badEnum, COMPLETION_REPORT_SCHEMA);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("status")));

  const extra = { ...good, surprise: 1 };
  assert.equal(validate(extra, COMPLETION_REPORT_SCHEMA).valid, false, "未知プロパティを拒否する");
});

test("スキーマ検証: 審査結果", () => {
  assert.equal(validate(makeReview("accept_and_continue"), REVIEW_SCHEMA).valid, true);
  assert.equal(validate(makeReview("bogus_decision"), REVIEW_SCHEMA).valid, false);
  const lowConfidence = { ...makeReview("accept_and_continue"), confidence: 2 };
  assert.equal(validate(lowConfidence, REVIEW_SCHEMA).valid, false, "confidence は 0..1");
});

test("設定検証: 不正な設定は errors を返す", () => {
  const cfg = makeConfig();
  assert.equal(validateConfig(cfg).errors.length, 0);

  const badMode = makeConfig();
  badMode.claude.permissionMode = "nope";
  assert.ok(validateConfig(badMode).errors.some((e) => e.includes("permissionMode")));

  const badRevisions = makeConfig();
  badRevisions.review.maxRevisions = 0;
  assert.ok(validateConfig(badRevisions).errors.some((e) => e.includes("maxRevisions")));

  const badProvider = makeConfig();
  badProvider.review.provider = "gemini";
  assert.ok(validateConfig(badProvider).errors.some((e) => e.includes("review.provider")));

  const noKeyIsFine = makeConfig();
  delete process.env.OPENAI_API_KEY;
  assert.equal(
    validateConfig(noKeyIsFine).errors.length,
    0,
    "既定の Claude 審査では OPENAI_API_KEY 未設定はエラーにしない",
  );

  const lanNoToken = makeConfig();
  lanNoToken.dashboard.lanAccess = true;
  lanNoToken.dashboard.host = "0.0.0.0";
  delete process.env.BELLO_DASHBOARD_TOKEN;
  assert.ok(
    validateConfig(lanNoToken).errors.some((e) => e.includes("認証トークン")),
    "無認証の LAN 公開は許さない",
  );
});

// -------------------------------------------------------------- redaction
test("秘密情報の除去: 既知の形式", () => {
  clearRegisteredSecrets();
  assert.match(redactText("Authorization: Bearer abcdef1234567890"), /\[REDACTED\]/);
  assert.match(redactText("key is sk-abcdefghijklmnop"), /REDACTED_API_KEY/);
  assert.match(redactText("AKIAIOSFODNN7EXAMPLE"), /REDACTED_AWS_KEY_ID/);
  assert.match(redactText("OPENAI_API_KEY=supersecretvalue"), /\[REDACTED\]/);
  assert.match(redactText("https://x.test/cb?token=abc123&y=1"), /token=\[REDACTED\]/);
  assert.match(redactText("ghp_0123456789abcdefghij"), /REDACTED_GITHUB_TOKEN/);
});

test("秘密情報の除去: 登録した実値とオブジェクトのキー名", () => {
  clearRegisteredSecrets();
  registerSecret("hunter2-is-the-value");
  assert.equal(redactText("value=hunter2-is-the-value here"), "value=[REDACTED] here");

  const out = redactValue({ apiKey: "abc", nested: { authorization: "x" }, safe: "ok" });
  assert.equal(out.apiKey, "[REDACTED]");
  assert.equal(out.nested.authorization, "[REDACTED]");
  assert.equal(out.safe, "ok");
  clearRegisteredSecrets();
});

test("秘密情報の除去: 循環参照でも落ちない", () => {
  const a = { name: "a" };
  a.self = a;
  const out = redactValue(a);
  assert.equal(out.self, "[Circular]");
});

// ------------------------------------------------------------ ログ回転
test("ログローテーション: 上限を超えると回転する", () => {
  const dir = tempDir("bello-log-");
  const logger = new Logger({ dir, name: "rot", level: "info", maxFileBytes: 300, maxFiles: 3, echo: false });
  for (let i = 0; i < 50; i += 1) logger.info(`行 ${i} ${"x".repeat(50)}`);
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("rot.log"));
  assert.ok(files.length > 1, `回転していません: ${files.join(",")}`);
  assert.ok(files.length <= 4, `保持数を超えています: ${files.join(",")}`);
});

// -------------------------------------------------------------- 証拠ゲート
test("証拠ゲート: テスト未実行は不合格", () => {
  const report = makeReport("t1", { tests: [] });
  const result = evaluateEvidence({ report, gitFacts: null, repoPath: null });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => f.includes("テスト")));
});

test("証拠ゲート: テスト失敗は不合格", () => {
  const report = makeReport("t1", { tests: [{ name: "unit", result: "failed" }] });
  assert.equal(evaluateEvidence({ report, gitFacts: null, repoPath: null }).passed, false);
});

test("証拠ゲート: 非 0 終了のコマンドがあれば不合格", () => {
  const report = makeReport("t1", { commandsRun: [{ commandRedacted: "npm test", exitCode: 1, purpose: "t" }] });
  assert.equal(evaluateEvidence({ report, gitFacts: null, repoPath: null }).passed, false);
});

test("証拠ゲート: commitCreated=true なのに HEAD が動いていなければ不合格", () => {
  const report = makeReport("t1");
  const gitFacts = { startCommit: "abc123", headCommit: "abc123", branch: "work", protectedBranchTouched: false };
  const result = evaluateEvidence({ report, gitFacts, repoPath: null });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => f.includes("コミット")));
});

test("証拠ゲート: 正常系は合格", () => {
  const report = makeReport("t1");
  const gitFacts = { startCommit: "abc123", headCommit: "def456", branch: "work", protectedBranchTouched: false };
  const result = evaluateEvidence({ report, gitFacts, repoPath: null });
  assert.equal(result.passed, true, result.failures.join(" / "));
});

test("証拠ゲート: 保護ブランチへのコミットは不合格", () => {
  const report = makeReport("t1");
  const gitFacts = { startCommit: "a", headCommit: "b", branch: "main", protectedBranchTouched: true };
  assert.equal(evaluateEvidence({ report, gitFacts, repoPath: null }).passed, false);
});

// -------------------------------------------------------------- ファイル名
test("ファイル名の安全化: パストラバーサルとディレクトリ区切りを除去", () => {
  assert.equal(safeFileName("a/b/c.docx"), "c.docx");
  assert.equal(safeFileName("..\\..\\etc\\passwd.docx"), "passwd.docx");
  assert.equal(safeFileName("../../secret.docx"), "secret.docx");
  assert.ok(!safeFileName("....docx").startsWith("."));
  assert.equal(safeFileName("normal-name file.docx"), "normal-name file.docx", "通常の名前は壊さない");
  assert.ok(safeFileName("").length > 0);
});

test("一時ファイル判定: Office の ~$ を無視する", () => {
  assert.equal(isIgnorableFile("~$requirements.docx"), true);
  assert.equal(isIgnorableFile(".hidden.docx"), true);
  assert.equal(isIgnorableFile("draft.tmp"), true);
  assert.equal(isIgnorableFile("requirements.docx"), false);
});

// ------------------------------------------------------------------ docx
test("docx 抽出: 見出し・段落・箇条書き・表", () => {
  const buf = makeDocx({
    headings: [{ level: 1, text: "在庫画面の改善" }],
    paragraphs: ["一覧の表示を速くしたい。", { list: "検索を 1 秒以内に" }, { list: "並び順を保存する" }],
    table: [
      ["項目", "現状", "希望"],
      ["検索", "3秒", "1秒"],
    ],
  });
  const out = extractDocx(buf);
  assert.ok(out.text.includes("# 在庫画面の改善"));
  assert.ok(out.text.includes("- 検索を 1 秒以内に"));
  assert.ok(out.text.includes("| 項目 | 現状 | 希望 |"));
  assert.equal(out.hasTables, true);
  assert.equal(out.tableCount, 1);
  assert.equal(out.hasImages, false);
});

test("docx 抽出: 画像があると警告を出す (OCR はしない)", () => {
  const buf = makeDocx({
    paragraphs: ["本文"],
    extraFiles: [{ name: "word/media/image1.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }],
  });
  const out = extractDocx(buf);
  assert.equal(out.hasImages, true);
  assert.equal(out.imageCount, 1);
  assert.ok(out.warnings.some((w) => w.includes("画像")));
});

test("docx 抽出: マクロの存在を報告するが実行しない", () => {
  const buf = makeDocx({
    paragraphs: ["本文"],
    extraFiles: [{ name: "word/vbaProject.bin", data: Buffer.from([0x00, 0x01]) }],
  });
  const out = extractDocx(buf);
  assert.ok(out.warnings.some((w) => w.includes("マクロ")));
});

test("docx 抽出: XML エンティティを復元する", () => {
  const buf = makeDocx({ paragraphs: ["A &amp; B &lt;tag&gt;"] });
  assert.ok(extractDocx(buf).text.includes("A & B <tag>"));
});

test("docx 抽出: document.xml が無ければ明示的に失敗する", () => {
  const buf = makeZip([{ name: "hello.txt", data: "not a docx" }]);
  assert.throws(() => extractDocx(buf), ZipError);
});

test("docx 抽出: 壊れたファイルは ZipError", () => {
  assert.throws(() => extractDocx(Buffer.from("これは zip ではありません")), ZipError);
});

// ------------------------------------------------------------ 冪等性・TODO
test("冪等性: 同じ指示は二重登録されない", async () => {
  const h = await buildHarness();
  try {
    const input = { title: "同じ件名", instruction: "同じ内容", source: "user_ui", repoPath: h.config.repoPath };
    const first = h.repo.createTask(input);
    const second = h.repo.createTask(input);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.task.id, second.task.id);
    assert.equal(h.repo.listTasks().length, 1);
  } finally {
    h.cleanup();
  }
});

test("冪等性キー: 一度だけ claim できる", async () => {
  const h = await buildHarness();
  try {
    assert.equal(h.repo.claimIdempotency("k1", "deploy"), true);
    assert.equal(h.repo.claimIdempotency("k1", "deploy"), false);
  } finally {
    h.cleanup();
  }
});

test("TODO: 必須回答が空なら完了させない", async () => {
  const h = await buildHarness();
  try {
    const { todo } = h.todoManager.createFromUserAction({
      category: "specification_decision",
      title: "仕様を決めてください",
      reason: "曖昧なため",
      completionCondition: "回答したこと",
    });
    assert.equal(todo.answerRequired, true, "仕様判断はチェックだけで完了させない");
    assert.throws(() => h.todoManager.complete(todo.id, { answer: "  " }), /回答が必須/);
    const done = h.todoManager.complete(todo.id, { answer: "案 A で進めてください" });
    assert.equal(done.todo.status, "completed");
  } finally {
    h.cleanup();
  }
});

test("TODO: 同じ依頼を繰り返し作らない", async () => {
  const h = await buildHarness();
  try {
    const action = { category: "auth", title: "ログインしてください", reason: "認証切れ", completionCondition: "ログイン済み" };
    const a = h.todoManager.createFromUserAction(action, { waitingTaskIds: ["task_a"] });
    const b = h.todoManager.createFromUserAction(action, { waitingTaskIds: ["task_b"] });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.deepEqual(b.todo.waitingTaskIds, ["task_a", "task_b"], "待機タスクだけ追記する");
  } finally {
    h.cleanup();
  }
});

test("TODO: 完了は一度しか依存解除しない", async () => {
  const h = await buildHarness();
  try {
    const { task } = h.repo.createTask({
      title: "依存タスク",
      instruction: "x",
      source: "user_ui",
      repoPath: h.config.repoPath,
    });
    h.repo.setState(task.id, STATES.AWAITING_USER, "TODO 待ち", "system");
    const { todo } = h.todoManager.createFromUserAction(
      { category: "auth", title: "認証", reason: "r", completionCondition: "c" },
      { waitingTaskIds: [task.id] },
    );
    const first = h.todoManager.complete(todo.id);
    assert.deepEqual(first.resumedTaskIds, [task.id]);
    const second = h.todoManager.complete(todo.id);
    assert.equal(second.alreadyCompleted, true);
    assert.deepEqual(second.resumedTaskIds, [], "二度目は再開しない");
  } finally {
    h.cleanup();
  }
});

test("TODO: OPENAI_API_KEY 未設定を TODO にしない（既定は追加課金なしの Claude 審査）", async () => {
  const h = await buildHarness();
  try {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    // 既定 (Claude 審査) では OpenAI キーは不要なので、何も要求しない
    assert.equal(h.todoManager.ensureEnvironmentTodos().length, 0, "使う予定のない設定を要求しない");
    assert.equal(h.repo.listTodos({ status: "open" }).length, 0);

    // OpenAI を明示的に選んだ場合だけ知らせる
    h.todoManager.requireOpenAiKey = true;
    assert.equal(h.todoManager.ensureEnvironmentTodos().length, 1, "OpenAI を選んだときだけ知らせる");
    assert.equal(h.todoManager.ensureEnvironmentTodos().length, 0, "二重に作らない");

    process.env.OPENAI_API_KEY = "sk-test-value-1234567890";
    const h2 = await buildHarness();
    h2.todoManager.requireOpenAiKey = true;
    assert.equal(h2.todoManager.ensureEnvironmentTodos().length, 0, "満たされていれば要求しない");
    h2.cleanup();

    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  } finally {
    h.cleanup();
  }
});

// ------------------------------------------------------------ 再試行制御
test("再試行: retry_wait は時刻が来るまで queued に戻らない", async () => {
  const h = await buildHarness();
  try {
    const { task } = h.repo.createTask({ title: "t", instruction: "i", source: "user_ui", repoPath: h.config.repoPath });
    h.repo.setState(task.id, STATES.PREFLIGHT, "x", "system");
    h.repo.setState(task.id, STATES.RETRY_WAIT, "失敗", "system", {
      retry_after: new Date(Date.now() + 60000).toISOString(),
    });
    assert.equal(h.repo.releaseDueRetries(), 0);
    assert.equal(h.repo.getTask(task.id).state, STATES.RETRY_WAIT);

    h.repo.updateTask(task.id, { retry_after: new Date(Date.now() - 1000).toISOString() });
    assert.equal(h.repo.releaseDueRetries(), 1);
    assert.equal(h.repo.getTask(task.id).state, STATES.QUEUED);
  } finally {
    h.cleanup();
  }
});

test("依存関係: 未完了の依存があるタスクは選ばれない", async () => {
  const h = await buildHarness();
  try {
    const a = h.repo.createTask({ title: "A", instruction: "a", source: "user_ui", repoPath: h.config.repoPath }).task;
    const b = h.repo.createTask({
      title: "B",
      instruction: "b",
      source: "user_ui",
      repoPath: h.config.repoPath,
      dependsOn: [a.id],
      priority: 99,
    }).task;
    assert.equal(h.repo.claimNextTask().id, a.id, "優先度が高くても依存未解決なら選ばない");

    h.repo.setState(a.id, STATES.PREFLIGHT, "x", "system");
    h.repo.setState(a.id, STATES.RUNNING, "x", "system");
    h.repo.setState(a.id, STATES.VERIFYING, "x", "system");
    h.repo.setState(a.id, STATES.AWAITING_AI_REVIEW, "x", "system");
    h.repo.setState(a.id, STATES.COMPLETED, "x", "system");
    assert.equal(h.repo.claimNextTask().id, b.id);
  } finally {
    h.cleanup();
  }
});

test("秘密情報の除去: 真偽値・数値は落とさない (診断表示のため)", () => {
  clearRegisteredSecrets();
  const out = redactValue({
    apiKeyConfigured: false,
    lanTokenConfigured: true,
    tokenCount: 42,
    apiKey: "sk-realsecretvalue",
  });
  assert.equal(out.apiKeyConfigured, false, "設定されているかの真偽は残す");
  assert.equal(out.lanTokenConfigured, true);
  assert.equal(out.tokenCount, 42);
  assert.equal(out.apiKey, "[REDACTED]", "文字列の秘密は必ず落とす");
});

// ------------------------------------------------- Claude Runner の引数組み立て
test("Claude Runner: 許可リスト / 拒否リストを引数へ渡す", async () => {
  const { ClaudeRunner } = await import("../src/runner/claudeRunner.mjs");
  const config = makeConfig();
  const runner = new ClaudeRunner({ config, paths: { runsDir: tempDir("runs-") }, logger: new Logger({ dir: tempDir("l-"), echo: false }) });
  const args = runner.buildArgs({ resumeSessionId: null });

  assert.ok(args.includes("-p"), "非対話実行");
  assert.equal(args[args.indexOf("--output-format") + 1], "json");
  assert.ok(args.includes("--json-schema"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.equal(args[args.indexOf("--permission-prompts") + 1], "none");
  // 実測: --permission-prompts none だけでは Bash が自動拒否される。許可リストが要る。
  assert.equal(args[args.indexOf("--allowedTools") + 1], "Read,Bash(node:*)");
  assert.equal(args[args.indexOf("--disallowedTools") + 1], "Bash(git push:*)");
  assert.ok(!args.includes("--resume"));

  const resumed = runner.buildArgs({ resumeSessionId: "abc-123" });
  assert.equal(resumed[resumed.indexOf("--resume") + 1], "abc-123");
});

test("設定検証: allowedTools が空 + prompts=none は警告する", () => {
  const cfg = makeConfig();
  cfg.claude.allowedTools = [];
  const { warnings } = validateConfig(cfg);
  assert.ok(warnings.some((w) => w.includes("自動拒否")), "Bash が動かない組み合わせを黙認しない");
});

// ------------------------------------------------- Claude 審査（追加課金なし）
test("Claude審査: 実装セッションを継承せず、編集系ツールを一切許可しない", async () => {
  const { ClaudeReviewEngine, DEFAULT_REVIEW_ALLOWED_TOOLS, DEFAULT_REVIEW_DISALLOWED_TOOLS } = await import(
    "../src/review/claudeReview.mjs"
  );
  const config = makeConfig();
  const engine = new ClaudeReviewEngine({ config, paths: { runsDir: tempDir("r-") }, logger: null });
  const args = engine.buildArgs();

  assert.ok(args.includes("-p"), "非対話実行");
  assert.equal(args[args.indexOf("--output-format") + 1], "json");
  assert.ok(args.includes("--json-schema"), "審査結果もスキーマ検証させる");
  assert.ok(!args.includes("--resume"), "実装セッションを継承しない = 独立した審査者");
  assert.ok(!args.includes("--continue"));

  const allowed = args[args.indexOf("--allowedTools") + 1].split(",");
  const disallowed = args[args.indexOf("--disallowedTools") + 1].split(",");

  for (const forbidden of ["Edit", "Write", "NotebookEdit"]) {
    assert.ok(!allowed.includes(forbidden), `${forbidden} を許可してはいけない`);
    assert.ok(disallowed.includes(forbidden), `${forbidden} を明示的に禁止する`);
  }
  for (const mutating of ["Bash(git commit:*)", "Bash(git push:*)", "Bash(git reset:*)", "Bash(rm:*)"]) {
    assert.ok(disallowed.includes(mutating), `${mutating} を禁止する`);
  }
  // 自己申告を確かめるための読み取り手段は与える
  for (const needed of ["Bash(git diff:*)", "Bash(git log:*)", "Bash(node --test:*)", "Read"]) {
    assert.ok(allowed.includes(needed), `${needed} は審査に必要`);
  }
  assert.equal(DEFAULT_REVIEW_ALLOWED_TOOLS.includes("Write"), false);
  assert.ok(DEFAULT_REVIEW_DISALLOWED_TOOLS.includes("Write"));
});

test("Claude審査: OPENAI_API_KEY が無くても使える（追加課金なしの要件）", async () => {
  const { ClaudeReviewEngine } = await import("../src/review/claudeReview.mjs");
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const engine = new ClaudeReviewEngine({ config: makeConfig(), paths: { runsDir: tempDir("r-") }, logger: null });
  // claude 実行ファイルの有無だけで決まる。API キーは一切見ない。
  assert.equal(typeof engine.isConfigured(), "boolean");
  assert.equal(engine.provider, "claude");
  if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
});

test("審査失敗の分類: 利用上限と認証切れを見分ける", async () => {
  const { classifyFailureText, REVIEW_FAILURE, NEEDS_USER_ACTION } = await import("../src/review/errors.mjs");
  assert.equal(classifyFailureText("Claude usage limit reached"), REVIEW_FAILURE.USAGE_LIMIT);
  assert.equal(classifyFailureText("429 rate limit exceeded"), REVIEW_FAILURE.USAGE_LIMIT);
  assert.equal(classifyFailureText("利用上限に達しました"), REVIEW_FAILURE.USAGE_LIMIT);
  assert.equal(classifyFailureText("Please run /login"), REVIEW_FAILURE.AUTH_EXPIRED);
  assert.equal(classifyFailureText("401 Unauthorized"), REVIEW_FAILURE.AUTH_EXPIRED);
  assert.equal(classifyFailureText("connection reset"), REVIEW_FAILURE.TRANSIENT, "分からないものは待って再試行");
  assert.ok(NEEDS_USER_ACTION.includes(REVIEW_FAILURE.USAGE_LIMIT));
  assert.ok(NEEDS_USER_ACTION.includes(REVIEW_FAILURE.AUTH_EXPIRED));
  assert.ok(!NEEDS_USER_ACTION.includes(REVIEW_FAILURE.TRANSIENT));
});

test("手動審査: 回答の解釈", async () => {
  const { parseManualAnswer, toReviewRecord } = await import("../src/review/manualReview.mjs");
  assert.equal(parseManualAnswer("合格").decision, "accept_and_continue");
  assert.equal(parseManualAnswer("  合格。 ").decision, "accept_and_continue");
  assert.equal(parseManualAnswer("OK").decision, "accept_and_continue");
  assert.equal(parseManualAnswer("取消").decision, "fail_safely");
  const revision = parseManualAnswer("テストを追加してから再提出してください");
  assert.equal(revision.decision, "revision_required");
  assert.equal(revision.nextClaudeInstruction, "テストを追加してから再提出してください");
  assert.equal(parseManualAnswer("   ").decision, null);

  const record = toReviewRecord(revision, { evidence: null });
  assert.equal(validate(record, REVIEW_SCHEMA).valid, true, "手動審査も同じスキーマで保存する");
});

test("審査方式: 既定は Claude で、切り替えは保存される", async () => {
  const h = await buildHarness();
  try {
    assert.equal(h.repo.getReviewProvider(h.config.review.provider), "claude", "初期設定は Claude 審査");
    h.repo.setReviewProvider("manual");
    assert.equal(h.repo.getReviewProvider(h.config.review.provider), "manual");
    h.repo.setReviewProvider("openai");
    assert.equal(h.repo.getReviewProvider(h.config.review.provider), "openai");
    assert.ok(h.repo.listAudit().some((a) => a.action === "settings.reviewProvider"), "切り替えを監査ログに残す");
  } finally {
    h.cleanup();
  }
});

test("TODO: 審査方式を戻したら、不要になった OpenAI キーの TODO は自動で閉じる", async () => {
  const h = await buildHarness();
  try {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    h.todoManager.requireOpenAiKey = true;
    assert.equal(h.todoManager.ensureEnvironmentTodos().length, 1);
    assert.equal(h.todoManager.closeObsoleteEnvironmentTodos().length, 0, "まだ必要なら閉じない");

    // Claude 審査へ戻す
    h.todoManager.requireOpenAiKey = false;
    assert.equal(h.todoManager.closeObsoleteEnvironmentTodos().length, 1, "不要になったら閉じる");
    assert.equal(h.repo.listTodos({ status: "open" }).length, 0);

    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  } finally {
    h.cleanup();
  }
});
