#!/usr/bin/env node
/**
 * 運用コマンド (指示書 §15)。
 *
 *   node src/cli.mjs <command>
 *   install | start | stop | restart | status | diagnose | repair | uninstall
 *   add-task | list-tasks | ingest
 *
 * 終了コードを正しく返し、次に必要な操作を日本語で示す。秘密値は表示しない。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, ensureDirs, PACKAGE_ROOT, DEFAULT_CONFIG_PATH } from "./config.mjs";
import { readConfigFile, quarantineConfigFile, writeConfigFile, salvageConfigText } from "./configFile.mjs";
import { startDiagnosticDashboard, readGitVersion } from "./diagnosticMode.mjs";
import { buildApp, runService, SingleInstanceLock, isLiveNodeProcess } from "./app.mjs";
import { Diagnostics } from "./diagnostics.mjs";
import { Store } from "./store/db.mjs";
import { Repo } from "./store/repo.mjs";
import { STATE_LABELS_JA } from "./core/states.mjs";

const EXIT = { OK: 0, CONFIG: 2, RUNTIME: 3, NOT_RUNNING: 4, ALREADY_RUNNING: 5 };

function say(line = "") {
  process.stdout.write(line + "\n");
}
function warn(line) {
  process.stderr.write(line + "\n");
}

function configPathInUse() {
  return process.env.BELLO_ORCHESTRATOR_CONFIG || DEFAULT_CONFIG_PATH;
}

/**
 * 設定ファイルの健全性だけを見る。設定が壊れていても必ず動く。
 * 「今どう壊れているか」を人が読める形で出し、Git の正常版と突き合わせる。
 */
async function cmdConfigCheck() {
  const configPath = configPathInUse();
  const read = readConfigFile(configPath);

  say("=== 設定ファイルの点検 ===");
  say(`  パス        : ${configPath}`);
  say(`  存在        : ${read.exists ? "あり" : "なし"}`);
  say(`  SHA-256     : ${read.sha256 ?? "-"}`);
  say(`  BOM         : ${read.hadBom ? "あり (UTF-8 BOM 付き)" : "なし (推奨)"}`);

  if (read.issues.length === 0) {
    say("  判定        : 健全 (UTF-8 として読め、JSON として正しい)");
    const gitText = readGitVersion(configPath);
    if (gitText !== null) {
      say(`  Git 正常版  : ${gitText === read.text ? "一致" : "差分あり (ユーザー設定の変更と思われます)"}`);
    }
    return EXIT.OK;
  }

  say("  判定        : 壊れています");
  say("");
  say("--- 検出した問題 ---");
  for (const issue of read.issues) {
    say(`  [${issue.kind}] ${issue.message}`);
    if (issue.sample) say(`      該当箇所: ${issue.sample}`);
  }

  const salvage = read.text ? salvageConfigText(read.text) : { salvaged: false, reason: "unreadable" };
  say("");
  say("--- 救出の見込み ---");
  if (salvage.salvaged) {
    say(`  ユーザー設定を失わずに復元できます (${salvage.reason})。`);
    say("  実行するには: node src/cli.mjs config-repair");
  } else {
    say(`  自動では復元できません (${salvage.reason})。`);
    say("  Git の正常版から戻す場合: git checkout -- bello-orchestrator.config.json");
    say("  (その場合、コミットしていないユーザー設定は失われます。まず隔離コピーを確認してください)");
  }
  return EXIT.CONFIG;
}

/**
 * 壊れた設定を修復する。手順は必ず 隔離 → 救出 → 検証 → atomic 置換 の順。
 * 元ファイルは削除しない。救出できなければ何も書き換えない。
 */
