// Dedicated static smoke target only. Uses a NEW DB, repository and worktree.
// GPT desktop QA participates through scoped request files, never simulated QA.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeConfig } from "../helpers.mjs";
import { derivePaths, ensureDirs } from "../../src/config.mjs";
import { Store } from "../../src/store/db.mjs";
import { Repo } from "../../src/store/repo.mjs";
import { Logger } from "../../src/log/logger.mjs";
import { ClaudeRunner } from "../../src/runner/claudeRunner.mjs";
import { IndependentVerifier } from "../../src/pipeline/verification.mjs";
import {
  AmplifyStaticDelivery,
  validateSmokeHtml,
  digest,
} from "../../src/pipeline/staticStaging.mjs";
import { EcoStore, installEcoSchema } from "../../src/eco/store.mjs";
import { DEFAULT_ECO } from "../../src/eco/policy.mjs";
import { EcoEngine } from "../../src/eco/engine.mjs";
import { existingAdapters } from "../../src/eco/existingAdapters.mjs";
import { DesktopQaBridge } from "../../src/eco/desktopQaBridge.mjs";

const root = (process.env.BELLO_ECO_LIVE_ROOT || "C:/Users/win/Documents/Codex/bello-eco-live-20260916").replaceAll('\\', '/');
if (!/^C:\/Users\/win\/Documents\/Codex\/bello-eco-live-20260916(?:-[a-z0-9-]+)?$/.test(root)) throw Error('Dedicated smoke directory required');
const source = root + "/source",
  work = root + "/worktree";
const git = (cwd, args) => {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) throw Error(r.stderr);
  return r.stdout.trim();
};
fs.mkdirSync(root, { recursive: true });
if (!fs.existsSync(source))
  git(root, [
    "clone",
    "--no-hardlinks",
    "C:/Users/win/Documents/Codex/bello-live-smoke/source",
    source,
  ]);
if (!fs.existsSync(work))
  git(source, ["worktree", "add", "-b", "eco-smoke-20260916", work]);
const marker = "BELLO COOPERATIVE ECO VERIFIED 20260916";
const test = `const f=require('fs'),a=require('assert/strict'),s=f.readFileSync('index.html','utf8');a(s.includes('${marker}'));a(!/script|https?:|src=|href=|form/i.test(s));console.log('ACCEPTANCE_PASS');`;
const config = makeConfig({
  repoPath: source,
  dataRoot: root + "/data",
  verification: {
    required: true,
    commands: [
      {
        name: "static acceptance and build format",
        file: "node",
        args: ["-e", test],
        cwd: ".",
        timeoutSeconds: 20,
      },
    ],
  },
  staging: {
    enabled: true,
    mode: "static-smoke",
    accountId: "203918843421",
    appId: "d22lq9g4o2zu1o",
    appName: "bello-orchestrator-smoke",
    branch: "preview-orchestrator",
    region: "us-west-2",
    profile: "Bello",
    isolatedDataConfirmed: true,
    maxWaitSeconds: 600,
  },
});
config.claude.executable = "C:/Users/win/.local/bin/claude.exe";
config.claude.model = "sonnet";
config.claude.timeoutSeconds = 240;
config.claude.allowedTools = ["Read", "Edit", "Write", "Bash(node:*)"];
config.claude.disallowedTools = [
  "Bash(git:*)",
  "Bash(aws:*)",
  "WebFetch",
  "WebSearch",
];
const paths = derivePaths(config);
ensureDirs(paths);
const store = await Store.open(paths.dbFile);
installEcoSchema(store);
const repo = new Repo(store),
  logger = new Logger({
    dir: paths.logDir,
    name: "eco-live",
    level: "info",
    echo: false,
  });
const verifier = new IndependentVerifier({ config, paths, repo });
const delivery = new AmplifyStaticDelivery({ config, repo, verifier });
// Read-only AWS isolation checks must succeed before a run can be created.
await delivery.preflight();
const capabilities = () => ({
  browserQa: { connected: true, sessionScoped: true },
  claude: { connected: true },
  staging: { connected: true },
});
const eco = new EcoStore({ store, capabilities });
if (!eco.settings().version)
  eco.save(
    {
      ...structuredClone(DEFAULT_ECO),
      enabled: true,
      mode: "cooperative_eco",
      maxElapsedSeconds: 1800,
      qaUrl: "https://preview-orchestrator.d22lq9g4o2zu1o.amplifyapp.com/",
      allowedDomains: ["preview-orchestrator.d22lq9g4o2zu1o.amplifyapp.com"],
      testAccount: "public isolated smoke",
      modelPolicy: {
        economy: null,
        standard: {
          provider: "claude",
          model: "sonnet",
          capabilities: ["code"],
        },
        advanced: null,
      },
    },
    0,
    "live-settings-v1",
  );
