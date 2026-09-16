import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store/db.mjs";
import { Repo } from "../src/store/repo.mjs";
import { STATES } from "../src/core/states.mjs";
import { installEcoSchema } from "../src/eco/store.mjs";
import { createEcoRuntime } from "../src/eco/serviceRuntime.mjs";

const OPERATOR_TOKEN = "test-operator-token-0001";

async function makeFixture({ installSchema = true } = {}) {
  const store = await Store.open(":memory:");
  const repo = new Repo(store);
  if (installSchema) installEcoSchema(store);
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  return { store, repo, logger };
}

function realBindings(prepareTaskCalls = []) {
  return {
    capabilities: () => ({
      browserQa: { connected: true },
      claude: { connected: true },
      staging: { connected: true },
    }),
    // Deliberately empty: the run-state plumbing under test doesn't need a
    // real phase adapter, and an unconnected adapter still exercises the
    // engine's own honest "not connected" -> HUMAN_REVIEW behaviour.
    adapters: {},
    evidenceRoot: () => "evidence-root",
    safetyGate: async () => ({ allowed: true }),
    prepareTask: (task, input) => prepareTaskCalls.push({ taskId: task.id, input }),
  };
}

function makeTask(repo, overrides = {}) {
  const { task } = repo.createTask({
    title: "t",
    instruction: "do it",
    source: "test",
    priority: 50,
    repoPath: "/repo",
    dependsOn: [],
    maxAttempts: 3,
    maxRevisions: 3,
    ...overrides,
  });
  return task;
}

function enableEco(runtime, token = OPERATOR_TOKEN) {
  const settings = runtime.repo.settings();
  return runtime.api.handle(
    "POST",
    "/api/eco/settings",
    {
      config: { ...settings.config, enabled: true, mode: "cooperative_eco", qaUrl: "https://qa.example.test/", allowedDomains: ["qa.example.test"], modelPolicy: { standard: { provider: "claude", model: "sonnet", capabilities: ["implementation"] } } },
      expectedVersion: settings.version,
      idempotencyKey: "enable-cfg-0001",
    },
    token,
  );
}

test("invalid AC and changed capabilities are rejected before host preparation", async () => {
  const { store, repo, logger } = await makeFixture();
  const preparations = [];
  const bindings = realBindings(preparations);
  let connected = true;
  bindings.capabilities = () => ({ browserQa: { connected }, claude: { connected }, staging: { connected } });
  const runtime = createEcoRuntime({ store, repo, config: {}, paths: {}, logger, bindings, operatorToken: OPERATOR_TOKEN });
  enableEco(runtime);
  const task = makeTask(repo);
  const input = { taskId: task.id, revision: "r1", acIds: [], expectedVersion: runtime.repo.settings().version, idempotencyKey: "invalid-ac-0001" };
  assert.throws(() => runtime.startRun(input), /unique AC/);
  connected = false;
  assert.throws(() => runtime.startRun({ ...input, acIds: ["AC1"], idempotencyKey: "lost-cap-0001" }), /未/);
  assert.equal(preparations.length, 0);
  assert.equal(runtime.repo.list().length, 0);
  assert.equal(repo.getTask(task.id).state, STATES.QUEUED);
  store.close();
});

test("switching away from cooperative mode prevents new runs and execution", async () => {
  const { store, repo, logger } = await makeFixture();
  const preparations = [];
  const runtime = createEcoRuntime({ store, repo, config: {}, paths: {}, logger, bindings: realBindings(preparations), operatorToken: OPERATOR_TOKEN });
  enableEco(runtime);
  const cfg = runtime.repo.settings();
  runtime.repo.save({ ...cfg.config, mode: "claude_only" }, cfg.version, "mode-change-0001");
  const task = makeTask(repo);
  assert.throws(() => runtime.startRun({ taskId: task.id, revision: "r1", acIds: ["AC1"], expectedVersion: runtime.repo.settings().version, idempotencyKey: "mode-run-0001" }), /Cooperative mode/);
  assert.equal(await runtime.tick(), false);
  assert.equal(preparations.length, 0);
  store.close();
});

