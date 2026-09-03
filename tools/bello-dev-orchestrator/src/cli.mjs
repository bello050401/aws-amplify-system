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
import { loadConfig, ensureDirs, PACKAGE_ROOT } from "./config.mjs";
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
    say("  uninstall  常駐登録の解除（プログラム本体と実行時データは消しません）");
    say("");
    say('  add-task --title "件名" --file 指示.txt [--priority 50]');
    say("  list-tasks");
    say("  ingest     inbox の .docx を今すぐ取り込む");
    return EXIT.OK;
  }

  if (command === "install" || command === "uninstall" || command === "restart") {
    return delegateToPowerShell(command, args);
  }

  const loaded = loadOrExplain();
  if (!loaded) return EXIT.CONFIG;

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
    case "add-task":
      return cmdAddTask(loaded, args);
    case "list-tasks":
      return cmdListTasks(loaded);
    case "ingest":
      return cmdIngest(loaded);
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
