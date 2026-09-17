import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempDir, makeConfig, initRepo } from "./helpers.mjs";
import { derivePaths, ensureDirs } from "../src/config.mjs";
import { Store } from "../src/store/db.mjs";
import { Repo } from "../src/store/repo.mjs";
import { Logger } from "../src/log/logger.mjs";
import { runQaSession, createBrowserQaWorker, QA_VERDICT_SCHEMA } from "../src/eco/browserWorker.mjs";
import { createServiceBindings, validateRuntimeConfig, SUPPORTED_PROFILE_ID } from "../src/eco/serviceBindings.mjs";

// ---------------------------------------------------------------- fakes

function makeFakePage({ domSummary = "BELLO", viewport = { width: 800, height: 600 }, initialUrl = "" } = {}) {
  let currentUrl = initialUrl;
  let handler = null;
  const fire = (method, url) => {
    let aborted = false;
    const request = { method: () => method, url: () => url };
    const route = { request: () => request, abort: () => { aborted = true; }, continue: () => {} };
    handler(route);
    return !aborted;
  };
  return {
    async route(_pattern, h) {
      handler = h;
    },
    async goto(target) {
      fire("GET", target);
      currentUrl = target;
    },
    async reload() {
      fire("GET", currentUrl);
    },
    async screenshot({ path: file }) {
      fs.writeFileSync(file, Buffer.from("fake-png"));
    },
    locator() {
      return { click: async () => {}, fill: async () => {} };
    },
    keyboard: { press: async () => {} },
    viewportSize: () => viewport,
    url: () => currentUrl,
    evaluate: async () => domSummary,
  };
}

function makeFakeBrowser(page, version = "FakeChromium/1.0") {
  return { version: () => version, newPage: async () => page, close: async () => {} };
}

function makeFakeCodexExecute(answer, { calls = [] } = {}) {
  const fn = async ({ args }) => {
    calls.push(args);
    const idx = args.indexOf("--output-last-message");
    const outputFile = args[idx + 1];
    fs.writeFileSync(outputFile, JSON.stringify(answer));
    const events = [{ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }];
    return { ok: true, exitCode: 0, stdout: events.map((e) => JSON.stringify(e)).join("\n"), stderr: "" };
  };
  fn.calls = calls;
  return fn;
}

const MINIMAL_SEQUENCE = [
  { type: "navigate" },
  { type: "screenshot", label: "initial" },
  { type: "reload" },
  { type: "screenshot", label: "final" },
];

// ---------------------------------------------------------------- runQaSession

test("runQaSession records the full trail, screenshots and viewport", async () => {
  const dir = tempDir("bello-qa-evidence-");
  const page = makeFakePage({ domSummary: "hello world" });
  const result = await runQaSession({
    page,
    sequence: MINIMAL_SEQUENCE,
    baseUrl: "https://preview.example.com/",
    allowedDomains: ["preview.example.com"],
    staticSmoke: true,
    evidenceDir: dir,
  });
  assert.equal(result.trail.length, 4);
  assert.equal(result.screenshots.length, 2);
  assert.deepEqual(result.viewport, { width: 800, height: 600 });
  assert.equal(result.domSummary, "hello world");
  for (const shot of result.screenshots) assert.ok(fs.existsSync(path.join(dir, shot.file)));
});

test("runQaSession rejects a sequence that does not navigate first", async () => {
  const page = makeFakePage();
  await assert.rejects(
    () => runQaSession({ page, sequence: [{ type: "reload" }], baseUrl: "https://a.example.com/", allowedDomains: ["a.example.com"], staticSmoke: true, evidenceDir: tempDir("bello-qa-") }),
    /navigate/,
  );
});

test("runQaSession rejects a sequence without a reload step", async () => {
  const page = makeFakePage();
  await assert.rejects(
    () =>
      runQaSession({
        page,
        sequence: [{ type: "navigate" }, { type: "screenshot" }],
        baseUrl: "https://a.example.com/",
        allowedDomains: ["a.example.com"],
        staticSmoke: true,
        evidenceDir: tempDir("bello-qa-"),
      }),
    /reload/,
  );
});

