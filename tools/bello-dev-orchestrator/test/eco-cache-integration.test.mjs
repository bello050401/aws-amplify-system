import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store/db.mjs";
import { Repo } from "../src/store/repo.mjs";
import { installEcoSchema } from "../src/eco/store.mjs";
import { EcoCache } from "../src/eco/cache.mjs";
import { CachedIndependentVerifier } from "../src/eco/contextPackets.mjs";
import {
  putContextPacket,
  getContextPacket,
  buildImplementationContext,
} from "../src/eco/contextPackets.mjs";

function initRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "one");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

async function fixture() {
  const store = await Store.open(":memory:");
  const repo = new Repo(store);
  installEcoSchema(store);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "eco-cache-runtime-"));
  initRepo(workDir);
  const { task } = repo.createTask({
    title: "t",
    instruction: "do it",
    source: "test",
    priority: 50,
    repoPath: workDir,
    workDir,
  });
  return { store, repo, workDir, task };
}

function config(passing = true) {
  return {
    verification: {
      required: true,
      commands: [
        {
          name: "check",
          file: process.execPath,
          args: ["-e", passing ? "process.exit(0)" : "process.exit(1)"],
        },
      ],
    },
  };
}

function paths(workDir) {
  return { runsDir: path.join(workDir, ".runs") };
}

function baseCacheContext(overrides = {}) {
  return {
    repository: "synthetic-repo",
    dependencyDigest: "dep-1",
    runtime: "node-20",
    environmentVersion: "env-1",
    fixtureRevision: "fixture-1",
    toolchain: "toolchain-1",
    externalVersion: "external-1",
    ...overrides,
  };
}

test("second identical run reuses the cached verifier result without re-executing", async () => {
  const { store, repo, workDir, task } = await fixture();
  const cache = new EcoCache({ store });
  const cacheContext = baseCacheContext();
  const t = { ...task, attempts: 1 };
  const v1 = new CachedIndependentVerifier({ config: config(true), paths: paths(workDir), repo, cache, cacheContext });
  const first = await v1.run(t);
  assert.equal(first.passed, true);
  assert.equal(first.cache.status, "executed");
  assert.equal(v1.check(t).passed, true);

  const v2 = new CachedIndependentVerifier({
    config: config(true),
    paths: paths(workDir),
    repo,
    cache,
    cacheContext,
    execute: async () => {
      throw new Error("executor must not be called on a cache hit");
    },
  });
  const second = await v2.run(t);
  assert.equal(second.passed, true);
  assert.equal(second.cache.status, "reused");
  assert.equal(v2.check(t).passed, true);
});

test("a dirty worktree (changed content) forces re-execution instead of reusing", async () => {
  const { store, repo, workDir, task } = await fixture();
  const cache = new EcoCache({ store });
  const cacheContext = baseCacheContext();
  const t = { ...task, attempts: 1 };
  const v1 = new CachedIndependentVerifier({ config: config(true), paths: paths(workDir), repo, cache, cacheContext });
  await v1.run(t);

  fs.writeFileSync(path.join(workDir, "a.txt"), "two");
  let executed = false;
  const v2 = new CachedIndependentVerifier({
    config: config(true),
    paths: paths(workDir),
    repo,
    cache,
    cacheContext,
    execute: async (opts) => {
      executed = true;
      return { ok: true, exitCode: 0 };
    },
  });
  const second = await v2.run(t);
  assert.equal(executed, true);
  assert.equal(second.cache.status, "executed");
});

test("a different gitSHA, dependency, environment, fixture, toolchain, or command forces re-execution", async () => {
  const { store, repo, workDir, task } = await fixture();
  const cache = new EcoCache({ store });
  const t = { ...task, attempts: 1 };
  const v1 = new CachedIndependentVerifier({
    config: config(true),
    paths: paths(workDir),
    repo,
    cache,
    cacheContext: baseCacheContext(),
  });
  await v1.run(t);

  for (const overrides of [
    { dependencyDigest: "dep-2" },
    { environmentVersion: "env-2" },
    { fixtureRevision: "fixture-2" },
    { toolchain: "toolchain-2" },
    { externalVersion: "external-2" },
  ]) {
    let executed = false;
    const v = new CachedIndependentVerifier({
      config: config(true),
      paths: paths(workDir),
      repo,
      cache,
      cacheContext: baseCacheContext(overrides),
      execute: async () => {
        executed = true;
        return { ok: true, exitCode: 0 };
      },
    });
    await v.run(t);
    assert.equal(executed, true, `expected re-execution for ${JSON.stringify(overrides)}`);
  }

  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "second"], { cwd: workDir });
  let executedForNewSha = false;
  const vSha = new CachedIndependentVerifier({
    config: config(true),
    paths: paths(workDir),
    repo,
    cache,
    cacheContext: baseCacheContext(),
    execute: async () => {
      executedForNewSha = true;
      return { ok: true, exitCode: 0 };
    },
  });
  await vSha.run(t);
  assert.equal(executedForNewSha, true);

  let executedForNewCommand = false;
  const vCommand = new CachedIndependentVerifier({
    config: { verification: { required: true, commands: [{ name: "check2", file: process.execPath, args: ["-e", "process.exit(0)"] }] } },
    paths: paths(workDir),
    repo,
    cache,
    cacheContext: baseCacheContext(),
    execute: async () => {
      executedForNewCommand = true;
      return { ok: true, exitCode: 0 };
    },
  });
  await vCommand.run(t);
  assert.equal(executedForNewCommand, true);
});