async function cmdConfigRepair() {
  const configPath = configPathInUse();
  const read = readConfigFile(configPath);

  if (!read.exists) {
    warn(`設定ファイルがありません: ${configPath}`);
    return EXIT.CONFIG;
  }
  if (read.issues.length === 0) {
    say("設定ファイルは健全です。修復するものはありません。");
    return EXIT.OK;
  }

  // 1. 触る前に証拠を残す。コピーであって移動ではないので、元ファイルは残る。
  const quarantine = quarantineConfigFile(configPath, {
    issues: read.issues,
    reason: "config-repair",
  });
  say("=== 証拠を隔離しました (元ファイルは削除していません) ===");
  say(`  コピー   : ${quarantine.copyPath}`);
  say(`  メタ情報 : ${quarantine.metaPath}`);
  say(`  SHA-256  : ${quarantine.meta.sha256}`);
  say("");

  // 2. ユーザー設定を失わない形で救出する。
  const salvage = read.text ? salvageConfigText(read.text) : { salvaged: false, reason: "unreadable", config: null };
  if (!salvage.salvaged) {
    warn(`自動では復元できません (${salvage.reason})。設定ファイルは書き換えていません。`);
    warn("隔離コピーを確認したうえで、Git の正常版から戻すか、手で直してください。");
    return EXIT.CONFIG;
  }

  // 3. 救出した設定が設定として妥当かを、書き込む前に検証する。
  //    ここでは環境依存の検査 (repoPath の実在など) はしない。
  //    対象リポジトリが今見えるかどうかと、文字化けを直せるかどうかは別の話。
  const merged = loadConfig(configPath, { salvage: true, checkEnvironment: false });
  if (merged.errors.length) {
    warn("救出した設定は検証を通りませんでした。設定ファイルは書き換えていません:");
    for (const e of merged.errors) warn(`  - ${e}`);
    return EXIT.CONFIG;
  }

  // 4. 一時ファイル → 再読込検証 → atomic replace。途中の状態がディスクに残らない。
  writeConfigFile(configPath, salvage.config);

  const after = readConfigFile(configPath);
  if (after.issues.length) {
    warn("書き戻した設定にまだ問題があります:");
    for (const i of after.issues) warn(`  - ${i.message}`);
    return EXIT.RUNTIME;
  }

  say(`修復しました (${salvage.reason})。`);
  say(`  新しい SHA-256 : ${after.sha256}`);
  say("  ユーザー設定は保持し、壊れていた $comment だけを取り除いています。");
  say("");
  say("次に: node src/cli.mjs config-check で健全性を確認し、bello.ps1 start で再起動してください。");
  return EXIT.OK;
}

/**
 * 設定が壊れているときの起動。危険な代替設定で本番を動かさない。
 * ダッシュボードだけを診断モードで出し、Claude 実行・キュー・inbox は起動しない。
 */