let task = repo.listTasks({ limit: 1 })[0];
if (!task) {
  task = repo.createTask({
    title: "Dedicated cooperative eco smoke",
    instruction:
      "Replace READY with " + marker + " in index.html only. No other change.",
    source: "system",
    repoPath: source,
    workDir: work,
  }).task;
  repo.updateTask(task.id, {
    isolation: "worktree",
    worktree_path: work,
    worktree_branch: "eco-smoke-20260916",
    base_commit: git(work, ["rev-parse", "HEAD"]),
    attempts: 1,
  });
}
let run =
  eco.list()[0] ||
  eco.create(
    task.id,
    { revision: "eco-smoke-spec-v1", acIds: ["AC-MARKER", "AC-SAFE-STATIC"] },
    "live-run-v1",
  );
const evidenceRoot = (id) => root + "/evidence/" + id;
fs.mkdirSync(evidenceRoot(run.id), { recursive: true });
const assertIsolated = async (value) => {
  if (
    fs.realpathSync(value.work_dir) !== fs.realpathSync(work) ||
    git(work, ["branch", "--show-current"]) !== "eco-smoke-20260916"
  )
    throw Error("Worktree scope mismatch");
  const files = git(work, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  if (files !== "index.html") throw Error("Only index.html is permitted");
  validateSmokeHtml(fs.readFileSync(work + "/index.html", "utf8"));
};
const verifyDeployment = async (current) => {
  const value = repo.getTask(current.task_id);
  await assertIsolated(value);
  await delivery.preflight();
  const row = delivery.row(value.id);
  if (
    row?.state !== "succeeded" ||
    row.commit_id !== current.headSHA ||
    row.job_id !== current.deployment?.deploymentId
  )
    return false;
  const expected = delivery.artifact(value).sha256;
  const response = await fetch(
    current.configSnapshot.qaUrl + "?eco=" + expected,
    { redirect: "error", signal: AbortSignal.timeout(15000) },
  );
  return (
    response.ok &&
    digest(Buffer.from(await response.arrayBuffer())) === expected
  );
};
const bridge = new DesktopQaBridge({
  directory: root + "/qa-requests",
  verifyDeployment,
});
const adapters = existingAdapters({
  repo,
  eco,
  taskForRun: (current) => repo.getTask(current.task_id),
  evidenceRoot,
  assertIsolated,
  allowedPaths: ["index.html"],
  runnerForModel: (selected) =>
    new ClaudeRunner({
      config: {
        ...config,
        claude: { ...config.claude, model: selected.model },
      },
      paths,
      logger,
    }),
  modelAvailable: async (selected) =>
    selected.provider === "claude" && selected.model === "sonnet",
  verifier,
  delivery,
});
Object.assign(adapters, {
  qaInitial: bridge.adapter("qaInitial"),
  specification: bridge.adapter("specification"),
  qaVerify: bridge.adapter("qaVerify"),
});
const engine = new EcoEngine({
  repo: eco,
  adapters,
  evidenceRoot,
  safetyGate: async ({ run: current }) => {
    await assertIsolated(repo.getTask(current.task_id));
    return { allowed: true };
  },
});
fs.writeFileSync(
  root + "/run.json",
  JSON.stringify(
    {
      runId: run.id,
      taskId: task.id,
      evidenceRoot: evidenceRoot(run.id),
      db: paths.dbFile,
      marker,
    },
    null,
    2,
  ),
);
let previous;
for (let n = 0; n < 900; n++) {
  await engine.tick(run.id);
  run = eco.get(run.id);
  fs.writeFileSync(
    root + "/result.json",
    JSON.stringify({ run, delivery: delivery.row(task.id) }, null, 2),
  );
  if (run.state !== previous) {
    console.log(run.state);
    previous = run.state;
  }
  if (
    [
      "COMPLETED_STAGING",
      "FAILED",
      "CANCELLED",
      "HUMAN_REVIEW",
      "WAITING_APPROVAL",
      "WAITING_USER_AUTH",
      "WAITING_CAPACITY",
    ].includes(run.state)
  )
    break;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
store.close();