test("runQaSession blocks navigation outside the staging scope", async () => {
  const page = makeFakePage();
  await assert.rejects(
    () =>
      runQaSession({
        page,
        sequence: [{ type: "navigate", target: "https://evil.example.com/" }, { type: "screenshot" }, { type: "reload" }, { type: "screenshot" }],
        baseUrl: "https://a.example.com/",
        allowedDomains: ["a.example.com"],
        staticSmoke: true,
        evidenceDir: tempDir("bello-qa-"),
      }),
    /scope/,
  );
});

test("runQaSession blocks a disallowed domain reached through the network route", async () => {
  const page = makeFakePage();
  page.goto = async (target) => {
    // Simulate a same-origin page whose script/resource loads reach another host.
    const request = { method: () => "GET", url: () => "https://tracker.example.net/beacon" };
    let aborted = false;
    const route = { request: () => request, abort: () => { aborted = true; }, continue: () => {} };
    page._handler(route);
    assert.equal(aborted, true);
  };
  page.route = async (_p, h) => { page._handler = h; };
  await assert.rejects(
    () =>
      runQaSession({
        page,
        sequence: MINIMAL_SEQUENCE,
        baseUrl: "https://a.example.com/",
        allowedDomains: ["a.example.com"],
        staticSmoke: true,
        evidenceDir: tempDir("bello-qa-"),
      }),
    /Disallowed network request/,
  );
});

test("runQaSession static-smoke profile rejects non-GET/HEAD requests", async () => {
  const page = makeFakePage();
  let handler;
  page.route = async (_p, h) => { handler = h; };
  page.goto = async (target) => {
    const request = { method: () => "POST", url: () => target };
    let aborted = false;
    handler({ request: () => request, abort: () => { aborted = true; }, continue: () => {} });
  };
  await assert.rejects(
    () =>
      runQaSession({
        page,
        sequence: MINIMAL_SEQUENCE,
        baseUrl: "https://a.example.com/",
        allowedDomains: ["a.example.com"],
        staticSmoke: true,
        evidenceDir: tempDir("bello-qa-"),
      }),
    /Disallowed network request/,
  );
});

test("runQaSession enforces the bounded time budget", async () => {
  const page = makeFakePage();
  const slowSequence = [{ type: "navigate" }, { type: "screenshot" }, { type: "reload" }, { type: "screenshot" }];
  const original = page.reload;
  page.reload = async (...args) => {
    await new Promise((r) => setTimeout(r, 30));
    return original.call(page, ...args);
  };
  await assert.rejects(
    () =>
      runQaSession({
        page,
        sequence: slowSequence,
        baseUrl: "https://a.example.com/",
        allowedDomains: ["a.example.com"],
        staticSmoke: true,
        evidenceDir: tempDir("bello-qa-"),
        timeBudgetMs: 5,
      }),
    /time budget/,
  );
});

// ---------------------------------------------------------------- createBrowserQaWorker

function makeRun(overrides = {}) {
  return {
    id: "eco_run1",
    task_id: "task1",
    acIds: ["AC-1", "AC-2"],
    revision: "rev-1",
    specId: "spec1",
    implementationId: "impl1",
    headSHA: "a".repeat(40),
    deployment: { deploymentId: "job-1" },
    configSnapshot: { qaUrl: "https://a.example.com/", testAccount: "isolated smoke" },
    ...overrides,
  };
}

