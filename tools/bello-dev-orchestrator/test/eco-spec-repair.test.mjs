import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store/db.mjs";
import { Repo } from "../src/store/repo.mjs";
import { installEcoSchema, EcoStore } from "../src/eco/store.mjs";
import { EcoEngine } from "../src/eco/engine.mjs";
import { buildSpecSchema } from "../src/eco/serviceBindings.mjs";
import { subscriptionTextWorker } from "../src/eco/subscriptionTextWorker.mjs";

const connectedCapabilities = () => ({
  browserQa: { connected: true },
  claude: { connected: true },
  staging: { connected: true },
});

async function makeFixture() {
  const store = await Store.open(":memory:");
  const repo = new Repo(store);
  installEcoSchema(store);
  return { store, repo, ecoStore: new EcoStore({ store, capabilities: connectedCapabilities }) };
}

function makeTask(repo) {
  const { task } = repo.createTask({
    title: "t",
    instruction: "Fix the header copy",
    source: "test",
    priority: 50,
    repoPath: "/repo",
    dependsOn: [],
    maxAttempts: 3,
    maxRevisions: 3,
  });
  return task;
}

function enable(ecoStore) {
  const s = ecoStore.settings();
  return ecoStore.save(
    {
      ...s.config,
      enabled: true,
      mode: "cooperative_eco",
      qaUrl: "https://qa.example.test/",
      allowedDomains: ["qa.example.test"],
      modelPolicy: { standard: { provider: "claude", model: "sonnet", capabilities: ["implementation"] } },
    },
    s.version,
    "enable-0001",
  );
}

function startSpecReadyRun(ecoStore, task) {
  let run = ecoStore.create(task.id, { revision: "r1", acIds: ["AC1"] }, "start-0001-key");
  run = ecoStore.mutate(run.id, run.version, "DISCOVERING", {}, "fixture");
  run = ecoStore.mutate(run.id, run.version, "QA_INITIAL", {}, "fixture");
  run = ecoStore.mutate(run.id, run.version, "SPEC_READY", {}, "fixture");
  return run;
}

const validSpecBody = (acIds) => ({
  problem: "p",
  purpose: "purpose text",
  scope: ["index.html"],
  steps: ["s"],
  expected: "e",
  actual: "a",
  environment: "env",
  requirements: ["r"],
  acceptanceCriteria: acIds.map((id) => ({ id, text: "text" })),
  risk: "low",
  tests: ["t"],
  rollback: "rb",
  unresolved: [],
});

function makeSpecEngine(ecoStore, adapter, tmpDir) {
  return new EcoEngine({
    repo: ecoStore,
    adapters: { specification: adapter },
    evidenceRoot: () => tmpDir,
    safetyGate: async () => ({ allowed: true }),
  });
}

test("buildSpecSchema restricts scope to the exact host-allowed path enum", () => {
  const schema = buildSpecSchema(["index.html", "styles.css"]);
  assert.deepEqual(schema.properties.scope.items.enum, ["index.html", "styles.css"]);
  assert.equal(schema.properties.scope.minItems, 1);
});

test("subscriptionTextWorker marks a host artifact-validation failure as a typed, effect-completed, invalid artifact with usage", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bello-spec-worker-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = {
    model: "fixture",
    executable: "fixture",
    directory,
    schema: buildSpecSchema(["index.html"]),
    assertSubscription: async () => true,
    buildPrompt: async () => "fixture",
    makeArtifact: async () => {
      throw Error("Specification scope exceeds the host-allowed file set");
    },
    execute: async (args) => {
      fs.writeFileSync(
        args.args[args.args.indexOf("--output-last-message") + 1],
        JSON.stringify({ scope: ["index.html", "other.html"] }),
      );
      return {
        ok: true,
        stdout: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2 } }),
      };
    },
  };
  const context = { run: { id: "run" }, operationKey: "spec-one" };
  const result = await subscriptionTextWorker(config).execute(context);
  assert.equal(result.status, "failed");
  assert.equal(result.effectCompleted, true);
  assert.equal(result.artifactInvalid, true);
  assert.ok(result.reason.includes("Host artifact validation"));
  assert.equal(result.usage.measuredTokens, 7);
});