async function startDiagnostic(configPath, corruption) {
  let quarantine = null;
  try {
    quarantine = quarantineConfigFile(configPath, { issues: corruption?.issues ?? [], reason: "diagnostic_start" });
    warn(`壊れた設定を隔離保存しました: ${quarantine.copyPath} (sha256 ${quarantine.meta.sha256})`);
  } catch (err) {
    warn(`隔離保存に失敗しました: ${err.message}`);
  }

  const diag = await startDiagnosticDashboard({
    configPath,
    corruption,
    quarantine,
    appliedConfig: null,
    logLine: (line) => warn(line),
  });

  warn("");
  warn("診断モードです。タスクの自動実行・Claude 実行は行いません。");
  warn("復旧するには: node src/cli.mjs config-repair");
  warn("Ctrl+C で終了します。");

  await new Promise((resolve) => {
    const stop = () => resolve();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  await diag.close();
  return EXIT.CONFIG;
}

function loadOrExplain() {
  const loaded = loadConfig(process.env.BELLO_ORCHESTRATOR_CONFIG || undefined);
  for (const w of loaded.warnings) warn(`[警告] ${w}`);
  if (loaded.errors.length) {
    warn("[設定エラー] 起動できません:");
    for (const e of loaded.errors) warn(`  - ${e}`);
    warn("");
    warn(`設定ファイル: ${loaded.configPath}`);
    warn("上記を直してから、もう一度実行してください。");
    return null;
  }
  return loaded;
}

async function cmdStart(loaded, args) {
  ensureDirs(loaded.paths);
  // 明示起動は停止フラグを解除する (手動起動 = 起動意思)
  if (!args.includes("--watchdog")) {
    fs.rmSync(loaded.paths.stopFlag, { force: true });
  } else if (fs.existsSync(loaded.paths.stopFlag)) {
    say("停止フラグがあるため起動しません（意図的な停止中）。再開するには stop フラグを消すか start を手動実行してください。");
    return EXIT.OK;
  }
  return runService({ config: loaded.config, paths: loaded.paths });
}

function readPid(pidFile) {
  try {
    return Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
  } catch {
    return null;
  }
}

async function cmdStop(loaded) {
  const pid = readPid(loaded.paths.pidFile);
  fs.mkdirSync(path.dirname(loaded.paths.stopFlag), { recursive: true });
  fs.writeFileSync(loaded.paths.stopFlag, new Date().toISOString(), "utf8");
  if (pid && isLiveNodeProcess(pid)) {
    say(`停止フラグを書きました。Orchestrator (pid ${pid}) は数秒以内に安全停止します。`);
    say("実行中の Claude タスクがある場合は、その終了を待ってから停止します。");
    return EXIT.OK;
  }
  say("Orchestrator は起動していません。停止フラグだけ書きました（次回の自動起動を抑止します）。");
  say("再開するには: bello.ps1 start");
  return EXIT.NOT_RUNNING;
}

/**
 * 意図的な停止 / crash-loop クールダウンを解除する。
 * 「人が start と打った」= 起動の意思表示なので、ウォッチドッグ用の待機指示を消す。
 * これが無いと bello.ps1 start がフラグに阻まれて何も起きない。
 */
async function cmdResume(loaded) {
  const cleared = [];
  for (const [label, file] of [
    ["停止フラグ", loaded.paths.stopFlag],
    ["停止フラグ(記録済み)", loaded.paths.stopFlag + ".ack"],
    ["crash-loop クールダウン", loaded.paths.crashLoopFlag],
    ["crash-loop クールダウン(記録済み)", loaded.paths.crashLoopFlag + ".ack"],
  ]) {
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      cleared.push(label);
    }
  }
  if (cleared.length === 0) say("解除するものはありませんでした。");
  else say("解除しました: " + cleared.join(" / "));
  return EXIT.OK;
}

async function cmdStatus(loaded) {
  const pid = readPid(loaded.paths.pidFile);
  const alive = pid ? isLiveNodeProcess(pid) : false;
  say("=== BELLO Dev Orchestrator 状態 ===");
  say(`  プロセス      : ${alive ? `稼働中 (pid ${pid})` : "停止中"}`);
  say(`  停止フラグ    : ${fs.existsSync(loaded.paths.stopFlag) ? "あり（意図的な停止中）" : "なし"}`);
  say(`  データ置き場  : ${loaded.paths.dataRoot}`);
  say(`  ダッシュボード: http://${loaded.config.dashboard.host}:${loaded.config.dashboard.port}/`);

  if (!fs.existsSync(loaded.paths.dbFile)) {
    say("  キュー        : DB 未作成（まだ一度も起動していません）");
    return alive ? EXIT.OK : EXIT.NOT_RUNNING;
  }
  const store = await Store.open(loaded.paths.dbFile);
  const repo = new Repo(store);
  const counts = repo.countByState();
  const open = repo.listTodos({ status: "open" });
  say("  キュー内訳    :");
  const keys = Object.keys(counts);
  if (keys.length === 0) say("      (タスクなし)");
  for (const key of keys) say(`      ${(STATE_LABELS_JA[key] ?? key).padEnd(12)} ${counts[key]}`);
  say(`  未完了 TODO   : ${open.length} 件${open.length ? `（緊急 ${open.filter((t) => t.priority === "urgent").length} 件）` : ""}`);
  for (const todo of open.slice(0, 5)) say(`      - [${todo.category}] ${todo.title}`);
  const running = repo.listTasks({ state: "running", limit: 1 })[0];
  if (running) {
    say(`  実行中タスク  : ${running.title}`);
    say(`  最終ハートビート: ${running.heartbeat_at ?? "—"}`);
  }
  store.close();
  return alive ? EXIT.OK : EXIT.NOT_RUNNING;
}

async function cmdDiagnose(loaded) {
  ensureDirs(loaded.paths);
  let repo = null;
  let store = null;
  if (fs.existsSync(loaded.paths.dbFile)) {
    store = await Store.open(loaded.paths.dbFile);
    repo = new Repo(store);
  }
  const diagnostics = new Diagnostics({ config: loaded.config, paths: loaded.paths, repo, logger: console });
  const report = await diagnostics.report();
  say("=== 自己診断 ===");
  for (const line of Diagnostics.summarize(report)) say("  " + line);
  say("");
  say("次に必要な操作:");
  const todos = [];
  if (!report.claude.found) todos.push("Claude Code をインストールし、claude.executable を設定してください。");
  if (!report.review.apiKeyConfigured) {
    todos.push("OPENAI_API_KEY を設定すると AI 審査が有効になります（未設定でも他の機能は動きます）。");
  }
  if (!report.scheduledTasks.orchestrator.registered) {
    todos.push("常駐させるには bello.ps1 install を実行してください。");
  }
  if (!report.storage.writable) todos.push(`実行時データ ${report.storage.dataRoot} に書き込めません。権限を確認してください。`);
  if (todos.length === 0) say("  ありません。すべて正常です。");
  for (const t of todos) say("  - " + t);

  const evidencePath = path.join(loaded.paths.evidenceDir, `diagnose-${Date.now()}.json`);
  fs.mkdirSync(loaded.paths.evidenceDir, { recursive: true });
  fs.writeFileSync(evidencePath, JSON.stringify(report, null, 2), "utf8");
  say("");
  say(`診断結果を保存しました: ${evidencePath}`);
  if (store) store.close();
  return report.sqlite.ok && report.git.isRepo ? EXIT.OK : EXIT.RUNTIME;
}

/** 安全に直せる設定だけを直す (§15 repair)。 */
async function cmdRepair(loaded) {
  ensureDirs(loaded.paths);
  const fixed = [];

  const pid = readPid(loaded.paths.pidFile);
  if (pid && !isLiveNodeProcess(pid)) {
    fs.rmSync(loaded.paths.pidFile, { force: true });
    fixed.push(`古い PID ファイルを削除しました (pid ${pid} は存在しません)`);
  }

  if (fs.existsSync(loaded.paths.dbFile)) {
    const store = await Store.open(loaded.paths.dbFile);
    const integrity = store.integrityCheck();
    if (!integrity.ok) {
      warn(`DB の整合性検査に失敗しています: ${integrity.detail}`);
      warn("DB の自動再作成は行いません（タスク履歴を失うため）。バックアップを取ってから対応してください。");
      store.close();
      return EXIT.RUNTIME;
    }
    // 中断状態の掃除は Orchestrator.recover() が行う。ここでは検査のみ。
    fixed.push("DB の整合性は正常です");
    store.close();
  }

  say("=== 修復結果 ===");
  if (fixed.length === 0) say("  直すものはありませんでした。");
  for (const f of fixed) say("  - " + f);
  say("");
  say("常駐設定そのものの修復は bello.ps1 install を再実行してください（既存タスクを上書き更新します）。");
  return EXIT.OK;
}

async function cmdAddTask(loaded, args) {
  const titleIndex = args.indexOf("--title");
  const fileIndex = args.indexOf("--file");
  const priorityIndex = args.indexOf("--priority");
  if (titleIndex < 0 || fileIndex < 0) {
    warn('使い方: node src/cli.mjs add-task --title "件名" --file <指示本文のテキストファイル> [--priority 50]');
    return EXIT.CONFIG;
  }
  const title = args[titleIndex + 1];
  const file = args[fileIndex + 1];
  if (!fs.existsSync(file)) {
    warn(`指示ファイルが見つかりません: ${file}`);
    return EXIT.CONFIG;
  }
  const instruction = fs.readFileSync(file, "utf8");

  const store = await Store.open(loaded.paths.dbFile);
  const repo = new Repo(store);
  const { task, created } = repo.createTask({
    title,
    instruction,
    source: "user_ui",
    priority: priorityIndex >= 0 ? Number.parseInt(args[priorityIndex + 1], 10) : 50,
    repoPath: loaded.config.repoPath,
    maxAttempts: loaded.config.queue.maxAttempts,
    maxRevisions: loaded.config.review.maxRevisions,
  });
  say(created ? `登録しました: ${task.id} ${task.title}` : `同じ内容のタスクが既にあります: ${task.id}`);
  store.close();
  return EXIT.OK;
}

/**
 * タスクごとの作業場所を一覧する。証拠がどこにあるかを人が追えるようにする。
 */
async function cmdWorktrees(loaded) {
  const { listWorktrees, canRemoveWorktree } = await import("./core/worktree.mjs");

  say("=== 登録されている worktree ===");
  for (const w of listWorktrees(loaded.config.repoPath)) {
    const kind = w.path === loaded.config.repoPath ? "（本体リポジトリ）" : "";
    say(`  ${w.branch ?? "(detached)"}`.padEnd(42) + ` ${w.path} ${kind}`);
  }

  if (!fs.existsSync(loaded.paths.dbFile)) return EXIT.OK;
  const store = await Store.open(loaded.paths.dbFile);
  const repo = new Repo(store);

  say("");
  say("=== タスクごとの作業場所 ===");
  let shown = 0;
  for (const task of repo.listTasks({ limit: 200 })) {
    if (!task.worktree_path) continue;
    shown += 1;
    const exists = fs.existsSync(task.worktree_path);
    const check = exists
      ? canRemoveWorktree({
          repoPath: task.repo_path,
          worktreePath: task.worktree_path,
          branch: task.worktree_branch,
          baseBranch: task.base_branch,
        })
      : { removable: false, reasons: ["フォルダがありません"] };
    say(`  ${task.id}  [${(STATE_LABELS_JA[task.state] ?? task.state)}] ${task.title.slice(0, 40)}`);
    say(`      ブランチ  : ${task.worktree_branch}`);
    say(`      作業場所  : ${task.worktree_path}${exists ? "" : "（既にありません）"}`);
    say(`      基準      : ${task.base_branch ?? "-"} @ ${String(task.base_commit ?? "-").slice(0, 10)}`);
    say(`      削除可否  : ${check.removable ? "安全に削除できます" : "残します — " + check.reasons.join(" / ")}`);
  }
  if (shown === 0) say("  （専用 worktree を使ったタスクはまだありません）");
  say("");
  say("安全に削除できるものだけを消すには: node src/cli.mjs prune-worktrees");
  store.close();
  return EXIT.OK;
}

/** 安全確認を通った worktree だけを消す。ブランチは証拠として残す。 */
async function cmdPruneWorktrees(loaded) {
  const { removeWorktreeIfSafe, pruneWorktreeRegistrations } = await import("./core/worktree.mjs");
  if (!fs.existsSync(loaded.paths.dbFile)) {
    say("まだタスクがありません。");
    return EXIT.OK;
  }
  const store = await Store.open(loaded.paths.dbFile);
  const repo = new Repo(store);

  let removed = 0;
  let kept = 0;
  for (const task of repo.listTasks({ limit: 200 })) {
    if (!task.worktree_path || !fs.existsSync(task.worktree_path)) continue;
    const result = removeWorktreeIfSafe({
      repoPath: task.repo_path,
      worktreePath: task.worktree_path,
      branch: task.worktree_branch,
      baseBranch: task.base_branch,
      logger: null,
    });
    if (result.removed) {
      say(`  削除: ${task.worktree_path}（ブランチ ${task.worktree_branch} は残します）`);
      repo.audit("user", "worktree.removed", task.id, task.worktree_branch, null);
      removed += 1;
    } else {
      say(`  残す: ${task.worktree_path} — ${result.reasons.join(" / ")}`);
      kept += 1;
    }
  }
  pruneWorktreeRegistrations(loaded.config.repoPath);
  say("");
  say(`削除 ${removed} 件 / 残した ${kept} 件。ブランチは 1 つも消していません。`);
  store.close();
  return EXIT.OK;
}

async function cmdListTasks(loaded) {
  if (!fs.existsSync(loaded.paths.dbFile)) {
    say("まだタスクはありません。");
    return EXIT.OK;
  }
  const store = await Store.open(loaded.paths.dbFile);
  const repo = new Repo(store);
  for (const task of repo.listTasks({ limit: 100 })) {
    say(
      `${task.id}  ${(STATE_LABELS_JA[task.state] ?? task.state).padEnd(12)} 優先${String(task.priority).padStart(3)}  ${task.title}`,
    );
  }
  store.close();
  return EXIT.OK;
}

async function cmdIngest(loaded) {
  const app = await buildApp({ config: loaded.config, paths: loaded.paths });
  const handled = await app.intake.scanInbox();
  say(`inbox を確認しました。処理件数: ${handled}`);
  say(`inbox の場所: ${loaded.paths.inboxDir}`);
  app.store.close();
  return EXIT.OK;
}

function delegateToPowerShell(command, extraArgs = []) {
  const script = path.join(PACKAGE_ROOT, "bello.ps1");
  if (!fs.existsSync(script)) {
    warn(`bello.ps1 が見つかりません: ${script}`);
    return EXIT.RUNTIME;
  }
  const res = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, command, ...extraArgs],
    { stdio: "inherit" },
  );
  return res.status ?? EXIT.RUNTIME;
}

