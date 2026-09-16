/**
 * アプリケーション組み立て (Supervisor から起動される本体)。
 *
 * 単一起動、復旧、Orchestrator ループ、inbox 監視、ダッシュボードをまとめる。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureDirs } from "./config.mjs";
import { Store } from "./store/db.mjs";
import { Repo } from "./store/repo.mjs";
import { Logger } from "./log/logger.mjs";
import { registerEnvSecrets } from "./log/redact.mjs";
import { Orchestrator } from "./core/orchestrator.mjs";
import { ClaudeRunner } from "./runner/claudeRunner.mjs";
import { OpenAiReviewEngine } from "./review/openaiReview.mjs";
import { ClaudeReviewEngine } from "./review/claudeReview.mjs";
import { TodoManager } from "./todo/todoManager.mjs";
import { DocumentIntake } from "./intake/documentIntake.mjs";
import { Dashboard } from "./dashboard/server.mjs";
import { Diagnostics } from "./diagnostics.mjs";
import { CodexRunner, ImplementationRouter } from "./runner/codexRunner.mjs";
import { IndependentVerifier } from "./pipeline/verification.mjs";
import { StagingDelivery } from "./pipeline/staging.mjs";
import { AmplifyStaticDelivery } from "./pipeline/staticStaging.mjs";
import { Notifications } from "./pipeline/notifications.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** pid が生きていて、かつ node プロセスかを確かめる (PID 再利用の誤認防止 §6-2)。 */
export function isLiveNodeProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform !== "win32") {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  const res = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if ($p) { $p.Name } else { '' }`,
    ],
    { encoding: "utf8", timeout: 20000 },
  );
  return /^node(\.exe)?$/i.test(String(res.stdout ?? "").trim());
}

export class SingleInstanceLock {
  constructor(pidFile) {
    this.pidFile = pidFile;
    this.acquired = false;
  }

  acquire() {
    fs.mkdirSync(path.dirname(this.pidFile), { recursive: true });
    if (fs.existsSync(this.pidFile)) {
      const raw = fs.readFileSync(this.pidFile, "utf8").trim();
      const other = Number.parseInt(raw, 10);
      if (isLiveNodeProcess(other) && other !== process.pid) {
        return { acquired: false, otherPid: other };
      }
      // 死んだプロセスの残骸なので引き継ぐ
      fs.rmSync(this.pidFile, { force: true });
    }
    fs.writeFileSync(this.pidFile, String(process.pid), "utf8");
    this.acquired = true;
    return { acquired: true, otherPid: null };
  }

  release() {
    if (!this.acquired) return;
    try {
      const raw = fs.readFileSync(this.pidFile, "utf8").trim();
      if (Number.parseInt(raw, 10) === process.pid) fs.rmSync(this.pidFile, { force: true });
    } catch {
      /* 既に消えている */
    }
    this.acquired = false;
  }
}

export async function buildApp({ config, paths, echoLogs = true }) {
  registerEnvSecrets();
  ensureDirs(paths);

  const logger = new Logger({
    dir: paths.logDir,
    name: "orchestrator",
    level: config.logging.level,
    maxFileBytes: config.logging.maxFileBytes,
    maxFiles: config.logging.maxFiles,
    echo: echoLogs,
  });
  logger.purgeOlderThan(config.logging.retentionDays);

  const store = await Store.open(paths.dbFile);
  const repo = new Repo(store);
  const todoManager = new TodoManager({ repo, logger });
  const runner = new ImplementationRouter({ config, repo, runners: {
    claude: new ClaudeRunner({ config, paths, logger }),
    codex: new CodexRunner({ config, paths, logger }),
  } });
  const verifier = new IndependentVerifier({ config, paths, repo });
  const delivery = new (config.staging?.mode === "static-smoke" ? AmplifyStaticDelivery : StagingDelivery)({ config, repo, verifier });
  const notifications = new Notifications({ config, repo });
  // 審査方式は実行時に選べる。既定は追加課金の要らない Claude 審査。
  // OpenAI は削除せず、選べば使えるオプションとして常に組み立てておく。
  const reviewEngines = {
    claude: new ClaudeReviewEngine({ config, paths, logger }),
    openai: new OpenAiReviewEngine({ config, logger }),
  };
  const intake = new DocumentIntake({ config, paths, repo, logger });
  const diagnostics = new Diagnostics({ config, paths, repo, logger });
  const orchestrator = new Orchestrator({ config, paths, repo, logger, runner, reviewEngines, todoManager, verifier, delivery });

  return { logger, store, repo, todoManager, runner, reviewEngines, intake, diagnostics, orchestrator, notifications };
}

/**
 * 常駐実行。Supervisor (Scheduled Task) から起動される想定。
 */
export async function runService({ config, paths, appFactory = buildApp }) {
  const lock = new SingleInstanceLock(paths.pidFile);
  const acquisition = lock.acquire();
  if (!acquisition.acquired) {
    process.stderr.write(
      `既に Orchestrator が起動しています (pid ${acquisition.otherPid})。二重起動はしません。\n`,
    );
    return 0;
  }

  let app;
  try {
    app = await appFactory({ config, paths });
  } catch (err) {
    lock.release();
    throw err;
  }
  const { logger, orchestrator, intake, repo, todoManager, diagnostics, store } = app;
  let notificationWork = null;

  logger.info("BELLO Dev Orchestrator を起動します", {
    pid: process.pid,
    node: process.version,
    repoPath: config.repoPath,
    dataRoot: paths.dataRoot,
  });

  // 環境不足に応じた初期 TODO (§8-3)。
  // 既定の審査方式 (Claude) は API キーを要らないので、通常は何も作られない。
  todoManager.requireOpenAiKey = repo.getReviewProvider(config.review.provider) === "openai";
  todoManager.ensureEnvironmentTodos();
  todoManager.closeObsoleteEnvironmentTodos();
  logger.info("審査方式", { provider: repo.getReviewProvider(config.review.provider) });

  // 中断復旧 (§6-3)
  try {
    await orchestrator.recover();
  } catch (err) {
    store.close();
    lock.release();
    throw err;
  }

  let dashboard = null;
  if (config.dashboard.enabled) {
    dashboard = new Dashboard({
      config,
      paths,
      repo,
      logger,
      orchestrator,
      todoManager,
      intake,
      diagnostics,
    });
    try {
      await dashboard.start();
    } catch (err) {
      logger.error("ダッシュボードを起動できませんでした", { error: err.message });
      dashboard = null;
    }
  }

  let stopping = false;
  let inboxWork = null;
  const requestShutdown = (why) => {
    if (stopping) return;
    stopping = true;
    logger.info("停止処理を開始します", { why });
    orchestrator.stop();
    // シャットダウン通知時もチェックポイントを残す (§11-3)
    if (orchestrator.currentTaskId) {
      repo.checkpoint(orchestrator.currentTaskId, "shutdown", { why, at: new Date().toISOString() });
    }
    repo.audit("system", "orchestrator.stop", null, why, null);
  };

  const signalHandlers = new Map(["SIGINT", "SIGTERM", "SIGHUP"].map(signal => [signal, () => requestShutdown(signal)]));
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);

  // stop.flag を監視する (PowerShell 側からの安全停止)
  const stopWatcher = setInterval(() => {
    if (fs.existsSync(paths.stopFlag)) {
      logger.info("停止フラグを検出しました");
      requestShutdown("stop.flag");
    }
  }, 3000);

  // inbox 監視 (§9-1)
  const inboxTimer = setInterval(() => {
    if (stopping || inboxWork) return;
    inboxWork = intake.scanInbox()
      .catch((err) => logger.error("inbox 監視で例外", { error: err.message }))
      .finally(() => { inboxWork = null; });
  }, config.intake.pollIntervalSeconds * 1000);
  const notificationTimer = setInterval(() => {
    if (stopping || notificationWork || !app.notifications) return;
    notificationWork = app.notifications.tick().catch(err => logger.error("通知処理の失敗", { error: err.message })).finally(() => { notificationWork = null; });
  }, 1000);

  try {
    await orchestrator.runLoop();
  } finally {
    clearInterval(inboxTimer);
    clearInterval(stopWatcher);
    clearInterval(notificationTimer);
    requestShutdown("loop_exit");
    try {
      if (dashboard) await dashboard.stop();
      if (inboxWork) await inboxWork;
      if (notificationWork) await notificationWork;
    } finally {
      store.close();
      lock.release();
      for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    }
  }
  return 0;
}

export { sleep };