test("createBrowserQaWorker produces a valid PASS qa artifact with evidence on disk", async () => {
  const evidenceRootDir = tempDir("bello-qa-evroot-");
  const evidenceRoot = (id) => path.join(evidenceRootDir, id);
  const launchCalls = [];
  const cliCalls = [];
  const worker = createBrowserQaWorker({
    phase: "qaVerify",
    model: "gpt-test",
    executable: "codex",
    directory: tempDir("bello-qa-worker-"),
    evidenceRoot,
    assertSubscription: async () => true,
    playwrightModulePath: "/unused",
    allowedDomains: ["a.example.com"],
    sequence: MINIMAL_SEQUENCE,
    staticSmoke: true,
    timeBudgetMs: 5000,
    verifyBuild: async () => ({ ok: true, sha256: "digest-1" }),
    contextFor: async () => ({ acIds: ["AC-1", "AC-2"], briefing: "context", baseUrl: "https://a.example.com/" }),
    launch: async () => {
      launchCalls.push(1);
      return makeFakeBrowser(makeFakePage({ domSummary: "BELLO COOPERATIVE ECO VERIFIED" }));
    },
    execute: makeFakeCodexExecute(
      { acceptanceCriteria: [{ id: "AC-1", result: "PASS", reasoning: "seen" }, { id: "AC-2", result: "PASS", reasoning: "seen" }], notes: "ok" },
      { calls: cliCalls },
    ),
  });
  const context = { run: makeRun(), operationKey: "op1", signal: () => false };
  const receipt = await worker.execute(context);
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.currentRevision, context.run.headSHA);
  assert.equal(receipt.artifact.kind, "qa");
  assert.equal(receipt.artifact.body.verdict, "PASS");
  assert.equal(receipt.artifact.body.acceptanceCriteria.length, 2);
  assert.equal(launchCalls.length, 1);
  assert.equal(cliCalls.length, 1);
  for (const ref of receipt.artifact.evidenceRefs) {
    assert.ok(fs.existsSync(path.join(evidenceRoot(context.run.id), ref)), ref + " must exist");
  }
});

test("createBrowserQaWorker blocks without launching the browser when the build is not verified", async () => {
  const evidenceRootDir = tempDir("bello-qa-evroot-");
  const evidenceRoot = (id) => path.join(evidenceRootDir, id);
  const launchCalls = [];
  const worker = createBrowserQaWorker({
    phase: "qaVerify",
    model: "gpt-test",
    executable: "codex",
    directory: tempDir("bello-qa-worker-"),
    evidenceRoot,
    assertSubscription: async () => true,
    playwrightModulePath: "/unused",
    allowedDomains: ["a.example.com"],
    sequence: MINIMAL_SEQUENCE,
    staticSmoke: true,
    verifyBuild: async () => ({ ok: false, reason: "revision mismatch" }),
    contextFor: async () => ({ acIds: ["AC-1"], briefing: "", baseUrl: "https://a.example.com/" }),
    launch: async () => {
      launchCalls.push(1);
      return makeFakeBrowser(makeFakePage());
    },
    execute: makeFakeCodexExecute({ acceptanceCriteria: [], notes: "" }),
  });
  const receipt = await worker.execute({ run: makeRun(), operationKey: "op2", signal: () => false });
  assert.equal(receipt.status, "blocked");
  assert.match(receipt.reason, /revision mismatch/);
  assert.equal(launchCalls.length, 0);
});

test("createBrowserQaWorker blocks (without dispatching to the model) when the build changes during the session", async () => {
  const evidenceRootDir = tempDir("bello-qa-evroot-");
  const evidenceRoot = (id) => path.join(evidenceRootDir, id);
  const results = [{ ok: true, sha256: "before" }, { ok: true, sha256: "after" }];
  let i = 0;
  const cliCalls = [];
  const worker = createBrowserQaWorker({
    phase: "qaVerify",
    model: "gpt-test",
    executable: "codex",
    directory: tempDir("bello-qa-worker-"),
    evidenceRoot,
    assertSubscription: async () => true,
    playwrightModulePath: "/unused",
    allowedDomains: ["a.example.com"],
    sequence: MINIMAL_SEQUENCE,
    staticSmoke: true,
    verifyBuild: async () => results[i++],
    contextFor: async () => ({ acIds: ["AC-1"], briefing: "", baseUrl: "https://a.example.com/" }),
    launch: async () => makeFakeBrowser(makeFakePage()),
    execute: makeFakeCodexExecute({ acceptanceCriteria: [{ id: "AC-1", result: "PASS", reasoning: "x" }], notes: "" }, { calls: cliCalls }),
  });
  const receipt = await worker.execute({ run: makeRun({ acIds: ["AC-1"] }), operationKey: "op3", signal: () => false });
  assert.equal(receipt.status, "blocked");
  assert.match(receipt.reason, /changed during/);
  assert.equal(cliCalls.length, 0);
});

