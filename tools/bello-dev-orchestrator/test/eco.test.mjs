import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildHarness } from "./helpers.mjs";
import { Store } from "../src/store/db.mjs";
import {
  EcoStore,
  installEcoSchema,
  protectedActions,
} from "../src/eco/store.mjs";
import { EcoEngine } from "../src/eco/engine.mjs";
import { EcoApi } from "../src/eco/api.mjs";
import { EcoCache, safeEvidence } from "../src/eco/cache.mjs";
import {
  DEFAULT_ECO,
  hash,
  validateEco,
  routeModel,
} from "../src/eco/policy.mjs";
import { validateArtifact } from "../src/eco/artifacts.mjs";

const capabilities = () => ({
  browserQa: { connected: true },
  claude: { connected: true },
  staging: { connected: true },
});
const config = (overrides = {}) => ({
  ...structuredClone(DEFAULT_ECO),
  enabled: true,
  mode: "cooperative_eco",
  qaUrl: "https://preview.example.com/",
  allowedDomains: ["preview.example.com"],
  modelPolicy: {
    economy: {
      provider: "claude",
      model: "fixture-small",
      capabilities: ["code"],
    },
    standard: {
      provider: "claude",
      model: "fixture-medium",
      capabilities: ["code"],
    },
    advanced: {
      provider: "claude",
      model: "fixture-large",
      capabilities: ["code"],
    },
  },
  ...overrides,
});
async function fixture(t, overrides = {}) {
  const h = await buildHarness();
  t.after(() => h.cleanup());
  installEcoSchema(h.store);
  const eco = new EcoStore({ store: h.store, capabilities });
  eco.save(config(overrides), 0, "settings-key");
  const { task } = h.repo.createTask({
    title: "Synthetic cooperative test",
    instruction: "Test fixture only",
    repoPath: h.config.repoPath,
    source: "test",
  });
  const run = eco.create(
    task.id,
    { revision: "spec-v1", acIds: ["AC-1"] },
    "run-key-001",
  );
  const root = path.join(h.paths.dataRoot, "eco-evidence");
  fs.mkdirSync(root);
  fs.writeFileSync(
    path.join(root, "proof.txt"),
    "synthetic evidence, not real browser QA",
  );
  return { ...h, eco, run, root };
}
function artifact(run, kind, body = {}) {
  const defaults = {
    spec: {
      problem: "fixture",
      purpose: "test",
      scope: ["one"],
      steps: ["one"],
      expected: "pass",
      actual: "fail",
      environment: "synthetic",
      requirements: ["one"],
      acceptanceCriteria: ["AC-1"],
      risk: "low",
      tests: ["unit"],
      rollback: "old artifact",
      unresolved: [],
    },
    implementation: {
      specId: run.specId,
      specRevision: "spec-v1",
      baseSHA: "base",
      headSHA: "head",
      worktreeDigest: "digest",
      changes: ["text"],
      acceptanceCriteria: ["AC-1"],
      tests: ["unit"],
      build: "passed",
      deployment: null,
      rollback: "base",
      remaining: [],
    },
    qa: {
      specId: run.specId || "initial",
      deploymentId: run.deployment?.deploymentId || "initial",
      url: run.configSnapshot.qaUrl,
      revision: run.headSHA || "base",
      browser: "synthetic",
      viewport: "1200x800",
      accountType: "fixture",
      acceptanceCriteria: [
        {
          id: "AC-1",
          result: "PASS",
          steps: ["synthetic action"],
          evidenceRefs: ["proof.txt"],
        },
      ],
      findings: [],
      verdict: "PASS",
      reason: "fixture",
    },
  };
  if (kind === "implementation") defaults[kind].deployment = "pending";
  return {
    schemaVersion: 1,
    runId: run.id,
    revision: run.revision,
    producer: kind === "implementation" ? "claude" : "gpt",
    kind,
    parentArtifactIds: run.specId ? [run.specId] : [],
    evidenceRefs: ["proof.txt"],
    body: { ...defaults[kind], ...body },
  };
}
function engine(h, overrides = {}) {
  const adapter = (fn) => ({
    reconcile: async () => ({ status: "absent" }),
    execute: async ({ run }) => ({
      status: "succeeded",
      usage: {
        measuredTokens: 1,
        estimatedTokens: 0,
        costUsd: 0.01,
        costKnown: true,
      },
      ...fn(run),
    }),
  });
  return new EcoEngine({
    repo: h.eco,
    evidenceRoot: () => h.root,
    safetyGate: async () => ({ allowed: true }),
    adapters: {
      discover: adapter(() => ({ isolated: true, revision: "base" })),
      qaInitial: adapter((run) => ({
        artifact: artifact(run, "qa", {
          verdict: "FAIL",
          acceptanceCriteria: [
            {
              id: "AC-1",
              result: "FAIL",
              steps: ["synthetic"],
              evidenceRefs: ["proof.txt"],
            },
          ],
        }),
      })),
      specification: adapter((run) => ({ artifact: artifact(run, "spec") })),
      implement: adapter((run) => ({
        artifact: artifact(run, "implementation"),
      })),
      test: adapter((run) => ({
        independent: true,
        buildPassed: true,
        revision: run.headSHA,
        evidenceRefs: ["proof.txt"],
      })),
      deploy: adapter((run) => ({
        healthPassed: true,
        revision: run.headSHA,
        url: run.configSnapshot.qaUrl,
        deploymentId: "deployment-fixture",
      })),
      qaVerify: adapter((run) => ({
        currentRevision: run.headSHA,
        artifact: artifact(run, "qa"),
      })),
      ...overrides,
    },
  });
}