test("without host bindings the runtime is honestly disconnected, never fake-connected", async () => {
  const { store, repo, logger } = await makeFixture();
  const runtime = createEcoRuntime({ store, repo, config: {}, paths: {}, logger, bindings: null, operatorToken: OPERATOR_TOKEN });
  assert.equal(runtime.connected, false);
  assert.equal(runtime.engine, null);
  const caps = runtime.capabilities();
  assert.equal(caps.claude.connected, false);
  assert.throws(
    () => runtime.startRun({ taskId: "x", expectedVersion: 0, idempotencyKey: "a".repeat(10) }),
    /not connected/,
  );
  assert.equal(await runtime.tick(), false);
  assert.throws(
    () =>
      runtime.api.handle(
        "POST",
        "/api/eco/control",
        { runId: "r", expectedVersion: 1, action: "pause", idempotencyKey: "b".repeat(10) },
        OPERATOR_TOKEN,
      ),
    /not connected/,
  );
  assert.throws(
    () => runtime.api.handle("POST", "/api/eco/runs", { taskId: "x" }, OPERATOR_TOKEN),
    /not connected/,
  );
});

test("eco schema is never auto-installed and stays read-only when absent", async () => {
  const { store, repo, logger } = await makeFixture({ installSchema: false });
  const runtime = createEcoRuntime({ store, repo, config: {}, paths: {}, logger, bindings: realBindings(), operatorToken: OPERATOR_TOKEN });
  assert.equal(runtime.repo.installed, false);
  const settings = runtime.repo.settings();
  assert.equal(settings.installed, false);
  assert.throws(
    () => runtime.startRun({ taskId: "x", expectedVersion: settings.version, idempotencyKey: "a".repeat(10) }),
    /not installed/,
  );
  assert.equal(await runtime.tick(), false);
});

test("disabled feature blocks run creation before any host side effect runs", async () => {
  const { store, repo, logger } = await makeFixture();
  const calls = [];
  const runtime = createEcoRuntime({ store, repo, config: {}, paths: {}, logger, bindings: realBindings(calls), operatorToken: OPERATOR_TOKEN });
  const task = makeTask(repo);
  const settings = runtime.repo.settings();
  assert.equal(settings.config.enabled, false);
  assert.throws(
    () =>
      runtime.startRun({
        taskId: task.id,
        revision: "r1",
        acIds: ["AC1"],
        expectedVersion: settings.version,
        idempotencyKey: "c".repeat(10),
      }),
    /disabled/,
  );
  assert.equal(calls.length, 0, "prepareTask must not run when the feature is disabled");
  assert.equal(repo.getTask(task.id).state, STATES.QUEUED, "legacy task must stay untouched");
});

test("global pause keeps tick inert without disabling the feature", async () => {
  const { store, repo, logger } = await makeFixture();
  const runtime = createEcoRuntime({ store, repo, config: {}, paths: {}, logger, bindings: realBindings(), operatorToken: OPERATOR_TOKEN });
  enableEco(runtime);
  repo.setPaused(true, "test");
  assert.equal(await runtime.tick(), false);
  repo.setPaused(false, "test");
});

test("capabilities missing (no bindings) prevents enabling any cooperative run", async () => {
  const { store, repo, logger } = await makeFixture();
  const runtime = createEcoRuntime({ store, repo, config: {}, paths: {}, logger, bindings: null, operatorToken: OPERATOR_TOKEN });
  const settings = runtime.repo.settings();
  runtime.api.handle(
    "POST",
    "/api/eco/settings",
    { config: { ...settings.config, enabled: true }, expectedVersion: settings.version, idempotencyKey: "enable-cfg-0002" },
    OPERATOR_TOKEN,
  );
  const task = makeTask(repo);
  const updated = runtime.repo.settings();
  assert.throws(
    () =>
      runtime.startRun({
        taskId: task.id,
        revision: "r1",
        acIds: ["AC1"],
        expectedVersion: updated.version,
        idempotencyKey: "d".repeat(10),
      }),
    /not connected/,
  );
});

test("starting a run pauses the legacy task and rejects a concurrent second run for it", async () => {
  const { store, repo, logger } = await makeFixture();
  const calls = [];
  const runtime = createEcoRuntime({ store, repo, config: {}, paths: {}, logger, bindings: realBindings(calls), operatorToken: OPERATOR_TOKEN });
  enableEco(runtime);
  const task = makeTask(repo);
  const settings = runtime.repo.settings();
  const run = runtime.startRun({
    taskId: task.id,
    revision: "r1",
    acIds: ["AC1"],
    expectedVersion: settings.version,
    idempotencyKey: "e".repeat(10),
  });
  assert.equal(run.state, "QUEUED");
  assert.equal(repo.getTask(task.id).state, STATES.PAUSED, "legacy queue must not race the run");
  assert.equal(calls.length, 1);
  assert.throws(
    () =>
      runtime.startRun({
        taskId: task.id,
        revision: "r1",
        acIds: ["AC1"],
        expectedVersion: settings.version,
        idempotencyKey: "f".repeat(10),
      }),
    /queued|already active/,
  );
});

