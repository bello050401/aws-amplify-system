import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectInstruction,
  planWork,
  selectForWork,
  verifyEvaluationEvidence,
} from "../src/eco/taskRouting.mjs";
import { routedGptWorker } from "../src/eco/routedGptWorker.mjs";

const spec = {
  purpose: "marker update",
  scope: ["index.html"],
  requirements: ["replace marker"],
  acceptanceCriteria: ["AC-1"],
  tests: ["assert marker"],
  unresolved: [],
};
const work = planWork({
  instruction: "replace marker",
  spec,
  files: ["index.html"],
  risk: "low",
  acIds: ["AC-1"],
});
function fixture(provider = "claude", category = "mechanical_edit") {
  const evaluation = {
    evaluatedAt: new Date().toISOString(),
    samples: 30,
    passRate: 1,
    baselinePassRate: 1,
    safetyFailures: 0,
    meanAttempts: 1,
    meanUsagePerAttempt: 100,
    usageUnit: "fixture-units",
    evaluationSet: "same-tasks",
    baselineModel: "base",
  };
  const catalog = ["base", "cheap"].map((model, i) => ({
    provider,
    model,
    tier: i ? "economy" : "standard",
    capabilities: ["code", "text", "browser"],
    evaluations: {
      [category]: {
        ...evaluation,
        meanUsagePerAttempt: i ? 30 : 100,
        evidenceId: "checkpoint:" + (i + 1),
      },
    },
  }));
  return {
    policy: { catalog },
    work,
    baseline: { provider, model: "base" },
    available: () => true,
    evidenceVerified: () => true,
  };
}
test("instruction checks precede implementation; preparation can start from original intent", () => {
  assert.equal(inspectInstruction("replace", spec, ["AC-1"]).ready, true);
  assert.equal(inspectInstruction("", spec).ready, false);
  assert.equal(inspectInstruction("replace", { ...spec, unresolved: ["既存API契約をコードで確認する"] }).ready, true);
  assert.equal(inspectInstruction("replace", { ...spec, unresolved: ["本人によるOAuth認証操作が必要"] }).ready, false);
  assert.equal(inspectInstruction("replace", spec, ["AC-2"]).ready, false);
  assert.equal(
    selectForWork({ ...fixture(), work: planWork({ instruction: "replace" }) })
      .waiting,
    "HUMAN_REVIEW",
  );
  assert.equal(
    selectForWork({
      ...fixture(),
      work: planWork({ instruction: "replace", phase: "specification" }),
    }).model,
    "base",
  );
});
test("work categories distinguish host execution, simple edits and safety-sensitive work", () => {
  assert.equal(work.category, "mechanical_edit");
  assert.equal(
    planWork({
      instruction: "replace",
      files: ["src/auth/config.js"],
      risk: "low",
    }).category,
    "security",
  );
  assert.equal(
    selectForWork({ ...fixture(), work: planWork({ phase: "test" }) }).executor,
    "host",
  );
});
for (const provider of ["claude", "codex"])
  test(`${provider}: choose cheaper qualified model only within same provider`, () => {
    const args = fixture(provider);
    args.roleProvider = provider;
    assert.equal(selectForWork(args).model, "cheap");
    args.policy.catalog[1].provider =
      provider === "claude" ? "codex" : "claude";
    assert.equal(selectForWork(args).model, "base");
  });
for (const [name, mutate] of Object.entries({
  regression: (e) => {
    e.passRate = 0.96;
  },
  samples: (e) => {
    e.samples = 29;
  },
  stale: (e) => {
    e.evaluatedAt = "2000-01-01";
  },
  future: (e) => {
    e.evaluatedAt = "2999-01-01";
  },
  safety: (e) => {
    e.safetyFailures = 1;
  },
  retries: (e) => {
    e.meanAttempts = 4;
  },
  units: (e) => {
    e.usageUnit = "other";
  },
  tasks: (e) => {
    e.evaluationSet = "other";
  },
  unknown: (e) => {
    delete e.meanUsagePerAttempt;
  },
}))
  test(`reject unsuitable economy candidate: ${name}`, () => {
    const args = fixture();
    mutate(args.policy.catalog[1].evaluations.mechanical_edit);
    assert.equal(selectForWork(args).model, "base");
  });
test("unverified evidence, logical failures and capacity never trigger cheap routing", () => {
  assert.equal(
    selectForWork({ ...fixture(), autoRouting: false }).model,
    "base",
  );
  assert.equal(
    selectForWork({ ...fixture(), evidenceVerified: () => false }).model,
    "base",
  );
  assert.equal(
    selectForWork({ ...fixture(), logicalFailures: 1 }).model,
    "base",
  );
  assert.equal(
    selectForWork({ ...fixture(), capacityLimited: true }).waiting,
    "WAITING_CAPACITY",
  );
});
test("evidence must match durable independent checkpoint", () => {
  const model = fixture().policy.catalog[1],
    ev = model.evaluations.mechanical_edit;
  const record = {
    schemaVersion: 1,
    origin: "host-independent-evaluation",
    provider: model.provider,
    model: model.model,
    category: "mechanical_edit",
    evaluation: ev,
  };
  const store = { get: () => ({ data: JSON.stringify(record) }) };
  assert.equal(
    verifyEvaluationEvidence(store, model, "mechanical_edit", ev),
    true,
  );
  assert.equal(
    verifyEvaluationEvidence(store, model, "mechanical_edit", {
      ...ev,
      passRate: 0.99,
    }),
    false,
  );
  assert.equal(
    verifyEvaluationEvidence({ get: () => null }, model, "mechanical_edit", ev),
    false,
  );
});
test("GPT dispatcher invokes exact model worker and pins selection across retry", async () => {
  const args = fixture("codex", "specification");
  const decisions = new Map();
  const repo = {
    store: {
      get: (sql, params) => {
        if (sql.includes("eco_model_evaluation")) {
          const model = args.policy.catalog[params[0] - 1];
          return {
            data: JSON.stringify({
              schemaVersion: 1,
              origin: "host-independent-evaluation",
              provider: "codex",
              model: model.model,
              category: "specification",
              evaluation: model.evaluations.specification,
            }),
          };
        }
        const data = decisions.get(params[1]);
        return data ? { data: JSON.stringify(data) } : null;
      },
    },
    checkpoint: (id, phase, data) => decisions.set(phase, data),
  };
  const calls = [];
  const workers = Object.fromEntries(
    ["base", "cheap"].map((model) => [
      model,
      {
        capabilities: ["text"],
        execute: async () => {
          calls.push(model);
          return { status: "succeeded" };
        },
        reconcile: async () => ({ status: "absent" }),
      },
    ]),
  );
  const worker = routedGptWorker({
    repo,
    phase: "specification",
    baseline: args.baseline,
    workers,
    describeWork: async () => ({ instruction: "replace marker", risk: "low" }),
  });
  const context = {
    run: { task_id: "task", configSnapshot: { taskRouting: args.policy } },
    operationKey: "op",
  };
  await worker.execute(context);
  context.run.configSnapshot.taskRouting = { enabled: false };
  await worker.execute(context);
  assert.deepEqual(calls, ["cheap", "cheap"]);
  workers.cheap.capabilities = [];
  assert.equal((await worker.execute(context)).status, "blocked");
});
