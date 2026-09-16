import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store/db.mjs";
import { Repo } from "../src/store/repo.mjs";
import { Orchestrator } from "../src/core/orchestrator.mjs";
import { STATES } from "../src/core/states.mjs";
import { installEcoSchema, EcoStore } from "../src/eco/store.mjs";

const CAPABILITIES = () => ({
  browserQa: { connected: true },
  claude: { connected: true },
  staging: { connected: true },
});

function coopConfig(overrides = {}) {
  return {
    enabled: true,
    mode: "cooperative_eco",
    gptBrowserQa: true,
    claudeImplementation: true,
    modelAutoRouting: true,
    contextCache: true,
    rereadPrevention: true,
    maxRepairLoops: 3,
    stagingAutoDeploy: true,
    productionApproval: true,
    maxElapsedSeconds: 3600,
    maxTokens: 100000,
    maxCostUsd: 5,
    communicationRetries: 2,
    artifactRetries: 2,
    retentionDays: 30,
    qaUrl: "https://qa.example.com/",
    allowedDomains: ["qa.example.com"],
    testAccount: "",
    modelPolicy: {
      economy: null,
      standard: { provider: "claude", model: "m", capabilities: ["code"] },
      advanced: null,
    },
    ...overrides,
  };
}

async function fixture() {
  const store = await Store.open(":memory:");
  const repo = new Repo(store);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "eco-mode-queue-"));
  const { task } = repo.createTask({
    title: "legacy task",
    instruction: "do it",
    source: "test",
    priority: 50,
    repoPath: workDir, // 非 git ディレクトリ。claim されれば preflight で fail する。
  });
  const verifier = { required: false, check: () => ({ passed: true, failures: [] }), run: async () => {} };
  const orchestrator = new Orchestrator({
    config: {},
    paths: {},
    repo,
    logger: { info() {}, warn() {}, error() {} },
    runner: { run: async () => { throw new Error("legacy runner must not be invoked while coop eco mode owns the queue"); } },
    todoManager: {},
    verifier,
  });
  return { store, repo, workDir, task, orchestrator };
}

test("eco schema未導入では従来どおりqueuedタスクをclaimする", async () => {
  const { repo, task, orchestrator } = await fixture();
  const did = await orchestrator.tick();
  assert.equal(did, true);
  assert.equal(repo.getTask(task.id).state, STATES.FAILED); // 非gitディレクトリなのでpreflightで失敗=claimされた証拠
});

test("通常モード(claude_only)ではeco導入後も従来どおりclaimする", async () => {
  const { store, repo, task, orchestrator } = await fixture();
  installEcoSchema(store);
  const eco = new EcoStore({ store, capabilities: CAPABILITIES });
  eco.save({ enabled: false, mode: "claude_only" }, 0, "key-normal-mode-00001");

  const did = await orchestrator.tick();
  assert.equal(did, true);
  assert.equal(repo.getTask(task.id).state, STATES.FAILED);
});

test("cooperative_ecoモード有効時はlegacy queuedタスクをclaimしない", async () => {
  const { store, repo, task, orchestrator } = await fixture();
  installEcoSchema(store);
  const eco = new EcoStore({ store, capabilities: CAPABILITIES });
  eco.save(coopConfig(), 0, "key-coop-enable-000001");

  const did = await orchestrator.tick();
  assert.equal(did, false);
  assert.equal(repo.getTask(task.id).state, STATES.QUEUED);
});

test("global pauseを解除してもcooperative_ecoモードのままなら旧タスクは実行されない", async () => {
  const { store, repo, task, orchestrator } = await fixture();
  installEcoSchema(store);
  const eco = new EcoStore({ store, capabilities: CAPABILITIES });
  eco.save(coopConfig(), 0, "key-coop-enable-000002");

  // モード切替で自動的にpausedへ倒れているはず
  assert.equal(repo.getPaused(), true);

  // ユーザーが明示的にresumeしても、モードがcoopのままなら legacy queueは動かない
  orchestrator.resume();
  assert.equal(repo.getPaused(), false);

  const did = await orchestrator.tick();
  assert.equal(did, false);
  assert.equal(repo.getTask(task.id).state, STATES.QUEUED);
});

test("mode/enabledの切替保存はglobal pauseを強制する", async () => {
  const { store, repo } = await fixture();
  installEcoSchema(store);
  const eco = new EcoStore({ store, capabilities: CAPABILITIES });

  repo.setPaused(false, "user");
  const saved = eco.save(coopConfig(), 0, "key-force-pause-000001");
  assert.equal(repo.getPaused(), true);
  assert.equal(saved.config.mode, "cooperative_eco");
});

test("同モードでの予算などの保存は既存のpause状態を維持する(解除しない/勝手に停めない)", async () => {
  const { store, repo } = await fixture();
  installEcoSchema(store);
  const eco = new EcoStore({ store, capabilities: CAPABILITIES });

  const v1 = eco.save(coopConfig(), 0, "key-budget-mode-000001");
  assert.equal(repo.getPaused(), true); // モード切替による強制pause

  // ユーザーが明示的にresumeした後、同モードのまま予算だけ変更しても勝手に一時停止しない
  repo.setPaused(false, "user");
  const v2 = eco.save(coopConfig({ maxCostUsd: 9 }), v1.version, "key-budget-mode-000002");
  assert.equal(v2.config.maxCostUsd, 9);
  assert.equal(v2.config.mode, "cooperative_eco");
  assert.equal(repo.getPaused(), false);

  // 逆に、pauseされたままなら予算だけの保存でも解除しない
  repo.setPaused(true, "user");
  const v3 = eco.save(coopConfig({ maxCostUsd: 11 }), v2.version, "key-budget-mode-000003");
  assert.equal(v3.config.maxCostUsd, 11);
  assert.equal(repo.getPaused(), true);
});