test("rejects starting a run for a task that is not queued (e.g. already running)", async () => {
  const { store, repo, logger } = await makeFixture();
  const runtime = createEcoRuntime({ store, repo, config: {}, paths: {}, logger, bindings: realBindings(), operatorToken: OPERATOR_TOKEN });
  enableEco(runtime);
  const task = makeTask(repo);
  repo.setState(task.id, STATES.PREFLIGHT, "legacy pickup", "system");
  repo.setState(task.id, STATES.RUNNING, "legacy running", "system");
  const settings = runtime.repo.settings();
  assert.throws(
    () =>
      runtime.startRun({
        taskId: task.id,
        revision: "r1",
        acIds: ["AC1"],
        expectedVersion: settings.version,
        idempotencyKey: "g".repeat(10),
      }),
    /queued/,
  );
});

test("expectedVersion conflict rejects run creation without side effects", async () => {
  const { store, repo, logger } = await makeFixture();
  const calls = [];
  const runtime = createEcoRuntime({ store, repo, config: {}, paths: {}, logger, bindings: realBindings(calls), operatorToken: OPERATOR_TOKEN });
  enableEco(runtime);
  const task = makeTask(repo);
  assert.throws(
    () =>
      runtime.startRun({
        taskId: task.id,
        revision: "r1",
        acIds: ["AC1"],
        expectedVersion: 0,
        idempotencyKey: "h".repeat(10),
      }),
    /[Vv]ersion conflict/,
  );
  assert.equal(calls.length, 0);
  assert.equal(repo.getTask(task.id).state, STATES.QUEUED);
});

test("same idempotency key replays the cached result without re-running prepareTask", async () => {
  const { store, repo, logger } = await makeFixture();
  const calls = [];
  const runtime = createEcoRuntime({ store, repo, config: {}, paths: {}, logger, bindings: realBindings(calls), operatorToken: OPERATOR_TOKEN });
  enableEco(runtime);
  const task = makeTask(repo);
  const settings = runtime.repo.settings();
  const input = {
    taskId: task.id,
    revision: "r1",
    acIds: ["AC1"],
    expectedVersion: settings.version,
    idempotencyKey: "i".repeat(10),
  };
  const first = runtime.startRun(input);
  const second = runtime.startRun({ ...input });
  assert.equal(first.id, second.id);
  assert.equal(calls.length, 1, "retry with the same key must not re-invoke the host side effect");
  assert.equal(repo.getTask(task.id).state, STATES.PAUSED);
});

test("write endpoints require the operator token; reads do not", async () => {
  const { store, repo, logger } = await makeFixture();
  const runtime = createEcoRuntime({ store, repo, config: {}, paths: {}, logger, bindings: realBindings(), operatorToken: OPERATOR_TOKEN });
  assert.throws(
    () => runtime.api.handle("POST", "/api/eco/runs", { taskId: "x" }, ""),
    /[Aa]uthentication/,
  );
  assert.throws(
    () => runtime.api.handle("POST", "/api/eco/runs", { taskId: "x" }, "wrong-token"),
    /[Aa]uthentication/,
  );
  assert.doesNotThrow(() => runtime.api.handle("GET", "/api/eco/runs"));
  assert.doesNotThrow(() => runtime.api.handle("GET", "/api/eco/settings"));
});

test("GET /api/eco/runs/<id> returns only run, artifacts and events", async () => {
  const { store, repo, logger } = await makeFixture();
  const runtime = createEcoRuntime({ store, repo, config: {}, paths: {}, logger, bindings: realBindings(), operatorToken: OPERATOR_TOKEN });
  enableEco(runtime);
  const task = makeTask(repo);
  const settings = runtime.repo.settings();
  const run = runtime.startRun({
    taskId: task.id,
    revision: "r1",
    acIds: ["AC1"],
    expectedVersion: settings.version,
    idempotencyKey: "j".repeat(10),
  });
  const detail = runtime.api.handle("GET", `/api/eco/runs/${run.id}`);
  assert.equal(detail.run.id, run.id);
  assert.deepEqual(detail.artifacts, []);
  assert.ok(Array.isArray(detail.events) && detail.events.length >= 1);
  assert.equal(Object.keys(detail).sort().join(","), "artifacts,events,run");
  assert.throws(() => runtime.api.handle("GET", "/api/eco/runs/eco_missing"), /not found/i);
});