async function main() {
  const [, , rawCommand, ...args] = process.argv;
  const command = (rawCommand || "status").toLowerCase();

  if (command === "help" || command === "--help" || command === "-h") {
    say("BELLO Dev Orchestrator");
    say("");
    say("  install    依存確認・ディレクトリ作成・設定検証・Scheduled Task 登録");
    say("  start      起動（常駐は Scheduled Task から呼ばれます）");
    say("  stop       安全停止");
    say("  restart    再起動");
    say("  status     稼働状態・キュー・TODO");
    say("  diagnose   自己診断（Claude / OpenAI 設定 / DB / 権限 / タスク / ディスク）");
    say("  repair     安全に直せる設定のみ修復");
    say("  config-check   設定ファイルの文字化け / 破損を点検する（壊れていても動く）");
    say("  config-repair  隔離 → 救出 → 検証 → atomic 置換で設定ファイルを復旧する");
    say("  resume     停止フラグ / crash-loop クールダウンを解除する");
    say("  uninstall  常駐登録の解除（プログラム本体と実行時データは消しません）");
    say("");
    say('  add-task --title "件名" --file 指示.txt [--priority 50]');
    say("  list-tasks");
    say("  ingest     inbox の .docx を今すぐ取り込む");
    say("  worktrees        タスクごとの作業場所とブランチを一覧する");
    say("  prune-worktrees  安全確認を通った worktree だけを削除する（ブランチは残す）");
    return EXIT.OK;
  }

  if (command === "install" || command === "uninstall" || command === "restart") {
    return delegateToPowerShell(command, args);
  }

  // 設定が壊れていても動かないといけないコマンド。先に処理する。
  if (command === "config-check") return cmdConfigCheck();
  if (command === "config-repair") return cmdConfigRepair();

  const loaded = loadOrExplain();
  if (!loaded) {
    // 設定ファイル自体が壊れている場合、常駐起動だけは「無言で止まる」より
    // 「診断モードで理由を見せる」ほうが安全に運用できる。
    // ただしタスク実行は一切しない。
    const probe = loadConfig(process.env.BELLO_ORCHESTRATOR_CONFIG || undefined);
    if (command === "start" && probe.corruption) {
      return startDiagnostic(probe.configPath, probe.corruption);
    }
    if (probe.corruption) {
      warn("");
      warn("設定ファイルが壊れています。次で詳細と復旧手順を確認してください:");
      warn("  node src/cli.mjs config-check");
    }
    return EXIT.CONFIG;
  }

  switch (command) {
    case "start":
      return cmdStart(loaded, args);
    case "stop":
      return cmdStop(loaded);
    case "status":
      return cmdStatus(loaded);
    case "diagnose":
      return cmdDiagnose(loaded);
    case "repair":
      return cmdRepair(loaded);
    case "resume":
      return cmdResume(loaded);
    case "add-task":
      return cmdAddTask(loaded, args);
    case "list-tasks":
      return cmdListTasks(loaded);
    case "ingest":
      return cmdIngest(loaded);
    case "worktrees":
      return cmdWorktrees(loaded);
    case "prune-worktrees":
      return cmdPruneWorktrees(loaded);
    default:
      warn(`不明なコマンドです: ${command}`);
      warn("使い方は: node src/cli.mjs help");
      return EXIT.CONFIG;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main()
    .then((code) => process.exit(typeof code === "number" ? code : EXIT.OK))
    .catch((err) => {
      warn(`予期しないエラー: ${err.message}`);
      warn(err.stack ?? "");
      process.exit(EXIT.RUNTIME);
    });
}