test("createBrowserQaWorker never re-launches the browser or re-dispatches the model for a repeated operation key", async () => {
  const evidenceRootDir = tempDir("bello-qa-evroot-");
  const evidenceRoot = (id) => path.join(evidenceRootDir, id);
  const launchCalls = [];
  const cliCalls = [];
  const worker = createBrowserQaWorker({
    phase: "qaVerify",
    model: "gpt-test",
    executable: "codex",
    directory: tempDir("bello-qa-worker-"),
    evidenceRoot,
    assertSubscription: async () => true,
    playwrightModulePath: "/unused",
    allowedDomains: ["a.example.com"],
    sequence: MINIMAL_SEQUENCE,
    staticSmoke: true,
    verifyBuild: async () => ({ ok: true, sha256: "same" }),
    contextFor: async () => ({ acIds: ["AC-1"], briefing: "", baseUrl: "https://a.example.com/" }),
    launch: async () => {
      launchCalls.push(1);
      return makeFakeBrowser(makeFakePage());
    },
    execute: makeFakeCodexExecute({ acceptanceCriteria: [{ id: "AC-1", result: "PASS", reasoning: "x" }], notes: "" }, { calls: cliCalls }),
  });
  const context = { run: makeRun({ acIds: ["AC-1"] }), operationKey: "op4", signal: () => false };
  const first = await worker.execute(context);
  const second = await worker.execute(context);
  assert.equal(first.status, "succeeded");
  assert.deepEqual(second, first);
  assert.equal(launchCalls.length, 1);
  assert.equal(cliCalls.length, 1);
});

test("createBrowserQaWorker.reconcile reports absent before any dispatch", async () => {
  const evidenceRootDir = tempDir("bello-qa-evroot-");
  const evidenceRoot = (id) => path.join(evidenceRootDir, id);
  const worker = createBrowserQaWorker({
    phase: "qaInitial",
    model: "gpt-test",
    executable: "codex",
    directory: tempDir("bello-qa-worker-"),
    evidenceRoot,
    assertSubscription: async () => true,
    playwrightModulePath: "/unused",
    allowedDomains: ["a.example.com"],
    sequence: MINIMAL_SEQUENCE,
    staticSmoke: true,
    verifyBuild: async () => ({ ok: true, sha256: "x" }),
    contextFor: async () => ({ acIds: ["AC-1"], briefing: "", baseUrl: "https://a.example.com/" }),
    launch: async () => makeFakeBrowser(makeFakePage()),
    execute: makeFakeCodexExecute({ acceptanceCriteria: [], notes: "" }),
  });
  const receipt = await worker.reconcile({ run: makeRun(), operationKey: "op5", signal: () => false });
  assert.equal(receipt.status, "absent");
});

test("QA_VERDICT_SCHEMA requires exactly PASS/FAIL/BLOCKED/NOT_RUN results", () => {
  assert.deepEqual(QA_VERDICT_SCHEMA.properties.acceptanceCriteria.items.properties.result.enum, ["PASS", "FAIL", "BLOCKED", "NOT_RUN"]);
});

// ---------------------------------------------------------------- validateRuntimeConfig / createServiceBindings