test("settings changes are reflected immediately without a separate reload step", async () => {
  const { store, repo, logger } = await makeFixture();
  const runtime = createEcoRuntime({ store, repo, config: {}, paths: {}, logger, bindings: realBindings(), operatorToken: OPERATOR_TOKEN });
  const before = runtime.repo.settings();
  assert.equal(before.config.enabled, false);
  enableEco(runtime);
  const after = runtime.repo.settings();
  assert.equal(after.config.enabled, true);
  assert.equal(after.version, before.version + 1);
});

test("tick never runs two overlapping passes and issues no new effects after stop()", async () => {
  const { store, repo, logger } = await makeFixture();
  const runtime = createEcoRuntime({ store, repo, config: {}, paths: {}, logger, bindings: realBindings(), operatorToken: OPERATOR_TOKEN });
  enableEco(runtime);
  const task = makeTask(repo);
  const settings = runtime.repo.settings();
  runtime.startRun({
    taskId: task.id,
    revision: "r1",
    acIds: ["AC1"],
    expectedVersion: settings.version,
    idempotencyKey: "k".repeat(10),
  });

  repo.setPaused(false); // Explicit execution request after enabling the mode.
  const p1 = runtime.tick();
  const p2 = runtime.tick();
  assert.strictEqual(p1, p2, "concurrent tick() calls must share the same in-flight promise");
  assert.equal(await p1, true);
  assert.equal(runtime.repo.list()[0].state, "DISCOVERING");

  await runtime.stop();
  const progressed = await runtime.tick();
  assert.equal(progressed, false, "no tick work may start once stopped");
  assert.equal(runtime.repo.list()[0].state, "DISCOVERING", "no new effect after stop()");
});