test("eco: additive migration is repeatable, retains legacy rows and pause, old provider maps", async (t) => {
  const h = await buildHarness();
  t.after(() => h.cleanup());
  h.repo.setPaused(true);
  h.store.setMeta("implementationProvider", "codex");
  h.repo.createTask({
    title: "existing",
    instruction: "retain",
    repoPath: h.config.repoPath,
  });
  const before = h.store.all("SELECT * FROM tasks");
  const history = h.store.all("SELECT * FROM task_state_history");
  const eco = new EcoStore({ store: h.store });
  assert.equal(eco.settings().installed, false);
  assert.equal(eco.settings().config.mode, "codex_only");
  installEcoSchema(h.store);
  installEcoSchema(h.store);
  assert.deepEqual(h.store.all("SELECT * FROM tasks"), before);
  assert.deepEqual(h.store.all("SELECT * FROM task_state_history"), history);
  assert.equal(eco.settings().config.mode, "codex_only");
  assert.equal(h.repo.getPaused(), true);
  assert.equal(h.store.integrityCheck().ok, true);
});

test("eco: settings CAS/idempotency, flag off, snapshot and pause survive reopening", async (t) => {
  const h = await fixture(t);
  h.repo.setPaused(true);
  const saved = h.eco.save(
    config({ enabled: false, maxRepairLoops: 0 }),
    1,
    "settings-two",
  );
  assert.deepEqual(
    h.eco.save(
      config({ enabled: false, maxRepairLoops: 0 }),
      1,
      "settings-two",
    ),
    saved,
  );
  assert.throws(() => h.eco.save(config(), 0, "different-key"), /version/);
  assert.throws(() => h.eco.save(config(), 1, "settings-two"), /Idempotency/);
  assert.equal(h.eco.get(h.run.id).configSnapshot.maxRepairLoops, 3);
  assert.equal(h.repo.getPaused(), true);
  h.store.close();
  const reopened = await Store.open(h.paths.dbFile);
  t.after(() => reopened.close());
  const next = new EcoStore({ store: reopened });
  assert.equal(next.settings().version, 2);
  assert.equal(next.settings().config.enabled, false);
  assert.equal(next.list().length, 1);
  assert.equal(reopened.getMeta("paused"), "1");
});

