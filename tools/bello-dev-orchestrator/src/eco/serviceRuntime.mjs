/**
 * 常駐協調eco接続。
 *
 * ホストが本物の worker/profile (bindings) を注入したときだけ動く。bindings が
 * 無い、または不完全なときは「接続不可」を正直に返し、偽の connected を返さない。
 *
 * 起動時に eco の DB スキーマを勝手に installEcoSchema() したり、既存の一時停止
 * (repo.getPaused() / 個々のタスクの queued 状態) を勝手に解除したりしない。
 * 新規 run の開始は startRun() 経由の明示 API だけが行う。
 */
import { STATES } from "../core/states.mjs";
import { EcoEngine } from "./engine.mjs";
import { EcoStore } from "./store.mjs";
import { EcoApi, disconnected } from "./api.mjs";

const REQUIRED_BINDINGS = [
  "capabilities",
  "adapters",
  "evidenceRoot",
  "safetyGate",
  "prepareTask",
];

const TERMINAL_RUN_STATES = new Set(["COMPLETED_STAGING", "FAILED", "CANCELLED"]);

function bindingsConnected(bindings) {
  return !!bindings && REQUIRED_BINDINGS.every((key) => bindings[key] != null);
}

export function createEcoRuntime({
  store,
  repo,
  config,
  paths,
  logger,
  bindings = null,
  operatorToken = process.env.BELLO_ECO_OPERATOR_TOKEN || "",
}) {
  const connected = bindingsConnected(bindings);
  const capabilities = connected ? bindings.capabilities : disconnected;
  const ecoStore = new EcoStore({ store, capabilities });

  let stopRequested = false;
  let tickInFlight = null;

  // Also reflects config.enabled here (not just at the top of tick()), because
  // EcoEngine.tick() re-checks this same function mid-flight via context.signal()
  // while an adapter is executing. Without it, flipping enabled off while a
  // dispatch is in-flight would not reach the worker until the next tick.
  function ecoModeDisabled() {
    try {
      const current = ecoStore.settings().config;
      return !current.enabled || !["cooperative_eco", "fully_automatic"].includes(current.mode);
    } catch {
      return true;
    }
  }

  // The lease/paused check inside EcoEngine.tick() already refuses new
  // dispatches once this returns true, so requesting a stop never lets a new
  // side effect start; it just lets an in-flight one finish honestly.
  const engine = connected
    ? new EcoEngine({
        repo: ecoStore,
        adapters: bindings.adapters,
        evidenceRoot: bindings.evidenceRoot,
        safetyGate: bindings.safetyGate,
        paused: () => stopRequested || repo.getPaused() || ecoModeDisabled(),
      })
    : null;

  function activeRunForTask(taskId) {
    return store.get(
      "SELECT id FROM eco_runs WHERE task_id=? AND state NOT IN ('COMPLETED_STAGING','FAILED','CANCELLED')",
      [taskId],
    );
  }

  /**
   * 新規 run 開始。認証は呼び出し元 (EcoApi.handle) が既に済ませている前提。
   * task の queued 以外拒否、同taskの二重run拒否、既存 legacy running との競合拒否は
   * すべて「task.state===QUEUED のときだけ許可する」に一本化している
   * (running/preflight 中の task は state が QUEUED ではないため自動的に拒否される)。
   */
  function startRun(input = {}) {
    if (!connected || !engine) throw Error("Cooperative worker is not connected");
    if (!ecoStore.installed) throw Error("Eco migration not installed");
    const { taskId, revision, acIds, risk = "low", expectedVersion, idempotencyKey, profileId = null } = input;
    if (typeof taskId !== "string" || !taskId) throw Error("taskId required");
    if (!Number.isInteger(expectedVersion)) throw Error("expectedVersion required");
    const run = ecoStore.idempotent(
      idempotencyKey,
      { taskId, revision, acIds, risk, expectedVersion, profileId },
      () => {
        const settings = ecoStore.settings();
        if (settings.version !== expectedVersion) throw Error("Configuration version conflict");
        // Checked before any host side effect (prepareTask/worktree creation) runs,
        // not just inside the later ecoStore.create() call.
        if (!settings.config.enabled) throw Error("Feature disabled");
        if (!["cooperative_eco", "fully_automatic"].includes(settings.config.mode))
          throw Error("Cooperative mode required");
        const task = repo.getTask(taskId);
        if (!task) throw Error("Unknown task");
        if (task.state !== STATES.QUEUED)
          throw Error("Task must be queued to start a cooperative run");
        if (activeRunForTask(taskId)) throw Error("A cooperative run is already active for this task");
        // Host-owned, synchronous worktree/isolation preparation. Runs inside the
        // same DB transaction as the pause below, so a failure here rolls both back.
        const run = ecoStore.create(taskId, { revision, acIds, risk }, `${idempotencyKey}:run`);
        bindings.prepareTask(task, { revision, acIds, risk, profileId });
        // Removes the task from the legacy queue (claimNextTask only selects
        // state=queued) without touching orchestrator.pause()/repo.getPaused().
        repo.setState(taskId, STATES.PAUSED, "Cooperative eco run started", "eco", {});
        return run;
      },
    );
    // A newly accepted run must not wait for the legacy queue's next sleep cycle.
    // The same guarded tick function is used, so overlapping dispatch is still impossible.
    queueMicrotask(() => tick().catch((error) => logger?.error?.("協調eco immediate tick の失敗", { error: error.message })));
    return run;
  }

  function getRun(id) {
    if (!ecoStore.installed) return null;
    const run = ecoStore.get(id);
    if (!run) return null;
    const artifacts = store
      .all(
        "SELECT id,revision,kind,digest,data FROM eco_artifacts WHERE run_id=? ORDER BY rowid ASC",
        [id],
      )
      .map((a) => ({ id: a.id, revision: a.revision, kind: a.kind, digest: a.digest, body: JSON.parse(a.data) }));
    const events = store
      .all("SELECT data FROM eco_events WHERE run_id=? ORDER BY sequence ASC", [id])
      .map((e) => JSON.parse(e.data));
    return { run, artifacts, events };
  }

  function reflectFinishedRun(run) {
    if (!TERMINAL_RUN_STATES.has(run.state)) return;
    const lastEvent = store.get(
      "SELECT data FROM eco_events WHERE run_id=? ORDER BY sequence DESC LIMIT 1",
      [run.id],
    );
    const reason = lastEvent ? JSON.parse(lastEvent.data).reason : null;
    // Reflects the outcome without rewriting task_state_history or moving the
    // task out of paused; re-queueing stays an explicit, separate operator action.
    repo.checkpoint(run.task_id, "eco_run", { runId: run.id, state: run.state, reason });
  }

  /**
   * 並列 tick 禁止。呼ばれた時点で走っていれば「同じ」 Promise 参照を返す
   * (async function は必ず新しい Promise で包むため、ここはあえて素の関数にしている)。
   */
  function tick() {
    if (tickInFlight) return tickInFlight;
    if (stopRequested || !connected || !engine || !ecoStore.installed) return Promise.resolve(false);
    let enabled = false;
    try {
      enabled = ecoStore.settings().config.enabled;
    } catch {
      enabled = false;
    }
    if (!enabled || repo.getPaused()) return Promise.resolve(false);
    tickInFlight = (async () => {
      let progressed = false;
      try {
        const runs = ecoStore.list().filter((r) => !TERMINAL_RUN_STATES.has(r.state));
        for (const run of runs) {
          if (stopRequested) break;
          try {
            const changed = await engine.tick(run.id);
            progressed = progressed || changed;
            if (changed) {
              const updated = ecoStore.get(run.id);
              if (updated) reflectFinishedRun(updated);
            }
          } catch (error) {
            logger?.error?.("協調eco tick で例外", { runId: run.id, error: error.message });
          }
        }
      } finally {
        tickInFlight = null;
      }
      return progressed;
    })();
    return tickInFlight;
  }

  // Recover queued/in-flight runs immediately after a service restart. Leases and
  // persisted effect keys make this restart-safe; unknown external effects are reconciled.
  if (connected && ecoStore.installed)
    queueMicrotask(() => tick().catch((error) => logger?.error?.("協調eco recovery tick の失敗", { error: error.message })));

  async function stop() {
    stopRequested = true;
    if (tickInFlight) await tickInFlight;
  }

  const api = new EcoApi({ store, operatorToken, capabilities, engine, startRun, getRun });

  return {
    connected,
    repo: ecoStore,
    engine,
    api,
    capabilities,
    startRun,
    getRun,
    tick,
    stop,
  };
}