const STAGING = Object.freeze({
  mode: "static-smoke",
  enabled: true,
  accountId: "203918843421",
  appId: "d22lq9g4o2zu1o",
  appName: "bello-orchestrator-smoke",
  branch: "preview-orchestrator",
  region: "us-west-2",
  profile: "Bello",
  isolatedDataConfirmed: true,
  maxWaitSeconds: 600,
});
const VERIFICATION = Object.freeze({
  required: true,
  commands: [{ name: "smoke", file: "node", args: ["-e", "1"], cwd: ".", timeoutSeconds: 20 }],
});

function makeProfileEntry(repoPath, playwrightModulePath) {
  return {
    repoPath,
    // initRepo() (test/helpers.mjs) seeds a README.md; allowedPaths must be the
    // isolated worktree's complete file manifest, matching assertIsolated below.
    allowedPaths: ["index.html", "README.md"],
    qaUrl: "https://preview-orchestrator.d22lq9g4o2zu1o.amplifyapp.com/",
    allowedDomains: ["preview-orchestrator.d22lq9g4o2zu1o.amplifyapp.com"],
    verification: structuredClone(VERIFICATION),
    staging: structuredClone(STAGING),
    models: { claude: { model: "sonnet" }, codex: { model: "gpt-5.1-codex" } },
    playwright: { modulePath: playwrightModulePath, headless: true },
    qaSteps: { sequence: MINIMAL_SEQUENCE, maxTotalSeconds: 60 },
  };
}

function makeTestConfig(repoPath) {
  return makeConfig({
    repoPath,
    staging: structuredClone(STAGING),
    verification: structuredClone(VERIFICATION),
    codex: { executable: "codex", model: "gpt-5.1-codex", timeoutSeconds: 60 },
  });
}

test("validateRuntimeConfig accepts a matching static-smoke profile", () => {
  const repoPath = initRepo(tempDir("bello-repo-"));
  const modulePath = path.join(tempDir("bello-pw-"), "marker.mjs");
  fs.writeFileSync(modulePath, "export {};");
  const config = makeTestConfig(repoPath);
  const profile = validateRuntimeConfig({ schemaVersion: 1, profiles: { [SUPPORTED_PROFILE_ID]: makeProfileEntry(repoPath, modulePath) } }, config);
  assert.equal(profile.id, "static-smoke");
  assert.equal(profile.repoPath, repoPath);
});

test("validateRuntimeConfig rejects a repoPath mismatch", () => {
  const repoPath = initRepo(tempDir("bello-repo-"));
  const other = initRepo(tempDir("bello-repo-"));
  const modulePath = path.join(tempDir("bello-pw-"), "marker.mjs");
  fs.writeFileSync(modulePath, "export {};");
  const config = makeTestConfig(repoPath);
  assert.throws(
    () => validateRuntimeConfig({ schemaVersion: 1, profiles: { [SUPPORTED_PROFILE_ID]: makeProfileEntry(other, modulePath) } }, config),
    /repoPath/,
  );
});

test("validateRuntimeConfig rejects an unsupported profile id", () => {
  const repoPath = initRepo(tempDir("bello-repo-"));
  const modulePath = path.join(tempDir("bello-pw-"), "marker.mjs");
  fs.writeFileSync(modulePath, "export {};");
  const config = makeTestConfig(repoPath);
  assert.throws(
    () => validateRuntimeConfig({ schemaVersion: 1, profiles: { "full-app": makeProfileEntry(repoPath, modulePath) } }, config),
    /static-smoke/,
  );
});

test("validateRuntimeConfig rejects a verification drift from the running configuration", () => {
  const repoPath = initRepo(tempDir("bello-repo-"));
  const modulePath = path.join(tempDir("bello-pw-"), "marker.mjs");
  fs.writeFileSync(modulePath, "export {};");
  const config = makeTestConfig(repoPath);
  const entry = makeProfileEntry(repoPath, modulePath);
  entry.verification.commands[0].timeoutSeconds = 999;
  assert.throws(() => validateRuntimeConfig({ schemaVersion: 1, profiles: { [SUPPORTED_PROFILE_ID]: entry } }, config), /verification/);
});