test("a typed invalid-artifact spec failure regenerates with a fresh operation key and succeeds without inflating communication or repair counters", async (t) => {
  const { store, repo, ecoStore } = await makeFixture();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bello-spec-repair-"));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    store.close();
  });
  enable(ecoStore);
  const task = makeTask(repo);
  let run = startSpecReadyRun(ecoStore, task);

  const seenKeys = [];
  const adapter = {
    calls: 0,
    dispatched: {},
    async reconcile({ operationKey }) {
      return this.dispatched[operationKey] || { status: "absent" };
    },
    async execute(context) {
      this.calls += 1;
      seenKeys.push(context.operationKey);
      const usage = { measuredTokens: 5, estimatedTokens: 0, costUsd: 0, costKnown: false };
      const result =
        this.calls === 1
          ? {
              status: "failed",
              reason: "Host artifact validation: Specification scope exceeds the host-allowed file set",
              effectCompleted: true,
              artifactInvalid: true,
              usage,
            }
          : {
              status: "succeeded",
              usage,
              artifact: {
                schemaVersion: 1,
                runId: context.run.id,
                revision: context.run.revision,
                producer: "codex",
                kind: "spec",
                parentArtifactIds: [],
                evidenceRefs: [],
                body: validSpecBody(context.run.acIds),
              },
            };
      this.dispatched[context.operationKey] = result;
      return result;
    },
  };
  const engine = makeSpecEngine(ecoStore, adapter, tmpDir);

  assert.equal(await engine.tick(run.id), true);
  let after = ecoStore.get(run.id);
  assert.equal(after.state, "SPEC_READY", "stays in the same read-only phase for a bounded retry");
  assert.equal(after.artifactFailures, 1);
  assert.equal(after.communicationFailures, 0);
  assert.equal(after.repairCount, 0);
  assert.equal(after.pendingEffect, null);
  assert.equal(adapter.calls, 1);

  assert.equal(await engine.tick(run.id), true);
  after = ecoStore.get(run.id);
  assert.equal(after.state, "IMPLEMENTING");
  assert.equal(after.artifactFailures, 1, "a later success must not add to the failure count");
  assert.equal(after.communicationFailures, 0);
  assert.equal(after.repairCount, 0);
  assert.equal(after.usage.measuredTokens, 10, "usage from the failed attempt is still counted");
  assert.equal(adapter.calls, 2);
  assert.notEqual(seenKeys[0], seenKeys[1], "a fresh operation key must be used after an invalid artifact");
});

test("artifact retries are bounded; exceeding the cap moves to HUMAN_REVIEW with usage still recorded", async (t) => {
  const { store, repo, ecoStore } = await makeFixture();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bello-spec-repair-cap-"));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    store.close();
  });
  enable(ecoStore);
  const task = makeTask(repo);
  const run = startSpecReadyRun(ecoStore, task);

  const adapter = {
    calls: 0,
    dispatched: {},
    async reconcile({ operationKey }) {
      return this.dispatched[operationKey] || { status: "absent" };
    },
    async execute(context) {
      this.calls += 1;
      const result = {
        status: "failed",
        reason: "Host artifact validation: Specification scope exceeds the host-allowed file set",
        effectCompleted: true,
        artifactInvalid: true,
        usage: { measuredTokens: 1, estimatedTokens: 0, costUsd: 0, costKnown: false },
      };
      this.dispatched[context.operationKey] = result;
      return result;
    },
  };
  const engine = makeSpecEngine(ecoStore, adapter, tmpDir);
  const artifactRetries = ecoStore.get(run.id).configSnapshot.artifactRetries;

  for (let i = 0; i <= artifactRetries; i++) await engine.tick(run.id);

  const after = ecoStore.get(run.id);
  assert.equal(after.state, "HUMAN_REVIEW");
  assert.equal(after.artifactFailures, artifactRetries + 1);
  assert.equal(after.communicationFailures, 0);
  assert.equal(after.usage.measuredTokens, artifactRetries + 1);
  assert.equal(adapter.calls, artifactRetries + 1);
});

test("a plain failed spec result without the typed artifact flags still uses the original communication-failure path", async (t) => {
  const { store, repo, ecoStore } = await makeFixture();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bello-spec-repair-plain-"));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    store.close();
  });
  enable(ecoStore);
  const task = makeTask(repo);
  const run = startSpecReadyRun(ecoStore, task);

  const adapter = {
    dispatched: {},
    async reconcile({ operationKey }) {
      return this.dispatched[operationKey] || { status: "absent" };
    },
    async execute(context) {
      const result = { status: "failed" };
      this.dispatched[context.operationKey] = result;
      return result;
    },
  };
  const engine = makeSpecEngine(ecoStore, adapter, tmpDir);

  assert.equal(await engine.tick(run.id), false);
  const after = ecoStore.get(run.id);
  assert.equal(after.state, "SPEC_READY");
  assert.equal(after.communicationFailures, 1);
  assert.equal(after.artifactFailures, 0);
});

test("an unknown spec effect result is never replayed as a new dispatch", async (t) => {
  const { store, repo, ecoStore } = await makeFixture();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bello-spec-repair-unknown-"));
  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    store.close();
  });
  enable(ecoStore);
  const task = makeTask(repo);
  const run = startSpecReadyRun(ecoStore, task);

  let executeCalls = 0;
  const adapter = {
    async reconcile() {
      return { status: "unknown", reason: "Previous CLI dispatch has no durable outcome" };
    },
    async execute() {
      executeCalls += 1;
      throw Error("must never be dispatched for an unknown prior result");
    },
  };
  const engine = makeSpecEngine(ecoStore, adapter, tmpDir);

  assert.equal(await engine.tick(run.id), true);
  const after = ecoStore.get(run.id);
  assert.equal(after.state, "HUMAN_REVIEW");
  assert.equal(after.pendingEffect.status, "unknown");
  assert.equal(executeCalls, 0);

  assert.throws(
    () => engine.control(run.id, after.version, "resume", "resume-key-0001"),
    /[Rr]econcile/,
  );
});