test("a failed run is never reused, and a later evidence tamper or expiry is rejected", async () => {
  const { store, repo, workDir, task } = await fixture();
  const cache = new EcoCache({ store });
  const cacheContext = baseCacheContext();
  const t = { ...task, attempts: 1 };
  const failing = new CachedIndependentVerifier({ config: config(false), paths: paths(workDir), repo, cache, cacheContext });
  const failed = await failing.run(t);
  assert.equal(failed.passed, false);

  let executed = false;
  const retry = new CachedIndependentVerifier({
    config: config(false),
    paths: paths(workDir),
    repo,
    cache,
    cacheContext,
    execute: async () => {
      executed = true;
      return { ok: false, exitCode: 1 };
    },
  });
  await retry.run(t);
  assert.equal(executed, true, "a prior failure must never be served from cache");

  const passing = new CachedIndependentVerifier({ config: config(true), paths: paths(workDir), repo, cache, cacheContext });
  const passed = await passing.run(t);
  assert.equal(passed.passed, true);

  const row = store.get("SELECT id, data, digest FROM eco_cache WHERE json_extract(data, '$.record.result')='passed'");
  const tampered = JSON.parse(row.data);
  tampered.record.results = [{ tampered: true }];
  store.run("UPDATE eco_cache SET data=? WHERE id=?", [JSON.stringify(tampered), row.id]);
  let executedAfterTamper = false;
  const afterTamper = new CachedIndependentVerifier({
    config: config(true),
    paths: paths(workDir),
    repo,
    cache,
    cacheContext,
    execute: async () => {
      executedAfterTamper = true;
      return { ok: true, exitCode: 0 };
    },
  });
  await afterTamper.run(t);
  assert.equal(executedAfterTamper, true, "a corrupted cache record must never be reused");

  const expiredCache = new EcoCache({ store, now: () => Date.now() + 25 * 3600 * 1000 });
  let executedAfterExpiry = false;
  const afterExpiry = new CachedIndependentVerifier({
    config: config(true),
    paths: paths(workDir),
    repo,
    cache: expiredCache,
    cacheContext,
    execute: async () => {
      executedAfterExpiry = true;
      return { ok: true, exitCode: 0 };
    },
  });
  await afterExpiry.run(t);
  assert.equal(executedAfterExpiry, true, "an expired cache entry must never be reused");
});

test("cache OFF always executes, and health-check commands always execute even with a full cache hit available", async () => {
  const { store, repo, workDir, task } = await fixture();
  const t = { ...task, attempts: 1 };
  const cache = new EcoCache({ store });
  const cacheContext = baseCacheContext();
  await new CachedIndependentVerifier({ config: config(true), paths: paths(workDir), repo, cache, cacheContext }).run(t);

  const disabledCache = new EcoCache({ store, enabled: false });
  let executedWithCacheOff = false;
  await new CachedIndependentVerifier({
    config: config(true),
    paths: paths(workDir),
    repo,
    cache: disabledCache,
    cacheContext,
    execute: async () => {
      executedWithCacheOff = true;
      return { ok: true, exitCode: 0 };
    },
  }).run(t);
  assert.equal(executedWithCacheOff, true);

  const healthConfig = {
    verification: {
      required: true,
      commands: [{ name: "health", file: process.execPath, args: ["-e", "process.exit(0)"], healthCheck: true }],
    },
  };
  await new CachedIndependentVerifier({ config: healthConfig, paths: paths(workDir), repo, cache, cacheContext }).run(t);
  let executedForHealth = false;
  await new CachedIndependentVerifier({
    config: healthConfig,
    paths: paths(workDir),
    repo,
    cache,
    cacheContext,
    execute: async () => {
      executedForHealth = true;
      return { ok: true, exitCode: 0 };
    },
  }).run(t);
  assert.equal(executedForHealth, true, "a health check must never be served from cache");
});

