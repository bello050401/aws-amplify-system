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
import { registerEnvSecrets, registerSecret } from "./log/redact.mjs";
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
import { createEcoRuntime } from "./eco/serviceRuntime.mjs";
import { createServiceBindings } from "./eco/serviceBindings.mjs";

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

export async function buildApp({ config, paths, echoLogs = true, ecoBindings = null }) {
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
  // 接続元 (ホスト) は注入で差し替えられる (テスト互換)。差し替えが無ければ、この
  // プロセス自身が唯一対応する static-smoke profile を実際に組み立てる。
  // eco-runtime.json が無い・不一致なら createServiceBindings 自身が正直に
  // 「未接続」を返すので、ここではそれ以上の判定をしない。
  const resolvedEcoBindings = ecoBindings ?? createServiceBindings({ config, paths, repo, logger });
  // 実probeは、接続に成功した (=refreshProbes を持つ) bindings に対してだけ、
  // 起動時に一度だけ行う。失敗しても「未接続」として記録されるだけで、
  // 起動そのものは止めない。
  if (typeof resolvedEcoBindings?.refreshProbes === "function") {
    resolvedEcoBindings.refreshProbes().catch((err) => {
      logger.warn("協調eco の起動時probeに失敗しました", { error: err.message });
    });
  }
  // eco operator token はここでしか読まない。BELLO_ECO_OPERATOR_TOKEN が明示されて
  // いればそれを優先し、無ければ paths.dataRoot/eco-operator-token をホストだけが
  // 用意するファイルとして読む。値はログにも API 応答にも出さない
  // (registerSecret で redact 対象へ登録するのみ)。
  let operatorToken = process.env.BELLO_ECO_OPERATOR_TOKEN || "";
  if (!operatorToken) {
    try {
      operatorToken = fs.readFileSync(path.join(paths.dataRoot, "eco-operator-token"), "utf8").trim();
    } catch {
      operatorToken = "";
    }
  }
  if (operatorToken) registerSecret(operatorToken);
  // 旧キューの一時停止・スキーマ導入には一切触らない。bindings が無ければ
  // 「接続不可」を正直に返す常駐接続だけを組み立てる。
  const ecoRuntime = createEcoRuntime({ store, repo, config, paths, logger, bindings: resolvedEcoBindings, operatorToken });

  return { logger, store, repo, todoManager, runner, reviewEngines, intake, diagnostics, orchestrator, notifications, ecoRuntime };
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
  const { logger, orchestrator, intake, repo, todoManager, diagnostics, store, ecoRuntime } = app;
  let notificationWork = null;
  let ecoWork = null;

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
      ecoRuntime,
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
  // 停止通知を受けた時点で eco の停止 signal を立てる。legacy 実行の完了待ちの
  // 間、eco が新しい副作用を発行し続けることを防ぐため、finally まで待たない。
  let ecoStopPromise = null;
  const requestShutdown = (why) => {
    if (stopping) return;
    stopping = true;
    logger.info("停止処理を開始します", { why });
    orchestrator.stop();
    if (ecoRuntime) ecoStopPromise = ecoRuntime.stop();
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
  // 常駐協調eco接続。並列tickは ecoRuntime.tick() 自身が防ぐが、ここでも
  // 二重スケジュールしない (§inbox/notification と同じ形)。
  const ecoTimer = setInterval(() => {
    if (stopping || ecoWork || !ecoRuntime) return;
    ecoWork = ecoRuntime.tick().catch(err => logger.error("協調eco tick の失敗", { error: err.message })).finally(() => { ecoWork = null; });
  }, 2000);

  try {
    await orchestrator.runLoop();
  } finally {
    clearInterval(inboxTimer);
    clearInterval(stopWatcher);
    clearInterval(notificationTimer);
    clearInterval(ecoTimer);
    requestShutdown("loop_exit");
    try {
      if (dashboard) await dashboard.stop();
      if (inboxWork) await inboxWork;
      if (notificationWork) await notificationWork;
      // stop signal は requestShutdown で既に立てている。ここでは、その同じ
      // Promise を待ってから DB を閉じる (途中の tick が DB を掴んだまま close しない)。
      if (ecoRuntime) await (ecoStopPromise ?? ecoRuntime.stop());
      if (ecoWork) await ecoWork;
    } finally {
      store.close();
      lock.release();
      for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    }
  }
  return 0;
}

export { sleep };