test("startRun passes profileId through to prepareTask and binds it in the idempotency key", async () => {
  const { store, repo, logger } = await makeFixture();
  const calls = [];
  const runtime = createEcoRuntime({ store, repo, config: {}, paths: {}, logger, bindings: realBindings(calls), operatorToken: OPERATOR_TOKEN });
  enableEco(runtime);
  const task = makeTask(repo);
  const settings = runtime.repo.settings();
  runtime.startRun({
    taskId: task.id,
    revision: "r1",
    acIds: ["AC1"],
    profileId: "profile-a",
    expectedVersion: settings.version,
    idempotencyKey: "n".repeat(10),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.profileId, "profile-a");

  const task2 = makeTask(repo, { instruction: "do it 2" });
  assert.throws(
    () =>
      runtime.startRun({
        taskId: task2.id,
        revision: "r1",
        acIds: ["AC1"],
        profileId: "profile-b",
        expectedVersion: settings.version,
        idempotencyKey: "n".repeat(10),
      }),
    /[Ii]dempotency conflict/,
    "reusing the same key with a different profileId must not silently reuse the first binding",
  );
});

test("claimNextTask/claimNextReview never pick up a task an active eco run owns, even after a legacy resume to queued", async () => {
  const { store, repo, logger } = await makeFixture();
  const runtime = createEcoRuntime({ store, repo, config: {}, paths: {}, logger, bindings: realBindings(), operatorToken: OPERATOR_TOKEN });
  enableEco(runtime);
  const ecoTask = makeTask(repo, { instruction: "eco owned" });
  const legacyTask = makeTask(repo, { instruction: "plain legacy" });
  const settings = runtime.repo.settings();
  runtime.startRun({
    taskId: ecoTask.id,
    revision: "r1",
    acIds: ["AC1"],
    expectedVersion: settings.version,
    idempotencyKey: "o".repeat(10),
  });
  assert.equal(repo.getTask(ecoTask.id).state, STATES.PAUSED);

  // Legacy UI resumes the (still eco-owned) task back to queued.
  repo.setState(ecoTask.id, STATES.QUEUED, "legacy resume", "user");

  assert.equal(repo.claimNextTask()?.id, legacyTask.id, "the eco-owned task must not be claimed even though it is queued");
  for (const state of [STATES.PREFLIGHT, STATES.RUNNING, STATES.VERIFYING, STATES.AWAITING_AI_REVIEW]) {
    repo.setState(legacyTask.id, state, "advance legacy review fixture", "system");
  }
  assert.equal(repo.claimNextReview()?.id, legacyTask.id);

  // Disabling/pausing the feature must not hand ownership back to legacy either.
  const cfg = runtime.repo.settings();
  runtime.api.handle(
    "POST",
    "/api/eco/settings",
    { config: { ...cfg.config, enabled: false }, expectedVersion: cfg.version, idempotencyKey: "disable-own-0001" },
    OPERATOR_TOKEN,
  );
  assert.equal(repo.claimNextTask(), null, "no other queued task exists, and the eco-owned one must stay excluded");
});

test("eco ownership check is a no-op on a pre-migration DB (no eco_runs table)", async () => {
  const { store, repo } = await makeFixture({ installSchema: false });
  const task = makeTask(repo);
  assert.equal(repo.hasActiveEcoRun(task.id), false);
  assert.equal(repo.claimNextTask()?.id, task.id);
});

test("disabling the feature mid-execution signals the in-flight worker to stop before it commits new state", async () => {
  const { store, repo, logger } = await makeFixture();
  const calls = [];
  const bindings = realBindings(calls);
  let signalSeen = null;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  bindings.adapters = {
    discover: {
      async reconcile(context) {
        await blocked;
        signalSeen = context.signal();
        return { status: "absent" };
      },
      async execute() {
        return {
          status: "succeeded",
          isolated: true,
          revision: "deadbeef",
          usage: { measuredTokens: 0, estimatedTokens: 0, costUsd: 0, costKnown: true },
        };
      },
    },
  };
  const runtime = createEcoRuntime({ store, repo, config: {}, paths: {}, logger, bindings, operatorToken: OPERATOR_TOKEN });
  enableEco(runtime);
  const task = makeTask(repo);
  const settings = runtime.repo.settings();
  runtime.startRun({
    taskId: task.id,
    revision: "r1",
    acIds: ["AC1"],
    expectedVersion: settings.version,
    idempotencyKey: "p".repeat(10),
  });

  repo.setPaused(false); // Settings changes never implicitly resume work.
  await runtime.tick(); // QUEUED -> DISCOVERING
  const tickPromise = runtime.tick(); // enters the discover adapter, blocks inside reconcile

  const cfg = runtime.repo.settings();
  runtime.api.handle(
    "POST",
    "/api/eco/settings",
    { config: { ...cfg.config, enabled: false }, expectedVersion: cfg.version, idempotencyKey: "disable-mid-0001" },
    OPERATOR_TOKEN,
  );
  release();
  const progressed = await tickPromise;

  assert.equal(signalSeen, true, "the adapter must observe a stop signal once the feature is disabled mid-flight");
  assert.equal(progressed, false, "no new state commit once disabled mid-flight");
  assert.equal(runtime.repo.list()[0].state, "DISCOVERING", "run must not silently advance while disabled");
});

test("adapter failures are logged and do not crash the tick loop", async () => {
  const { store, repo, logger } = await makeFixture();
  const errors = [];
  const bindings = realBindings();
  bindings.safetyGate = async () => {
    throw new Error("boom");
  };
  const loggerSpy = { info() {}, warn() {}, debug() {}, error: (msg, meta) => errors.push({ msg, meta }) };
  const runtime = createEcoRuntime({ store, repo, config: {}, paths: {}, logger: loggerSpy, bindings, operatorToken: OPERATOR_TOKEN });
  enableEco(runtime);
  const task = makeTask(repo);
  const settings = runtime.repo.settings();
  runtime.startRun({
    taskId: task.id,
    revision: "r1",
    acIds: ["AC1"],
    expectedVersion: settings.version,
    idempotencyKey: "l".repeat(10),
  });
  repo.setPaused(false); // Settings changes never implicitly resume work.
  await runtime.tick(); // QUEUED -> DISCOVERING (no adapter involved yet)
  await runtime.tick(); // DISCOVERING -> HUMAN_REVIEW (adapters.discover missing; handled, not thrown)
  assert.equal(errors.length, 0);
  assert.equal(runtime.repo.list()[0].state, "HUMAN_REVIEW");
});