test("eco: settings deny production bypass, unconnected activation, unsafe URL and secrets", () => {
  assert.throws(
    () => validateEco(config({ productionApproval: false }), capabilities()),
    /cannot be disabled/,
  );
  assert.throws(() => validateEco(config()), /未設定/);
  assert.throws(
    () =>
      validateEco(
        config({ qaUrl: "https://production.example.com/" }),
        capabilities(),
      ),
    /allowed/,
  );
  assert.throws(
    () => validateEco(config({ testAccount: "password=123" }), capabilities()),
    /credentials/,
  );
  assert.equal(
    validateEco(config({ contextCache: false }), capabilities()).config
      .rereadPrevention,
    false,
  );
  for (const n of [-1, 11, 1.5])
    assert.throws(() =>
      validateEco(config({ maxRepairLoops: n }), capabilities()),
    );
});

test("eco: authenticated settings only; Agent cannot self-approve via role", async (t) => {
  const h = await fixture(t);
  const api = new EcoApi({
    store: h.store,
    operatorToken: "test-only-operator",
  });
  assert.throws(
    () => api.handle("POST", "/api/eco/settings", {}),
    /authentication/,
  );
  assert.throws(
    () =>
      api.handle("POST", "/api/eco/approve", { role: "human" }, "agent-token"),
    /authentication/,
  );
  assert.equal(api.handle("GET", "/api/eco/settings").installed, true);
});

test("eco: complete synthetic QA/spec/implementation/test/deploy/QA path with evidence", async (t) => {
  const h = await fixture(t);
  const e = engine(h);
  for (let i = 0; i < 10; i++) await e.tick(h.run.id);
  const run = h.eco.get(h.run.id);
  assert.equal(run.state, "COMPLETED_STAGING");
  assert.equal(run.repairCount, 0);
  assert.equal(h.store.all("SELECT * FROM eco_environment_locks").length, 0);
  assert.equal(h.store.all("SELECT * FROM eco_artifacts").length, 4);
  const events = h.store.all("SELECT sequence FROM eco_events");
  assert.equal(new Set(events.map((e) => e.sequence)).size, events.length);
  assert.equal(run.usage.costKnown, true);
});

for (const limit of [0, 2])
  test(
    "eco: repair cap persists; first execution is not a repair, limit=" + limit,
    async (t) => {
      const h = await fixture(t, { maxRepairLoops: limit });
      const e = engine(h, {
        test: {
          reconcile: async () => ({ status: "absent" }),
          execute: async () => ({ status: "failed" }),
        },
      });
      for (let i = 0; i < 30; i++) await e.tick(h.run.id);
      const run = h.eco.get(h.run.id);
      assert.equal(run.state, "HUMAN_REVIEW");
      assert.equal(run.repairCount, limit);
      assert.equal(
        new EcoStore({ store: h.store }).get(run.id).repairCount,
        limit,
      );
    },
  );

test("eco: unknown external outcome never redispatches; two workers cannot acquire", async (t) => {
  const h = await fixture(t);
  let calls = 0;
  const e = engine(h, {
    discover: {
      reconcile: async () => ({ status: "unknown" }),
      execute: async () => {
        calls++;
      },
    },
  });
  assert.equal(h.eco.acquire(h.run.id, "other-worker"), true);
  assert.equal(await e.tick(h.run.id), false);
  h.eco.release(h.run.id, "other-worker");
  await e.tick(h.run.id);
  await e.tick(h.run.id);
  await e.tick(h.run.id);
  assert.equal(calls, 0);
  assert.equal(h.eco.get(h.run.id).state, "HUMAN_REVIEW");
  assert.throws(
    () =>
      e.control(h.run.id, h.eco.get(h.run.id).version, "resume", "resume-key"),
    /Reconcile/,
  );
});

test("eco: persisted dispatch reconciles completion after simulated crash without repeating execute", async (t) => {
  const h = await fixture(t);
  let calls = 0,
    completed;
  const e = engine(h, {
    discover: {
      reconcile: async () => completed || { status: "absent" },
      execute: async () => {
        calls++;
        completed = { status: "succeeded", isolated: true, revision: "base" };
        throw Error("lost response");
      },
    },
  });
  await e.tick(h.run.id);
  await e.tick(h.run.id);
  let run = h.eco.get(h.run.id);
  h.eco.mutate(run.id, run.version, run.state, { retryAt: 0 });
  await e.tick(h.run.id);
  assert.equal(calls, 1);
  assert.equal(h.eco.get(h.run.id).state, "QA_INITIAL");
});

