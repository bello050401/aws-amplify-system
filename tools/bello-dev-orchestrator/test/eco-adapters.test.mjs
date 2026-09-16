import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildHarness, initRepo } from "./helpers.mjs";
import { makeReport } from "../src/runner/fakeRunner.mjs";
import { installEcoSchema } from "../src/eco/store.mjs";
import { DEFAULT_ECO } from "../src/eco/policy.mjs";
import {
  existingAdapters,
  implementationFailure,
} from "../src/eco/existingAdapters.mjs";
import { DesktopQaBridge } from "../src/eco/desktopQaBridge.mjs";
import { IndependentVerifier } from "../src/pipeline/verification.mjs";
import { runGit } from "../src/core/git.mjs";

test("eco implementation: weekly quota is capacity, never a logical failure or model upgrade", () => {
  assert.equal(
    implementationFailure({
      apiErrorStatus: 429,
      providerError: "You've hit your weekly limit",
    }).status,
    "capacity",
  );
  assert.equal(implementationFailure({ apiErrorStatus: 401 }).status, "auth");
  assert.equal(
    implementationFailure({ terminationReason: "spawn_failed" }).status,
    "blocked",
  );
  assert.equal(
    implementationFailure({ ok: false, report: { status: "failed" } }).status,
    "failed",
  );
});

test("eco adapters: existing runner, real independent command and scoped commit, durable result reuse", async (t) => {
  const h = await buildHarness({
    verification: {
      required: true,
      commands: [
        {
          name: "check",
          file: "node",
          args: [
            "-e",
            "require('assert/strict').equal(require('fs').readFileSync('README.md','utf8'),'verified')",
          ],
          timeoutSeconds: 5,
        },
      ],
    },
  });
  t.after(() => h.cleanup());
  initRepo(h.config.repoPath);
  installEcoSchema(h.store);
  const task = h.repo.createTask({
    title: "adapter",
    instruction: "replace marker",
    repoPath: h.config.repoPath,
    workDir: h.config.repoPath,
  }).task;
  h.repo.updateTask(task.id, { isolation: "worktree", attempts: 1 });
  const run = {
    id: "eco_fixture",
    task_id: task.id,
    revision: "spec-v1",
    specId: "spec-fixture",
    acIds: ["AC-1"],
    logicalFailures: 0,
    risk: "low",
    configSnapshot: {
      ...DEFAULT_ECO,
      modelPolicy: {
        standard: {
          provider: "claude",
          model: "fixture",
          capabilities: ["code"],
        },
      },
    },
  };
  h.store.run("INSERT INTO eco_artifacts VALUES(?,?,?,?,?,?)", [
    run.specId,
    run.id,
    run.revision,
    "spec",
    "fixture",
    JSON.stringify({
      kind: "spec",
      runId: run.id,
      revision: run.revision,
      body: {
        purpose: "Verify adapter behavior",
        scope: ["README.md"],
        requirements: ["fixture"],
        acceptanceCriteria: ["AC-1"],
        tests: ["independent command"],
        unresolved: [],
      },
    }),
  ]);
  run.configSnapshot.taskRouting = {
    catalog: ["fixture", "fixture-cheap"].map((model, i) => {
      const evaluation = {
        evaluatedAt: new Date().toISOString(),
        samples: 30,
        passRate: 1,
        baselinePassRate: 1,
        safetyFailures: 0,
        meanAttempts: 1,
        meanUsagePerAttempt: i ? 30 : 100,
        usageUnit: "test-units",
        evaluationSet: "same-tasks",
        baselineModel: "fixture",
      };
      h.repo.checkpoint(task.id, "eco_model_evaluation", {
        schemaVersion: 1,
        origin: "host-independent-evaluation",
        provider: "claude",
        model,
        category: "mechanical_edit",
        evaluation,
      });
      const row = h.store.get(
        "SELECT id FROM checkpoints WHERE task_id=? AND phase='eco_model_evaluation' ORDER BY id DESC LIMIT 1",
        [task.id],
      );
      return {
        provider: "claude",
        model,
        tier: i ? "economy" : "standard",
        capabilities: ["code"],
        evaluations: {
          mechanical_edit: {
            ...evaluation,
            evidenceId: "checkpoint:" + row.id,
          },
        },
      };
    }),
  };
  run.configSnapshot.modelAutoRouting = true;
  let calls = 0;
  const verifier = new IndependentVerifier({
    config: h.config,
    paths: h.paths,
    repo: h.repo,
  });
  const adapters = existingAdapters({
    repo: h.repo,
    taskForRun: () => h.repo.getTask(task.id),
    evidenceRoot: () => path.join(h.paths.dataRoot, "proof"),
    assertIsolated: async () => {},
    runnerForModel: (selection) => ({
      run: async () => {
        assert.equal(selection.model, "fixture-cheap");
        calls++;
        fs.writeFileSync(path.join(h.config.repoPath, "README.md"), "verified");
        return { ok: true, report: makeReport(task.id), costUsd: 0 };
      },
    }),
    verifier,
    modelAvailable: async () => true,
    allowedPaths: ["README.md"],
  });
  const context = {
    run,
    operationKey: "implementation-fixture",
    signal: () => false,
  };
  const implementation = await adapters.implement.execute(context);
  assert.equal(implementation.status, "succeeded");
  assert.deepEqual(await adapters.implement.reconcile(context), implementation);
  await adapters.implement.execute(context);
  assert.equal(calls, 1);
  const tests = await adapters.test.execute({
    ...context,
    run: { ...run, headSHA: implementation.artifact.body.headSHA },
    operationKey: "tests-fixture",
  });
  assert.equal(tests.status, "succeeded");
  assert.notEqual(tests.revision, tests.sourceRevision);
  assert.equal(verifier.check(h.repo.getTask(task.id)).passed, true);
  assert.equal(runGit(h.config.repoPath, ["status", "--porcelain"]).stdout, "");
});

test("desktop QA bridge: scoped response, no implicit approval, rechecks published revision", async (t) => {
  const h = await buildHarness();
  t.after(() => h.cleanup());
  const directory = path.join(h.paths.dataRoot, "qa");
  let sameBuild = true;
  const bridge = new DesktopQaBridge({
    directory,
    verifyDeployment: async () => sameBuild,
  });
  const adapter = bridge.adapter("qaVerify");
  const key = "a".repeat(64);
  const context = {
    run: {
      id: "run",
      revision: "v1",
      acIds: ["AC1"],
      headSHA: "head",
      configSnapshot: { qaUrl: "https://preview.example.com/" },
    },
    operationKey: key,
  };
  assert.equal((await adapter.reconcile(context)).status, "absent");
  assert.equal((await adapter.execute(context)).status, "pending");
  const request = JSON.parse(
    fs.readFileSync(path.join(directory, key + ".request.json"), "utf8"),
  );
  fs.writeFileSync(
    path.join(directory, key + ".response.json"),
    JSON.stringify({ operationKey: key, token: "wrong", artifact: {} }),
  );
  assert.equal((await adapter.reconcile(context)).status, "blocked");
  fs.writeFileSync(
    path.join(directory, key + ".response.json"),
    JSON.stringify({
      operationKey: key,
      token: request.token,
      artifact: { kind: "qa" },
    }),
  );
  assert.equal((await adapter.reconcile(context)).status, "succeeded");
  sameBuild = false;
  assert.equal((await adapter.reconcile(context)).status, "blocked");
});