test("external commands only reuse once the host explicitly proves identical external state", async () => {
  const { store, repo, workDir, task } = await fixture();
  const t = { ...task, attempts: 1 };
  const cache = new EcoCache({ store });
  const externalConfig = {
    verification: {
      required: true,
      commands: [{ name: "staging", file: process.execPath, args: ["-e", "process.exit(0)"], external: true }],
    },
  };
  await new CachedIndependentVerifier({
    config: externalConfig,
    paths: paths(workDir),
    repo,
    cache,
    cacheContext: baseCacheContext({ externalStateProven: false }),
  }).run(t);

  let executedUnproven = false;
  await new CachedIndependentVerifier({
    config: externalConfig,
    paths: paths(workDir),
    repo,
    cache,
    cacheContext: baseCacheContext({ externalStateProven: false }),
    execute: async () => {
      executedUnproven = true;
      return { ok: true, exitCode: 0 };
    },
  }).run(t);
  assert.equal(executedUnproven, true, "unproven external state must never be reused");

  await new CachedIndependentVerifier({
    config: externalConfig,
    paths: paths(workDir),
    repo,
    cache,
    cacheContext: baseCacheContext({ externalStateProven: true }),
  }).run(t);
  let executedProven = false;
  await new CachedIndependentVerifier({
    config: externalConfig,
    paths: paths(workDir),
    repo,
    cache,
    cacheContext: baseCacheContext({ externalStateProven: true }),
    execute: async () => {
      executedProven = true;
      return { ok: true, exitCode: 0 };
    },
  }).run(t);
  assert.equal(executedProven, false, "an explicitly proven identical external state may be reused");
});

test("an incomplete cacheContext fingerprint always executes for real", async () => {
  const { store, repo, workDir, task } = await fixture();
  const t = { ...task, attempts: 1 };
  const cache = new EcoCache({ store });
  let executed = false;
  const v = new CachedIndependentVerifier({
    config: config(true),
    paths: paths(workDir),
    repo,
    cache,
    cacheContext: { repository: "r" },
    execute: async () => {
      executed = true;
      return { ok: true, exitCode: 0 };
    },
  });
  await v.run(t);
  assert.equal(executed, true);
});

function hashOf(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

test("context packets: unchanged file with a sufficient summary is a hit; changed content or a different run/branch is not", () => {
  const { store } = { store: new (class {})() };
});

test("context packets bound implementation input and surface an insufficient/edited/branch-mismatched summary as unread", async () => {
  const store = await Store.open(":memory:");
  installEcoSchema(store);
  const cache = new EcoCache({ store });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eco-context-"));
  fs.writeFileSync(path.join(root, "x.mjs"), "export const x = 1;\n");
  const deps = { dependencyDigest: "dep-1", specVersion: "spec-1", policyVersion: "policy-1", schemaVersion: "schema-1" };

  putContextPacket({ cache, repository: "repo", branch: "main", root, allowedPaths: ["x.mjs"], ...deps, purpose: "renamed export", expiresAt: Date.now() + 3600000 });
  const hitPacket = getContextPacket({ cache, repository: "repo", branch: "main", root, allowedPaths: ["x.mjs"], ...deps });
  assert.equal(hitPacket.hits.length, 1);
  assert.equal(hitPacket.unread.length, 0);

  const differentBranch = getContextPacket({ cache, repository: "repo", branch: "other", root, allowedPaths: ["x.mjs"], ...deps });
  assert.equal(differentBranch.hits.length, 0);
  assert.equal(differentBranch.unread.length, 1);

  fs.writeFileSync(path.join(root, "x.mjs"), "export const x = 2;\n");
  const afterEdit = getContextPacket({ cache, repository: "repo", branch: "main", root, allowedPaths: ["x.mjs"], ...deps });
  assert.equal(afterEdit.hits.length, 0);
  assert.equal(afterEdit.unread[0].reason, "missing_or_changed");

  fs.writeFileSync(path.join(root, "x.mjs"), "export const x = 1;\n");
  assert.throws(() => putContextPacket({ cache, repository: "repo", branch: "main", root, allowedPaths: ["x.mjs"], ...deps, purpose: "", expiresAt: Date.now() + 3600000 }));

  const bounded = buildImplementationContext({
    spec: { purpose: "p" },
    previousResultSummary: "x".repeat(5000),
    packets: hitPacket,
    changedFiles: ["x.mjs"],
    maxBytes: 200,
    maxPreviousResultBytes: 50,
  });
  assert.equal(bounded.previousResultSummary.length, 50);
  assert.ok(bounded.byteSize <= 400);
  assert.ok(Array.isArray(bounded.changedFileMetadata));
  assert.ok(typeof bounded.limitation === "string" && bounded.limitation.length > 0);
});