test("eco: pause/resume/cancel are versioned, idempotent, no implicit resume on save", async (t) => {
  const h = await fixture(t);
  const e = engine(h);
  const paused = e.control(h.run.id, 1, "pause", "pause-key");
  assert.deepEqual(e.control(h.run.id, 1, "pause", "pause-key"), paused);
  h.eco.save(config(), 1, "save-paused");
  assert.equal(await e.tick(h.run.id), false);
  const resumed = e.control(h.run.id, paused.version, "resume", "resume-key");
  assert.equal(resumed.state, "QUEUED");
  const cancelled = e.control(
    h.run.id,
    resumed.version,
    "cancel",
    "cancel-key",
  );
  assert.equal(cancelled.state, "CANCELLED");
  assert.equal(await e.tick(h.run.id), false);
});

test("eco: budgets and default safety gate stop dispatch", async (t) => {
  const h = await fixture(t);
  const e = engine(h);
  let run = h.eco.get(h.run.id);
  h.eco.mutate(run.id, run.version, run.state, { deadline: 0 });
  await e.tick(run.id);
  assert.equal(h.eco.get(run.id).state, "HUMAN_REVIEW");
  const h2 = await fixture(t);
  let called = false;
  const gated = new EcoEngine({
    repo: h2.eco,
    evidenceRoot: () => h2.root,
    adapters: {
      discover: {
        reconcile: async () => ({ status: "absent" }),
        execute: async () => {
          called = true;
        },
      },
    },
  });
  await gated.tick(h2.run.id);
  await gated.tick(h2.run.id);
  assert.equal(called, false);
  assert.equal(h2.eco.get(h2.run.id).state, "WAITING_APPROVAL");
});

test("eco: auth and rate limit waits do not count as logical repairs", async (t) => {
  for (const [status, expected] of [
    ["auth", "WAITING_USER_AUTH"],
    ["capacity", "WAITING_CAPACITY"],
  ]) {
    const h = await fixture(t);
    const e = engine(h, {
      discover: {
        reconcile: async () => ({ status: "absent" }),
        execute: async () => ({ status }),
      },
    });
    await e.tick(h.run.id);
    await e.tick(h.run.id);
    const run = h.eco.get(h.run.id);
    assert.equal(run.state, expected);
    assert.equal(run.repairCount, 0);
  }
});

test("eco: immutable artifacts reject old schema/revision, missing AC, broken evidence", async (t) => {
  const h = await fixture(t);
  const a = artifact(h.run, "qa");
  const context = {
    runId: h.run.id,
    revision: h.run.revision,
    evidenceRoot: h.root,
    acIds: ["AC-1"],
  };
  validateArtifact(a, context);
  assert.throws(() => validateArtifact({ ...a, schemaVersion: 0 }, context));
  assert.throws(() => validateArtifact({ ...a, revision: "old" }, context));
  assert.throws(() =>
    validateArtifact(
      { ...a, body: { ...a.body, acceptanceCriteria: [] } },
      context,
    ),
  );
  assert.throws(() =>
    validateArtifact({ ...a, evidenceRefs: ["missing"] }, context),
  );
  assert.throws(() =>
    validateArtifact(
      {
        ...a,
        body: {
          ...a.body,
          acceptanceCriteria: [
            { id: "AC-1", result: "NOT_RUN", steps: [], evidenceRefs: [] },
          ],
        },
      },
      context,
    ),
  );
  h.eco.artifact(h.run.id, 1, { ...a, id: "immutable" }, h.root);
  assert.throws(
    () => h.eco.artifact(h.run.id, 1, { ...a, id: "immutable" }, h.root),
    /Immutable/,
  );
  assert.throws(() => safeEvidence(h.root, "../orchestrator.db"));
});