test("validateRuntimeConfig rejects a malformed QA step sequence", () => {
  const repoPath = initRepo(tempDir("bello-repo-"));
  const modulePath = path.join(tempDir("bello-pw-"), "marker.mjs");
  fs.writeFileSync(modulePath, "export {};");
  const config = makeTestConfig(repoPath);
  const entry = makeProfileEntry(repoPath, modulePath);
  entry.qaSteps.sequence = [{ type: "screenshot" }, { type: "navigate" }, { type: "reload" }];
  assert.throws(() => validateRuntimeConfig({ schemaVersion: 1, profiles: { [SUPPORTED_PROFILE_ID]: entry } }, config), /navigate first/);
});

async function buildHarnessWithRuntime({ withRuntimeFile = true, staleProbes = false } = {}) {
  const repoPath = initRepo(tempDir("bello-repo-"));
  const config = makeTestConfig(repoPath);
  const paths = derivePaths(config);
  ensureDirs(paths);
  const modulePath = path.join(tempDir("bello-pw-"), "marker.mjs");
  fs.writeFileSync(modulePath, "export {};");
  if (withRuntimeFile) {
    fs.writeFileSync(
      path.join(paths.dataRoot, "eco-runtime.json"),
      JSON.stringify({ schemaVersion: 1, profiles: { [SUPPORTED_PROFILE_ID]: makeProfileEntry(repoPath, modulePath) } }),
    );
  }
  if (staleProbes) {
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(paths.stateDir, "eco-probes.json"),
      JSON.stringify({
        claude: { at: Date.now() - 999999999, ok: true },
        codex: { at: Date.now() - 999999999, ok: true },
        browser: { at: Date.now() - 999999999, ok: true },
        staging: { at: Date.now() - 999999999, ok: true },
      }),
    );
  }
  const logger = new Logger({ dir: paths.logDir, name: "test", level: "error", echo: false });
  const store = await Store.open(paths.dbFile);
  const repo = new Repo(store);
  return { repoPath, config, paths, logger, store, repo, cleanup: () => store.close() };
}

test("createServiceBindings reports an honest disconnected state without eco-runtime.json", async () => {
  const h = await buildHarnessWithRuntime({ withRuntimeFile: false });
  try {
    const bindings = createServiceBindings({ config: h.config, paths: h.paths, repo: h.repo, logger: h.logger });
    const caps = bindings.capabilities();
    assert.equal(caps.browserQa.connected, false);
    assert.equal(caps.claude.connected, false);
    assert.equal(caps.staging.connected, false);
    assert.ok(caps.browserQa.reason);
    assert.deepEqual(bindings.adapters, {});
    assert.throws(() => bindings.prepareTask({}, {}));
    const gate = await bindings.safetyGate({ run: { task_id: "x" } });
    assert.equal(gate.allowed, false);
  } finally {
    h.cleanup();
  }
});

test("createServiceBindings capabilities reflect stale probes honestly", async () => {
  const h = await buildHarnessWithRuntime({ staleProbes: true });
  try {
    const bindings = createServiceBindings({ config: h.config, paths: h.paths, repo: h.repo, logger: h.logger });
    const caps = bindings.capabilities();
    assert.equal(caps.claude.connected, false);
    assert.match(caps.claude.reason, /古く/);
  } finally {
    h.cleanup();
  }
});

