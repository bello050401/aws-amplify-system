/**
 * 画面確認用の、隔離したダッシュボードを立てる。
 *
 * なぜ隔離するか:
 *   稼働中の Orchestrator にデモ用のタスクを入れると、本当に Claude が動き出す。
 *   実際に一度それが起きたので、画面確認は必ず別インスタンスで行う。
 *   ここでは Orchestrator を動かさず、ダッシュボードだけを一時 DB の上で動かす。
 *
 * 使い方:
 *   node test/manual/ui-demo-server.mjs            # 立ち上げっぱなし (Ctrl+C で終了)
 *   node test/manual/ui-demo-server.mjs --port 4399
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { derivePaths, ensureDirs, loadConfig } from "../../src/config.mjs";
import { Store } from "../../src/store/db.mjs";
import { Repo } from "../../src/store/repo.mjs";
import { Logger } from "../../src/log/logger.mjs";
import { TodoManager } from "../../src/todo/todoManager.mjs";
import { DocumentIntake } from "../../src/intake/documentIntake.mjs";
import { Diagnostics } from "../../src/diagnostics.mjs";
import { Dashboard } from "../../src/dashboard/server.mjs";
import { STATES } from "../../src/core/states.mjs";

const portIndex = process.argv.indexOf("--port");
const PORT = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 4399;

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bello-ui-demo-"));
const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "bello-ui-repo-"));
spawnSync("git", ["init", "-q"], { cwd: repoPath });
spawnSync("git", ["config", "user.email", "demo@example.com"], { cwd: repoPath });
spawnSync("git", ["config", "user.name", "demo"], { cwd: repoPath });
fs.writeFileSync(path.join(repoPath, "README.md"), "# demo\n");
spawnSync("git", ["add", "--", "README.md"], { cwd: repoPath });
spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: repoPath });

const base = loadConfig();
const config = {
  ...base.config,
  repoPath,
  dataRoot,
  dashboard: { ...base.config.dashboard, enabled: true, host: "127.0.0.1", port: PORT, lanAccess: false },
};
const paths = derivePaths(config);
ensureDirs(paths);

const logger = new Logger({ dir: paths.logDir, name: "ui-demo", level: "error", echo: false });
const store = await Store.open(paths.dbFile);
const repo = new Repo(store);
const todoManager = new TodoManager({ repo, logger });
const intake = new DocumentIntake({ config, paths, repo, logger });
const diagnostics = new Diagnostics({ config, paths, repo, logger });

// ---- 見せたい状態を作る -----------------------------------------------
function makeTask(title, source, states, extra = {}) {
  const { task } = repo.createTask({ title, instruction: `${title} の指示内容（画面確認用のダミーです）`, source, repoPath });
  for (const st of states) repo.setState(task.id, st, "画面確認用", "system");
  if (Object.keys(extra).length) repo.updateTask(task.id, extra);
  return repo.getTask(task.id);
}

const running = makeTask(
  "在庫検索の応答を 1 秒以内にする",
  "user_ui",
  [STATES.PREFLIGHT, STATES.RUNNING, STATES.VERIFYING, STATES.AWAITING_AI_REVIEW],
  {
    revision_count: 1,
    started_at: new Date(Date.now() - 8 * 60 * 1000 - 23 * 1000).toISOString(),
    isolation: "worktree",
    worktree_branch: "bello/task/task_demo",
    work_dir: path.join(paths.worktreeRoot, "task_demo"),
    base_branch: "main",
    base_commit: "0e6642ee59234d1204c25e4ed91851b09f9cda5d",
    changed_files: JSON.stringify(["lib/inventory/search.ts", "lib/inventory/searchIndex.ts"]),
  },
);

makeTask("メッセージ画面に商品カードを出す", "user_document", []);
makeTask("出品テンプレートの文言を見直す", "user_ui", []);

const done1 = makeTask(
  "ZAICO 同期を差分方式にする",
  "user_ui",
  [STATES.PREFLIGHT, STATES.RUNNING, STATES.VERIFYING, STATES.AWAITING_AI_REVIEW, STATES.COMPLETED],
);
const done2 = makeTask(
  "配送料の計算を実測値に合わせる",
  "user_document",
  [STATES.PREFLIGHT, STATES.RUNNING, STATES.VERIFYING, STATES.AWAITING_AI_REVIEW, STATES.COMPLETED],
);
makeTask(
  "外部 API の疎通確認",
  "system",
  [STATES.PREFLIGHT, STATES.RUNNING, STATES.RETRY_WAIT, STATES.QUEUED, STATES.PREFLIGHT, STATES.FAILED],
  { last_error: "接続がタイムアウトしました。ネットワークを確認してください。" },
);

// 完了報告と審査結果（詳細画面の中身）
const reportId = repo.saveReport(done1.id, 1, {
  taskId: done1.id,
  status: "completed",
  summary: "差分同期に切り替え、日次で 5,325 件 → 48 件になりました。",
  changes: [{ path: "lib/zaico/sync.ts", purpose: "差分取得に変更" }],
  commandsRun: [{ commandRedacted: "npm run verify:zaico", exitCode: 0, purpose: "同期の検証" }],
  tests: [{ name: "npm run verify:zaico", result: "passed", evidencePath: "" }],
  git: { branch: "bello/task/x", commitCreated: true, workingTreeSummary: "clean" },
  userActions: [],
  riskFlags: [],
});
repo.updateTask(done1.id, { report_id: reportId });
repo.saveReview(
  done1.id,
  reportId,
  {
    decision: "accept_and_continue",
    reason: "git diff とテストを自分で実行して確認しました。報告どおり差分同期になっており、件数も一致します。",
    acceptanceCriteriaResults: [{ criterion: "同期件数が減ること", result: "passed", evidence: "48 件を確認" }],
    nextClaudeInstruction: null,
    userTodos: [],
    riskFlags: [],
    shouldRunNextQueuedTask: true,
    confidence: 0.92,
  },
  { model: "claude-sonnet-5", promptVersion: "bello-review-v1", provider: "claude" },
);

todoManager.createFromUserAction(
  {
    category: "auth",
    title: "BASE の再接続をお願いします",
    reason: "アクセストークンの期限が切れており、出品の同期ができません。",
    steps: ["管理画面の「設定」を開く", "BASE の「再接続」を押す", "BASE 側で許可する"],
    completionCondition: "設定画面に「接続済み」と表示されること",
    canUseIPhone: true,
    estimatedMinutes: 5,
    priority: "urgent",
  },
  { waitingTaskIds: [running.id], source: "demo" },
);
todoManager.createFromUserAction(
  {
    category: "visual_review",
    title: "商品ページの見た目を確認してください",
    reason: "自動テストでは判断できない見た目の確認が必要です。",
    steps: ["ステージングの商品ページを開く", "写真の並びと余白を見る"],
    completionCondition: "問題なければ「合格」、直したい点があればその内容を回答してください",
    canUseIPhone: false,
    estimatedMinutes: 10,
  },
  { waitingTaskIds: [running.id], source: "demo" },
);

// 取り込み済み Word 文書
const doc = repo.createDocument({
  originalName: "在庫検索の改善要望.docx",
  sha256: "demo-".padEnd(64, "0"),
  byteSize: 24680,
  parseState: "extracting",
});
repo.updateDocument(doc.id, {
  parse_state: "extracted",
  extracted_text: "# 在庫検索の改善\n\n検索が遅いので 1 秒以内にしたい。\n\n- 型番の部分一致も拾ってほしい\n- 並び順を保存してほしい",
  has_images: 1,
  image_count: 2,
  table_count: 1,
  has_tables: 1,
});

// Orchestrator は動かさない。ダッシュボードが必要とする最小限だけを渡す。
const stubOrchestrator = {
  currentTaskId: running.id,
  paused: false,
  pause() {
    this.paused = true;
  },
  resume() {
    this.paused = false;
  },
  requestStopCurrent() {},
};

const dashboard = new Dashboard({
  config,
  paths,
  repo,
  logger,
  orchestrator: stubOrchestrator,
  todoManager,
  intake,
  diagnostics,
});
await dashboard.start();

console.log(`画面確認用ダッシュボード: http://127.0.0.1:${PORT}/`);
console.log(`一時データ: ${dataRoot}`);
console.log("Ctrl+C で終了します。");

const shutdown = async () => {
  await dashboard.stop();
  store.close();
  try {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(repoPath, { recursive: true, force: true });
  } catch {
    /* 使用中なら残す */
  }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