test("eco: approval binding cannot be reused for another diff, expired request, or agent", async (t) => {
  const h = await fixture(t);
  const expiry = Date.now() + 50000;
  for (const action of protectedActions) {
    const a = h.eco.requestApproval(
      h.run.id,
      action,
      "target",
      "digest",
      expiry,
    );
    assert.throws(
      () =>
        h.eco.decideApproval(a.id, "approved", {
          role: "agent",
          actor: "claude",
        }),
      /Human/,
    );
    h.eco.decideApproval(a.id, "approved", {
      role: "human",
      actor: "test-operator",
    });
    assert.throws(() =>
      h.eco.consumeApproval(a.id, {
        runId: h.run.id,
        action,
        target: "target",
        digest: "other",
      }),
    );
    const binding = {
      runId: h.run.id,
      action,
      target: "target",
      digest: "digest",
    };
    assert.equal(h.eco.consumeApproval(a.id, binding), true);
    assert.throws(() => h.eco.consumeApproval(a.id, binding));
  }
  assert.throws(() =>
    h.eco.requestApproval(h.run.id, "billing", "target", "digest", 0),
  );
});

test("eco: context content/dependency/path change and insufficient summaries invalidate", async (t) => {
  const h = await fixture(t);
  const cache = new EcoCache({ store: h.store });
  const input = {
    repository: "repo",
    branch: "work",
    path: "file",
    contentHash: "one",
    dependencyDigest: "one",
    specVersion: 1,
    policyVersion: 1,
    schemaVersion: 1,
  };
  const id = cache.putContext(
    input,
    "sufficient summary",
    [[1, 10]],
    Date.now() + 10000,
  );
  assert.equal(cache.context(input).hit, true);
  assert.equal(cache.context(input, { sufficient: false }).hit, false);
  for (const key of ["contentHash", "dependencyDigest", "path"])
    assert.equal(cache.context({ ...input, [key]: "changed" }).hit, false);
  h.store.run("UPDATE eco_cache SET data=? WHERE id=?", ["corrupt", id]);
  assert.equal(cache.context(input).reason, "corrupt");
  assert.throws(
    () => cache.verifyBeforeEdit(path.join(h.root, "proof.txt"), "wrong"),
    /Concurrent/,
  );
});

test("eco: successful test reuse requires all fingerprints and unchanged evidence; no health reuse", async (t) => {
  const h = await fixture(t);
  const cache = new EcoCache({ store: h.store });
  const input = Object.fromEntries(
    [
      "repository",
      "gitSHA",
      "inputDigest",
      "testDigest",
      "command",
      "dependencyDigest",
      "runtime",
      "environmentVersion",
      "fixtureRevision",
      "toolchain",
      "externalVersion",
    ].map((k) => [k, "fixture"]),
  );
  const record = {
    result: "passed",
    evidencePath: path.join(h.root, "proof.txt"),
  };
  cache.putTest(input, record, Date.now() + 10000);
  assert.equal(cache.test(input).hit, true);
  for (const k of Object.keys(input))
    assert.equal(cache.test({ ...input, [k]: "changed" }).hit, false);
  assert.equal(cache.test(input, { healthCheck: true }).hit, false);
  assert.equal(cache.test(input, { external: true }).hit, false);
  assert.equal(
    cache.putTest(input, { ...record, flaky: true }, Date.now() + 1000),
    null,
  );
  assert.equal(
    cache.putTest(input, { ...record, result: "failed" }, Date.now() + 1000),
    null,
  );
  assert.equal(cache.test(input).hit, false);
  fs.writeFileSync(record.evidencePath, "changed");
  assert.equal(cache.test(input).hit, false);
});