test("createServiceBindings.prepareTask isolates a worktree and is restart-safe", async () => {
  const h = await buildHarnessWithRuntime();
  try {
    const bindings = createServiceBindings({
      config: h.config,
      paths: h.paths,
      repo: h.repo,
      logger: h.logger,
      buildDelivery: () => ({ preflight: async () => {}, row: () => null, artifact: () => ({ sha256: "x" }) }),
    });
    const { task } = h.repo.createTask({ title: "t", instruction: "do it", source: "system", repoPath: h.repoPath });
    const first = bindings.prepareTask(task, { revision: "r1", acIds: ["AC-1"] });
    assert.equal(first.isolation, "worktree");
    assert.ok(fs.existsSync(first.work_dir));
    const second = bindings.prepareTask(h.repo.getTask(task.id), { revision: "r1", acIds: ["AC-1"] });
    assert.equal(second.work_dir, first.work_dir);
    const safety = await bindings.safetyGate({ run: { task_id: task.id, state: "IMPLEMENTING", configSnapshot: { qaUrl: "https://preview-orchestrator.d22lq9g4o2zu1o.amplifyapp.com/", allowedDomains: ["preview-orchestrator.d22lq9g4o2zu1o.amplifyapp.com"] } } });
    assert.equal(safety.allowed, true);
    const badScope = await bindings.safetyGate({ run: { task_id: task.id, state: "IMPLEMENTING", configSnapshot: { qaUrl: "https://other.example.com/", allowedDomains: [] } } });
    assert.equal(badScope.allowed, false);
  } finally {
    h.cleanup();
  }
});

test("createServiceBindings.prepareTask rejects an explicit profileId mismatch before creating a worktree", async () => {
  const h = await buildHarnessWithRuntime();
  try {
    const bindings = createServiceBindings({
      config: h.config,
      paths: h.paths,
      repo: h.repo,
      logger: h.logger,
      buildDelivery: () => ({ preflight: async () => {}, row: () => null, artifact: () => ({ sha256: "x" }) }),
    });
    const { task } = h.repo.createTask({ title: "t", instruction: "do it", source: "system", repoPath: h.repoPath });
    assert.throws(
      () => bindings.prepareTask(task, { revision: "r1", acIds: ["AC-1"], profileId: "some-other-profile" }),
      /static-smoke/,
    );
    assert.equal(h.repo.getTask(task.id).isolation, task.isolation);
    // profileId absent/null stays a no-op confirmation, not a rejection.
    const ok = bindings.prepareTask(task, { revision: "r1", acIds: ["AC-1"], profileId: SUPPORTED_PROFILE_ID });
    assert.equal(ok.isolation, "worktree");
  } finally {
    h.cleanup();
  }
});

test("createServiceBindings.prepareTask refuses to silently reuse a checkpoint after the profile, revision, acIds or source changed", async () => {
  const h = await buildHarnessWithRuntime();
  try {
    const bindings = createServiceBindings({
      config: h.config,
      paths: h.paths,
      repo: h.repo,
      logger: h.logger,
      buildDelivery: () => ({ preflight: async () => {}, row: () => null, artifact: () => ({ sha256: "x" }) }),
    });
    const { task } = h.repo.createTask({ title: "t", instruction: "do it", source: "system", repoPath: h.repoPath });
    const first = bindings.prepareTask(task, { revision: "r1", acIds: ["AC-1"] });
    assert.equal(first.isolation, "worktree");
    // Same revision/acIds/source: honest reuse.
    const reused = bindings.prepareTask(h.repo.getTask(task.id), { revision: "r1", acIds: ["AC-1"] });
    assert.equal(reused.work_dir, first.work_dir);
    // Different revision must not silently reuse the earlier worktree binding.
    assert.throws(
      () => bindings.prepareTask(h.repo.getTask(task.id), { revision: "r2", acIds: ["AC-1"] }),
      /different profile, revision, acIds or source/,
    );
    // Different acIds set must not silently reuse either.
    assert.throws(
      () => bindings.prepareTask(h.repo.getTask(task.id), { revision: "r1", acIds: ["AC-1", "AC-2"] }),
      /different profile, revision, acIds or source/,
    );
  } finally {
    h.cleanup();
  }
});

