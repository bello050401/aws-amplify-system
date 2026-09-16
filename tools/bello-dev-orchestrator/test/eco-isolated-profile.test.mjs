import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateRuntimeConfig, RUNTIME_SCHEMA_VERSION } from "../src/eco/serviceBindings.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLAYWRIGHT_STUB = fileURLToPath(import.meta.url); // any existing absolute file is enough for the modulePath check

function makeGitRoot(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eco-isolated-profile-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function baseEntry(repoPath) {
  return {
    repoPath,
    allowedPaths: ["index.html"],
    qaUrl: "https://dedicated-app.amplifyapp.com/",
    allowedDomains: ["dedicated-app.amplifyapp.com"],
    models: { codex: { model: "gpt-test" } },
    playwright: { modulePath: PLAYWRIGHT_STUB, headless: true },
    qaSteps: {
      sequence: [{ type: "navigate" }, { type: "reload" }, { type: "screenshot" }],
      maxTotalSeconds: 30,
    },
  };
}

function isolatedEntry(repoPath, overrides = {}) {
  return {
    ...baseEntry(repoPath),
    configurationScope: "isolated-profile",
    verification: { required: true, commands: [{ name: "smoke", file: "true", args: [] }] },
    staging: {
      mode: "static-smoke",
      enabled: true,
      isolatedDataConfirmed: true,
      accountId: "123456789012",
      appId: "dabcdefghij",
      branch: "preview-orchestrator",
      appName: "bello-orchestrator-smoke",
      region: "ap-northeast-1",
      profile: "bello-smoke",
    },
    ...overrides,
  };
}

function runtime(entry) {
  return { schemaVersion: RUNTIME_SCHEMA_VERSION, profiles: { "static-smoke": entry } };
}

function hostConfig(repoPath) {
  return {
    repoPath,
    claude: { model: "claude-host-model" },
    verification: { required: true, commands: [{ name: "host", file: "true", args: [] }] },
    staging: { mode: "production" },
  };
}

test("strict-match (default) still requires exact repoPath/verification/staging/model match", () => {
  const mainRepo = makeGitRoot({ "index.html": "<html><body>BELLO</body></html>" });
  const config = {
    repoPath: mainRepo,
    claude: { model: "claude-host-model" },
    verification: { required: true, commands: [{ name: "smoke", file: "true", args: [] }] },
    staging: {
      mode: "static-smoke",
      enabled: true,
      isolatedDataConfirmed: true,
      accountId: "123456789012",
      appId: "dabcdefghij",
      branch: "preview-orchestrator",
      appName: "bello-orchestrator-smoke",
      region: "ap-northeast-1",
      profile: "bello-smoke",
    },
  };
  const strictEntry = {
    ...baseEntry(mainRepo),
    verification: config.verification,
    staging: config.staging,
    models: { claude: { model: config.claude.model }, codex: { model: "gpt-test" } },
  };
  const profile = validateRuntimeConfig(runtime(strictEntry), config);
  assert.equal(profile.configurationScope, "strict-match");

  const dedicated = makeGitRoot({ "index.html": "<html><body>BELLO</body></html>" });
  assert.throws(
    () => validateRuntimeConfig(runtime({ ...strictEntry, repoPath: dedicated }), config),
    /repoPath must match/,
  );
  assert.throws(
    () => validateRuntimeConfig(runtime({ ...strictEntry, verification: { required: false, commands: [] } }), config),
    /verification must match/,
  );
});

test("isolated-profile accepts a dedicated static-only repo distinct from the running config repoPath", () => {
  const mainRepo = makeGitRoot({});
  const dedicated = makeGitRoot({ "index.html": "<html><body>BELLO</body></html>" });
  const config = hostConfig(mainRepo);
  const profile = validateRuntimeConfig(runtime(isolatedEntry(dedicated)), config);
  assert.equal(profile.configurationScope, "isolated-profile");
  assert.equal(profile.repoPath, dedicated);
  assert.equal(profile.verification.required, true);
  assert.equal(profile.staging.mode, "static-smoke");
});

test("isolated-profile rejects the main repoPath", () => {
  const mainRepo = makeGitRoot({});
  const config = hostConfig(mainRepo);
  assert.throws(
    () => validateRuntimeConfig(runtime(isolatedEntry(mainRepo)), config),
    /independent of the running configuration repoPath/,
  );
});

test("isolated-profile rejects a repoPath that is not a git repository root", () => {
  const mainRepo = makeGitRoot({});
  const config = hostConfig(mainRepo);
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "eco-isolated-nongit-"));
  assert.throws(
    () => validateRuntimeConfig(runtime(isolatedEntry(nonGit)), config),
    /git repository root/,
  );
});

test("isolated-profile rejects insufficient verification (missing/empty required commands)", () => {
  const mainRepo = makeGitRoot({});
  const dedicated = makeGitRoot({ "index.html": "<html><body>BELLO</body></html>" });
  const config = hostConfig(mainRepo);
  assert.throws(
    () => validateRuntimeConfig(runtime(isolatedEntry(dedicated, { verification: { required: true, commands: [] } })), config),
    /own required independent verification/,
  );
  assert.throws(
    () => validateRuntimeConfig(runtime(isolatedEntry(dedicated, { verification: { required: false, commands: [] } })), config),
    /own required independent verification/,
  );
});

test("isolated-profile rejects a production-shaped or incomplete staging target", () => {
  const mainRepo = makeGitRoot({});
  const dedicated = makeGitRoot({ "index.html": "<html><body>BELLO</body></html>" });
  const config = hostConfig(mainRepo);
  assert.throws(
    () => validateRuntimeConfig(runtime(isolatedEntry(dedicated, { staging: { mode: "production" } })), config),
    /dedicated static-smoke deployment/,
  );
  assert.throws(
    () =>
      validateRuntimeConfig(
        runtime(isolatedEntry(dedicated, { staging: { ...isolatedEntry(dedicated).staging, isolatedDataConfirmed: false } })),
        config,
      ),
    /dedicated static-smoke deployment/,
  );
});

test("isolated-profile allows an explicit claude model override but keeps host executables implicit", () => {
  const mainRepo = makeGitRoot({});
  const dedicated = makeGitRoot({ "index.html": "<html><body>BELLO</body></html>" });
  const config = hostConfig(mainRepo);
  const profile = validateRuntimeConfig(
    runtime(isolatedEntry(dedicated, { models: { claude: { model: "claude-override" }, codex: { model: "gpt-test" } } })),
    config,
  );
  assert.equal(profile.models.claude.model, "claude-override");

  const withoutOverride = validateRuntimeConfig(runtime(isolatedEntry(dedicated)), config);
  assert.equal(withoutOverride.models.claude, undefined);
});

test("unknown or unregistered profile ids are still rejected regardless of configurationScope", () => {
  const mainRepo = makeGitRoot({});
  const dedicated = makeGitRoot({ "index.html": "<html><body>BELLO</body></html>" });
  const config = hostConfig(mainRepo);
  const raw = { schemaVersion: RUNTIME_SCHEMA_VERSION, profiles: { "unknown-profile": isolatedEntry(dedicated) } };
  assert.throws(() => validateRuntimeConfig(raw, config), /Only the static-smoke profile/);
});

test("invalid configurationScope value is rejected", () => {
  const mainRepo = makeGitRoot({});
  const dedicated = makeGitRoot({ "index.html": "<html><body>BELLO</body></html>" });
  const config = hostConfig(mainRepo);
  assert.throws(
    () => validateRuntimeConfig(runtime(isolatedEntry(dedicated, { configurationScope: "anything-else" })), config),
    /configurationScope must be/,
  );
});