test("eco: routing starts low for local UI, single-tier escalation, fixed model, capacity wait", () => {
  assert.equal(routeModel(config(), { phase: "local_ui" }).tier, "economy");
  assert.equal(
    routeModel(config(), { phase: "local_ui", logicalFailures: 9 }).tier,
    "standard",
  );
  assert.equal(
    routeModel(config({ modelAutoRouting: false }), { phase: "local_ui" }).tier,
    "standard",
  );
  assert.equal(
    routeModel(config(), { phase: "qa_verify" }).waiting,
    "HUMAN_REVIEW",
  );
  assert.equal(
    routeModel(config(), { phase: "local_ui", capacityLimited: true }).waiting,
    "WAITING_CAPACITY",
  );
  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
});

test("eco: staging lock covers QA and conflicts with another run", async (t) => {
  const h = await fixture(t);
  const e = engine(h);
  for (let i = 0; i < 7; i++) await e.tick(h.run.id);
  assert.equal(h.eco.get(h.run.id).state, "QA_VERIFY");
  assert.throws(
    () => h.eco.reserveEnvironment("another-run", h.run.configSnapshot.qaUrl),
    /reserved/,
  );
  await e.tick(h.run.id);
  h.eco.reserveEnvironment("another-run", h.run.configSnapshot.qaUrl);
});

test("eco: wrong deployed revision cannot complete, artifact insert rolls back", async (t) => {
  const h = await fixture(t);
  const e = engine(h);
  for (let i = 0; i < 7; i++) await e.tick(h.run.id);
  const run = h.eco.get(h.run.id);
  const count = h.store.get("SELECT COUNT(*) AS n FROM eco_artifacts").n;
  assert.throws(
    () =>
      e.accept(run, {
        status: "succeeded",
        currentRevision: "other-run",
        artifact: artifact(run, "qa"),
      }),
    /deployed build/,
  );
  assert.equal(h.eco.get(run.id).state, "QA_VERIFY");
  assert.equal(h.store.get("SELECT COUNT(*) AS n FROM eco_artifacts").n, count);
});

test("eco: invalid artifact retries have their own counter", async (t) => {
  const h = await fixture(t, { artifactRetries: 0 });
  const e = engine(h, {
    qaInitial: {
      reconcile: async () => ({ status: "absent" }),
      execute: async () => ({ status: "succeeded", artifact: {} }),
    },
  });
  for (let i = 0; i < 3; i++) await e.tick(h.run.id);
  const run = h.eco.get(h.run.id);
  assert.equal(run.state, "HUMAN_REVIEW");
  assert.equal(run.artifactFailures, 1);
  assert.equal(run.communicationFailures, 0);
  assert.equal(run.repairCount, 0);
});

test("eco: a QA BLOCKED result stays incomplete and retains environment reservation", async (t) => {
  const h = await fixture(t);
  const e = engine(h, {
    qaVerify: {
      reconcile: async () => ({ status: "absent" }),
      execute: async ({ run }) => ({
        status: "succeeded",
        currentRevision: run.headSHA,
        artifact: artifact(run, "qa", {
          verdict: "BLOCKED",
          acceptanceCriteria: [
            { id: "AC-1", result: "NOT_RUN", steps: [], evidenceRefs: [] },
          ],
        }),
      }),
    },
  });
  for (let i = 0; i < 9; i++) await e.tick(h.run.id);
  assert.equal(h.eco.get(h.run.id).state, "HUMAN_REVIEW");
  assert.equal(h.store.all("SELECT * FROM eco_environment_locks").length, 1);
});

test("eco: blocked baseline QA becomes specification input instead of human work", async (t) => {
  const h = await fixture(t);
  const e = engine(h, {
    qaInitial: {
      reconcile: async () => ({ status: "absent" }),
      execute: async ({ run }) => ({
        status: "succeeded",
        artifact: artifact(run, "qa", {
          verdict: "BLOCKED",
          acceptanceCriteria: [{ id: "AC-1", result: "NOT_RUN", steps: [], evidenceRefs: [] }],
        }),
      }),
    },
  });
  for (let i = 0; i < 5 && h.eco.get(h.run.id).state !== "SPEC_READY"; i++) await e.tick(h.run.id);
  const run = h.eco.get(h.run.id);
  assert.equal(run.state, "SPEC_READY");
  assert.ok(run.initialQaId);
});