test("assertIsolated (via safetyGate) flags a real change outside allowedPaths, not every tracked file in the repo", async () => {
  const h = await buildHarnessWithRuntime();
  try {
    const bindings = createServiceBindings({
      config: h.config,
      paths: h.paths,
      repo: h.repo,
      logger: h.logger,
      buildDelivery: () => ({ preflight: async () => {}, row: () => null, artifact: () => ({ sha256: "x" }) }),
    });
    const { task } = h.repo.createTask({ title: "t", instruction: "do it", source: "system", repoPath: h.repoPath });
    const prepared = bindings.prepareTask(task, { revision: "r1", acIds: ["AC-1"] });
    const runArgs = {
      task_id: prepared.id,
      state: "IMPLEMENTING",
      configSnapshot: {
        qaUrl: "https://preview-orchestrator.d22lq9g4o2zu1o.amplifyapp.com/",
        allowedDomains: ["preview-orchestrator.d22lq9g4o2zu1o.amplifyapp.com"],
      },
    };
    // No changes yet (clean checkout of a repo whose only tracked file, README.md,
    // is already in allowedPaths): must be allowed, not flagged as "everything changed".
    const clean = await bindings.safetyGate({ run: runArgs });
    assert.equal(clean.allowed, true);
    // A real change inside allowedPaths (index.html) must stay allowed.
    fs.writeFileSync(path.join(prepared.work_dir, "index.html"), "<html></html>");
    const inScope = await bindings.safetyGate({ run: runArgs });
    assert.equal(inScope.allowed, true);
    // A real change outside allowedPaths must be rejected.
    fs.writeFileSync(path.join(prepared.work_dir, "outside.txt"), "nope");
    const outOfScope = await bindings.safetyGate({ run: runArgs });
    assert.equal(outOfScope.allowed, false);
    assert.match(outOfScope.reason, /host-approved file scope/);
  } finally {
    h.cleanup();
  }
});

test("assertIsolated rejects a task whose repo_path is not the connected bounded profile repo", async () => {
  const h = await buildHarnessWithRuntime();
  try {
    const bindings = createServiceBindings({
      config: h.config,
      paths: h.paths,
      repo: h.repo,
      logger: h.logger,
      buildDelivery: () => ({ preflight: async () => {}, row: () => null, artifact: () => ({ sha256: "x" }) }),
    });
    const { task } = h.repo.createTask({ title: "t", instruction: "do it", source: "system", repoPath: h.repoPath });
    const prepared = bindings.prepareTask(task, { revision: "r1", acIds: ["AC-1"] });
    // Simulate a task record that points at a different (e.g. main) repo while
    // still carrying an isolated worktree path; must never be trusted as scoped.
    h.repo.updateTask(prepared.id, { repo_path: "/some/other/main/repo" });
    const gate = await bindings.safetyGate({
      run: {
        task_id: prepared.id,
        state: "IMPLEMENTING",
        configSnapshot: {
          qaUrl: "https://preview-orchestrator.d22lq9g4o2zu1o.amplifyapp.com/",
          allowedDomains: ["preview-orchestrator.d22lq9g4o2zu1o.amplifyapp.com"],
        },
      },
    });
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /bounded profile/);
  } finally {
    h.cleanup();
  }
});

test("createServiceBindings.refreshProbes records real-ish probe results the host can trust", async () => {
  const h = await buildHarnessWithRuntime();
  try {
    const bindings = createServiceBindings({
      config: h.config,
      paths: h.paths,
      repo: h.repo,
      logger: h.logger,
      execute: async ({ args }) => ({ ok: true, stdout: args.includes("--version") ? "1.0.0" : "logged in", stderr: "" }),
      launchBrowser: async () => makeFakeBrowser(makeFakePage()),
      buildDelivery: () => ({ preflight: async () => {} }),
      resolveClaude: () => ({ file: "claude", kind: "configured" }),
      resolveCodex: () => "codex",
    });
    await bindings.refreshProbes();
    const caps = bindings.capabilities();
    assert.equal(caps.claude.connected, true);
    assert.equal(caps.browserQa.connected, true);
    assert.equal(caps.staging.connected, true);
  } finally {
    h.cleanup();
  }
});
