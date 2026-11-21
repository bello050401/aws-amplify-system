import fs from "node:fs";
import path from "node:path";
import { runGit, taskChangedFilesInWorktree } from "../core/git.mjs";
import { branchNameFor, worktreePathFor, createTaskWorktree } from "../core/worktree.mjs";
import { resolveClaudeExecutable } from "../runner/claudeRunner.mjs";
import { CodexRunner, probeCodexLogin, resolveCodexExecutable } from "../runner/codexRunner.mjs";
import { DEFAULT_CODEX_EFFORT, validReasoningEffort } from "../runner/codexOptions.mjs";
import { ClaudeRunner } from "../runner/claudeRunner.mjs";
import { IndependentVerifier } from "../pipeline/verification.mjs";
import { AmplifyStaticDelivery, LocalEvidenceDelivery, digest } from "../pipeline/staticStaging.mjs";
import { NextStagingDelivery, validateNextSettings } from "../pipeline/nextStaging.mjs";
import { LocalNextDelivery, validateLocalNextSettings, assertIsolationProof, assertLocalNextSource, isLoopback } from "../pipeline/localNextStaging.mjs";
import { runProcess, localEnvironment } from "../pipeline/process.mjs";
import { DEFAULT_CODEX_MODEL_POLICY, hash } from "./policy.mjs";
import { modelKey } from "./taskRouting.mjs";
import { existingAdapters } from "./existingAdapters.mjs";
import { subscriptionTextWorker } from "./subscriptionTextWorker.mjs";
import { createBrowserQaWorker, probeBrowserLaunch, ALLOWED_ACTIONS } from "./browserWorker.mjs";

/**
 * 常駐サービス結線。
 *
 * paths.dataRoot/eco-runtime.json を読み、host が明示した唯一の対応profile
 * のscopeと配布modeを照合し、各mode専用のadapterを組み立てる。
 * 欠落・不一致・未対応profileは、理由付きの「未接続」を正直に返す。
 * capabilities() は常に、直近の実probe結果 (paths.stateDir/eco-probes.json、
 * refreshProbes() が書く) を照合して答える。probeを装って接続済みと詐称しない。
 */

export const RUNTIME_SCHEMA_VERSION = 1;
export const SUPPORTED_PROFILE_ID = "static-smoke";

// Approved target-app identities. Each connected profile must declare exactly
// one of these (or remain the generic "static-smoke" infra self-check, which
// is reserved and never accepted as evidence for any of them). "local"
// evidenceMode apps are judged by real local build/test/UI evidence only;
// "staging" evidenceMode apps are judged only against their own real staging.
export const APPROVED_TARGET_APPS = Object.freeze({
  photo_station: { evidenceMode: "local", label: "Photo Station (WPF/Node)" },
  store_simulator: { evidenceMode: "local", label: "BELLO Store Simulator" },
  inventory_web: { evidenceMode: "staging", label: "在庫管理Web" },
  ec: { evidenceMode: "staging", label: "EC" },
  zaico: { evidenceMode: "staging", label: "ZAICO" },
});
const PROFILE_IDS = [SUPPORTED_PROFILE_ID, ...Object.keys(APPROVED_TARGET_APPS)];
const PROBE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// The dedicated static profile must never inherit broad tools from the business runner.
export function scopedClaudeConfig(config, model, allowedPaths) {
  if (!allowedPaths.length || allowedPaths.some(p => typeof p !== 'string' || !p || path.isAbsolute(p) || p.includes('\0') || /[*?{}|<>"\r\n]/.test(p) || p.split(/[\\/]/).includes('..')))
    throw Error('Invalid scoped Claude path');
  return { ...config, claude: { ...config.claude, model,
    permissionMode: 'dontAsk',
    allowedTools: allowedPaths.flatMap(p => ['Read', 'Edit', 'Write'].map(t => `${t}(./${p})`)),
    disallowedTools: ['Bash', 'WebFetch', 'WebSearch', 'Agent'],
    extraArgs: ['--tools', 'Read,Edit,Write', '--safe-mode', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--effort', 'medium'],
  }};
}

function readArtifact(repo, id) {
  if (!id) return null;
  const row = repo.store.get("SELECT data FROM eco_artifacts WHERE id=?", [id]);
  return row ? JSON.parse(row.data) : null;
}

function validateStepShape(step) {
  if (!step || !ALLOWED_ACTIONS.includes(step.type)) return false;
  if (step.type === "navigate") return step.target === undefined || typeof step.target === "string";
  if (step.type === "screenshot") return step.label === undefined || typeof step.label === "string";
  if (step.type === "click") return typeof step.selector === "string" && step.selector.length > 0;
  if (step.type === "fill") return typeof step.selector === "string" && typeof step.value === "string";
  if (step.type === "keyboard") return typeof step.key === "string" && step.key.length > 0;
  return true;
}

const CONFIGURATION_SCOPES = ["strict-match", "isolated-profile", "bounded-main"];

function validateProfileModels(entry) {
  if (entry.implementationProvider !== undefined && !["claude", "codex"].includes(entry.implementationProvider))
    throw Error("Profile implementationProvider must be codex or claude");
  const codex = entry.models?.codex;
  const validModel = (model) => typeof model?.model === "string" && !!model.model.trim() &&
    (model.reasoningEffort === undefined || validReasoningEffort(model.reasoningEffort, model.model));
  if (!validModel(codex)) throw Error("Profile models.codex requires a model and valid reasoning effort");
  for (const phase of ["specification", "browserQa"]) {
    if (codex[phase] !== undefined && !validModel(codex[phase]))
      throw Error("Profile models.codex." + phase + " requires a model and valid reasoning effort");
  }
  if (codex.implementation !== undefined) {
    if (entry.implementationProvider !== "codex" || Object.keys(codex.implementation ?? {}).length !== 3 ||
        !Object.keys(DEFAULT_CODEX_MODEL_POLICY).every(tier => validModel(codex.implementation?.[tier])))
      throw Error("Profile models.codex.implementation must map economy, standard and advanced to Codex models with valid effort");
  }
  if (entry.models?.claude?.model !== undefined && typeof entry.models.claude.model !== "string")
    throw Error("Profile models.claude.model must be a string when overriding the host model");
}

/** eco-runtime.json を検証する。ここを通った profile だけが実接続に使われる。
 *
 * configurationScope が未指定/"strict-match" のときは従来どおり repoPath/
 * verification/staging/models.claude.model が実行中 config と完全一致していないと
 * 拒否する。明示的に "isolated-profile" を指定したときだけ、host本体の config を
 * 一切変えずに、専用static-only repoへの独立検証接続を許可する。この場合でも
 * 独立検証(必須)・専用staging・許可モデル/実行pathのhost基準は緩めない。 */
/** Validates a Photo Station / Store Simulator / 在庫Web / EC / ZAICO target-app
 * profile. These always run as their own bounded-main-style contract: a
 * host-approved edit scope, host-approved independent verification, and (per
 * AC-2/AC-3) an evidence path that matches the app's own evidenceMode
 * exclusively. A "local" evidenceMode profile (Photo Station, Store
 * Simulator) can never carry a browser QA target, and a "staging"
 * evidenceMode profile can never fall back to local evidence or to the
 * generic static-smoke identity. */
function validateTargetAppProfile(profileId, entry, config) {
  const spec = APPROVED_TARGET_APPS[profileId];
  if (entry.targetApp !== profileId)
    throw Error("Profile targetApp must match its own approved profile id exactly");
  if (typeof entry.repoPath !== "string" || !path.isAbsolute(entry.repoPath))
    throw Error("Profile repoPath must be an absolute path");
  if (path.resolve(entry.repoPath) !== path.resolve(config.repoPath))
    throw Error("Target-app profile repoPath must match the running configuration exactly");
  if (
    !Array.isArray(entry.allowedPaths) ||
    !entry.allowedPaths.length ||
    entry.allowedPaths.some((p) => typeof p !== "string" || !p || path.isAbsolute(p) || p.split(/[\\/]/).includes(".."))
  )
    throw Error("Profile allowedPaths must be an explicit list of relative paths");
  if (
    !entry.verification ||
    entry.verification.required !== true ||
    !Array.isArray(entry.verification.commands) ||
    !entry.verification.commands.length
  )
    throw Error("A target-app profile must declare its own required independent verification commands");
  if (spec.evidenceMode === "local") {
    if (entry.qaUrl !== undefined || entry.playwright !== undefined || entry.qaSteps !== undefined || entry.allowedDomains !== undefined)
      throw Error(spec.label + " profile must not declare a browser QA target; evidence is local build/test/UI only");
    if (entry.staging?.mode !== "local-build-evidence" || entry.staging.enabled !== true || entry.staging.isolatedDataConfirmed !== true)
      throw Error(spec.label + ' profile staging.mode must be "local-build-evidence", enabled and isolatedDataConfirmed');
    const le = entry.staging.uiEvidencePath;
    if (typeof le !== "string" || !le.trim() || path.isAbsolute(le) || le.split(/[\\/]/).includes(".."))
      throw Error(spec.label + " profile requires a relative staging.uiEvidencePath for the committed UI evidence file");
    return { id: profileId, ...entry, configurationScope: "bounded-main", targetApp: profileId, evidenceMode: "local" };
  }

  // "staging" evidenceMode: 在庫Web / EC / ZAICO must each confirm only their own real staging.
  if (typeof entry.qaUrl !== "string" || !entry.qaUrl) throw Error("Profile qaUrl is required");
  let qaUrl;
  try {
    qaUrl = new URL(entry.qaUrl);
  } catch {
    throw Error("Profile qaUrl must be a valid URL");
  }
  const localNext = entry.staging?.mode === "local-next-isolated";
  if ((localNext ? qaUrl.protocol !== "http:" || !isLoopback(qaUrl.hostname) : qaUrl.protocol !== "https:") || qaUrl.search || qaUrl.hash || qaUrl.username || qaUrl.password)
    throw Error("Profile qaUrl must be a bare HTTPS URL without credentials or query");
  if (!Array.isArray(entry.allowedDomains) || !entry.allowedDomains.length || !entry.allowedDomains.includes(qaUrl.hostname))
    throw Error("Profile allowedDomains must include the qaUrl host");
  const st = entry.staging;
  if (localNext) {
    validateLocalNextSettings(st);
    if (st.qaUrl !== entry.qaUrl || st.service !== profileId) throw Error('Local Next.js URL/service does not match its profile');
  } else {
  if (
    !st ||
    st.mode !== "real-staging" ||
    st.enabled !== true ||
    st.isolatedDataConfirmed !== true ||
    st.service !== profileId ||
    typeof st.environment !== "string" || !st.environment.trim() ||
    typeof st.stagingId !== "string" || !st.stagingId.trim() ||
    typeof st.accountId !== "string" || !/^\d{12}$/.test(st.accountId) ||
    typeof st.appId !== "string" || !/^d[a-z0-9]+$/.test(st.appId) ||
    typeof st.branch !== "string" || !st.branch ||
    typeof st.appName !== "string" || !st.appName ||
    typeof st.region !== "string" || !st.region ||
    typeof st.profile !== "string" || !st.profile
  )
    throw Error(profileId + " profile requires a fully specified real staging target (service, environment, stagingId, isolatedDataConfirmed and its own AWS identity)");
  validateNextSettings(st);
  if (st.qaUrl !== entry.qaUrl) throw Error('Next.js QA URL does not match the approved target');
  }
  if (entry.allowedDomains.length !== 1 || entry.allowedDomains[0] !== qaUrl.hostname) throw Error('Next.js QA must use only its approved origin');
  if (
    !entry.playwright ||
    typeof entry.playwright.modulePath !== "string" ||
    !path.isAbsolute(entry.playwright.modulePath) ||
    !fs.existsSync(entry.playwright.modulePath)
  )
    throw Error("Profile playwright.modulePath must be an existing absolute path");
  const sequence = entry.qaSteps?.sequence;
  if (!Array.isArray(sequence) || !sequence.length || sequence.length > 12)
    throw Error("Profile qaSteps.sequence must have 1-12 steps");
  if (sequence[0]?.type !== "navigate" || !sequence.some((s) => s.type === "reload") || sequence.at(-1)?.type !== "screenshot")
    throw Error("Profile qaSteps.sequence must navigate first, include a reload, and end with a screenshot");
  if (sequence.some((s) => !validateStepShape(s)))
    throw Error("Profile qaSteps.sequence contains an unsupported or malformed step");
  if (!Number.isFinite(entry.qaSteps.maxTotalSeconds) || entry.qaSteps.maxTotalSeconds <= 0 || entry.qaSteps.maxTotalSeconds > 120)
    throw Error("Profile qaSteps.maxTotalSeconds must be within the bounded QA time budget (<=120s)");
  return { id: profileId, ...entry, configurationScope: "bounded-main", targetApp: profileId, evidenceMode: "staging" };
}

export function validateRuntimeConfig(raw, config) {
  if (!raw || raw.schemaVersion !== RUNTIME_SCHEMA_VERSION || typeof raw.profiles !== "object" || !raw.profiles)
    throw Error("eco-runtime.json is missing or has an unsupported schemaVersion");
  const ids = Object.keys(raw.profiles);
  if (ids.length !== 1)
    throw Error("Exactly one approved target-app profile must be configured at a time");
  const [profileId] = ids;
  if (!PROFILE_IDS.includes(profileId))
    throw Error("Unknown or unapproved profile id. Only the static-smoke profile or an approved target-app profile id is accepted, got: " + profileId);
  const entry = raw.profiles[profileId];
  if (!entry) throw Error("No profile is configured for " + profileId);
  validateProfileModels(entry);
  if (profileId !== SUPPORTED_PROFILE_ID) return validateTargetAppProfile(profileId, entry, config);
  const configurationScope = entry.configurationScope ?? "strict-match";
  if (!CONFIGURATION_SCOPES.includes(configurationScope))
    throw Error('Profile configurationScope must be "strict-match", "isolated-profile" or "bounded-main"');
  const isolatedProfile = configurationScope === "isolated-profile";
  const boundedMain = configurationScope === "bounded-main";
  if (typeof entry.repoPath !== "string" || !path.isAbsolute(entry.repoPath))
    throw Error("Profile repoPath must be an absolute path");
  if (!isolatedProfile) {
    if (path.resolve(entry.repoPath) !== path.resolve(config.repoPath))
      throw Error("Profile repoPath must match the running configuration exactly");
  } else {
    if (path.resolve(entry.repoPath) === path.resolve(config.repoPath))
      throw Error("An isolated-profile repoPath must be independent of the running configuration repoPath");
    if (!fs.existsSync(entry.repoPath) || !fs.statSync(entry.repoPath).isDirectory())
      throw Error("Profile repoPath must be an existing directory");
    if (!fs.existsSync(path.join(entry.repoPath, ".git")))
      throw Error("Profile repoPath must be a git repository root");
  }
  if (
    !Array.isArray(entry.allowedPaths) ||
    !entry.allowedPaths.length ||
    entry.allowedPaths.some((p) => typeof p !== "string" || !p || path.isAbsolute(p) || p.split(/[\\/]/).includes(".."))
  )
    throw Error("Profile allowedPaths must be an explicit list of relative paths");
  if (typeof entry.qaUrl !== "string" || !entry.qaUrl) throw Error("Profile qaUrl is required");
  let qaUrl;
  try {
    qaUrl = new URL(entry.qaUrl);
  } catch {
    throw Error("Profile qaUrl must be a valid URL");
  }
  if (qaUrl.protocol !== "https:" || qaUrl.search || qaUrl.hash || qaUrl.username || qaUrl.password)
    throw Error("Profile qaUrl must be a bare HTTPS URL without credentials or query");
  if (!Array.isArray(entry.allowedDomains) || !entry.allowedDomains.length || !entry.allowedDomains.includes(qaUrl.hostname))
    throw Error("Profile allowedDomains must include the qaUrl host");
  if (!isolatedProfile && !boundedMain) {
    if (hash(entry.verification ?? null) !== hash(config.verification ?? null))
      throw Error("Profile verification must match the running configuration exactly");
  } else if (
    !entry.verification ||
    entry.verification.required !== true ||
    !Array.isArray(entry.verification.commands) ||
    !entry.verification.commands.length
  ) {
    throw Error("A bounded profile must declare its own required independent verification commands");
  }
  if (!isolatedProfile && !boundedMain) {
    if (
      config.staging?.mode !== "static-smoke" ||
      !entry.staging ||
      entry.staging.mode !== "static-smoke" ||
      hash(entry.staging) !== hash(config.staging)
    )
      throw Error("Profile staging must match a static-smoke running configuration exactly");
  } else {
    const st = entry.staging;
    if (
      !st ||
      st.mode !== "static-smoke" ||
      st.enabled !== true ||
      st.isolatedDataConfirmed !== true ||
      typeof st.accountId !== "string" ||
      !/^\d{12}$/.test(st.accountId) ||
      typeof st.appId !== "string" ||
      !/^d[a-z0-9]+$/.test(st.appId) ||
      typeof st.branch !== "string" ||
      !st.branch ||
      typeof st.appName !== "string" ||
      !st.appName ||
      typeof st.region !== "string" ||
      !st.region ||
      typeof st.profile !== "string" ||
      !st.profile
    )
      throw Error("A bounded profile staging target must be a fully specified dedicated static-smoke deployment");
    if (boundedMain && (st.sourceMode !== "bounded-main" || typeof st.artifactPath !== "string" || !entry.allowedPaths.includes(st.artifactPath)))
      throw Error("A bounded-main profile must deploy an explicitly allowed static artifact");
  }
  if (!isolatedProfile && !boundedMain && entry.implementationProvider !== "codex") {
    if (!entry.models?.claude?.model || entry.models.claude.model !== config.claude?.model)
      throw Error("Profile models.claude.model must match the running configuration");
  }
  if (
    !entry.playwright ||
    typeof entry.playwright.modulePath !== "string" ||
    !path.isAbsolute(entry.playwright.modulePath) ||
    !fs.existsSync(entry.playwright.modulePath)
  )
    throw Error("Profile playwright.modulePath must be an existing absolute path");
  const sequence = entry.qaSteps?.sequence;
  if (!Array.isArray(sequence) || !sequence.length || sequence.length > 12)
    throw Error("Profile qaSteps.sequence must have 1-12 steps");
  if (sequence[0]?.type !== "navigate" || !sequence.some((s) => s.type === "reload") || sequence.at(-1)?.type !== "screenshot")
    throw Error("Profile qaSteps.sequence must navigate first, include a reload, and end with a screenshot");
  if (sequence.some((s) => !validateStepShape(s)))
    throw Error("Profile qaSteps.sequence contains an unsupported or malformed step");
  if (!Number.isFinite(entry.qaSteps.maxTotalSeconds) || entry.qaSteps.maxTotalSeconds <= 0 || entry.qaSteps.maxTotalSeconds > 120)
    throw Error("Profile qaSteps.maxTotalSeconds must be within the bounded QA time budget (<=120s)");
  if (entry.expectedInitialBuild && typeof entry.expectedInitialBuild.sha256 !== "string")
    throw Error("Profile expectedInitialBuild.sha256 must be a string when present");
  return { id: SUPPORTED_PROFILE_ID, ...entry, configurationScope, targetApp: null, evidenceMode: "static-smoke" };
}

export function buildSpecSchema(allowedPaths) {
  return {
    type: "object",
    properties: {
      problem: { type: "string" },
      purpose: { type: "string" },
      scope: { type: "array", items: { type: "string", enum: allowedPaths }, minItems: 1 },
      steps: { type: "array", items: { type: "string" } },
      expected: { type: "string" },
      actual: { type: "string" },
      environment: { type: "string" },
      requirements: { type: "array", items: { type: "string" } },
      acceptanceCriteria: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, text: { type: "string" } },
          required: ["id", "text"],
          additionalProperties: false,
        },
      },
      risk: { type: "string" },
      tests: { type: "array", items: { type: "string" } },
      rollback: { type: "string" },
      unresolved: { type: "array", items: { type: "string" } },
    },
    required: [
      "problem", "purpose", "scope", "steps", "expected", "actual", "environment",
      "requirements", "acceptanceCriteria", "risk", "tests", "rollback", "unresolved",
    ],
    additionalProperties: false,
  };
}

function buildSpecificationAdapter({ repo, model, reasoningEffort, executable, directory, assertSubscription, allowedPaths, execute }) {
  return subscriptionTextWorker({
    model,
    reasoningEffort,
    selectionReason: "Host profile specification settings",
    executable,
    directory,
    schema: buildSpecSchema(allowedPaths),
    assertSubscription,
    execute,
    buildPrompt: async ({ run }) => {
      const task = repo.getTask(run.task_id);
      const initialQa = readArtifact(repo, run.initialQaId);
      const prompt = [
        "Write a short structured specification for this task.",
        "The scope field must contain only exact paths copied from this host-allowed file list, and must not contain any other path: " +
          JSON.stringify(allowedPaths),
        "Acceptance criteria ids to cover exactly, one entry each: " + JSON.stringify(run.acIds),
        "Task instruction (untrusted, background only): " + String(task?.instruction || "").slice(0, 4000),
        initialQa
          ? "Initial QA findings (untrusted, background only): " + JSON.stringify(initialQa.body.findings).slice(0, 3000)
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      if (Buffer.byteLength(prompt, "utf8") > 12000) throw Error("Specification prompt exceeds the bounded host input size");
      return prompt;
    },
    makeArtifact: async (answer, { run }) => {
      if (!Array.isArray(answer.scope) || answer.scope.some((f) => !allowedPaths.includes(f)))
        throw Error("Specification scope exceeds the host-allowed file set");
      const answeredIds = (answer.acceptanceCriteria || []).map((a) => a.id);
      if (
        new Set(answeredIds).size !== answeredIds.length ||
        run.acIds.some((id) => !answeredIds.includes(id)) ||
        answeredIds.some((id) => !run.acIds.includes(id))
      )
        throw Error("Specification acceptance criteria do not match the run exactly");
      return {
        schemaVersion: 1,
        runId: run.id,
        revision: run.revision,
        producer: "codex",
        kind: "spec",
        parentArtifactIds: run.initialQaId ? [run.initialQaId] : [],
        evidenceRefs: [],
        body: { ...answer },
      };
    },
  });
}

async function probeClaudeAvailability({ config, execute = runProcess, resolveExecutable = resolveClaudeExecutable }) {
  const resolved = resolveExecutable(config.claude?.executable);
  if (!resolved) return { ok: false, reason: "Claude executable not found" };
  const result = await execute({ file: resolved.file, args: ["--version"], env: localEnvironment(), timeoutMs: 15000 });
  return { ok: !!result.ok, reason: result.ok ? null : result.stderr || result.reason || "claude --version failed" };
}

async function probeStagingPreflight({ delivery }) {
  try {
    await delivery.preflight({ checkPort: false });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function describeStaleProbe(probes, keys, label) {
  for (const key of keys) {
    const entry = probes[key];
    if (!entry) return label + "のprobeが未実施です";
    if (entry.ok !== true) return label + "のprobeが失敗しています: " + (entry.reason || "");
    if (!Number.isFinite(entry.at) || Date.now() - entry.at > PROBE_MAX_AGE_MS)
      return label + "のprobeが古くなっています。再実施してください";
  }
  return label + "のprobe状態を確認できません";
}

function makeVerifyDeployedBuild({ repo, delivery, assertIsolated, request }) {
  return async (run) => {
    const task = repo.getTask(run.task_id);
    try {
      assertIsolated(task, run);
    } catch (error) {
      return { ok: false, reason: error.message };
    }
    const row = delivery.row(task.id);
    if (row?.state !== "succeeded" || row.commit_id !== run.headSHA || row.job_id !== run.deployment?.deploymentId)
      return { ok: false, reason: "Staging delivery does not match the run revision" };
    if (delivery.revisionContract) return delivery.verifyDeployed(task);
    let expected;
    try {
      expected = delivery.artifact(task).sha256;
    } catch (error) {
      return { ok: false, reason: error.message };
    }
    try {
      const response = await request(run.configSnapshot.qaUrl + "?eco=" + expected, {
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) return { ok: false, reason: "Published build is not reachable" };
      const bytes = Buffer.from(await response.arrayBuffer());
      if (digest(bytes) !== expected) return { ok: false, reason: "Published bytes do not match the verified build" };
      return { ok: true, sha256: expected };
    } catch (error) {
      return { ok: false, reason: "Published build check failed: " + error.message };
    }
  };
}

function makeVerifyInitialBuild({ profile, request }) {
  return async () => {
    if (!profile.expectedInitialBuild?.sha256)
      return { ok: false, reason: "Host has not recorded an expected initial build for baseline QA" };
    try {
      const response = await request(profile.qaUrl, { redirect: "error", signal: AbortSignal.timeout(15000) });
      if (!response.ok) return { ok: false, reason: "Baseline build is not reachable" };
      const bytes = Buffer.from(await response.arrayBuffer());
      const sha256 = digest(bytes);
      if (sha256 !== profile.expectedInitialBuild.sha256)
        return { ok: false, reason: "Baseline build does not match the host-recorded initial build" };
      return { ok: true, sha256 };
    } catch (error) {
      return { ok: false, reason: "Baseline build check failed: " + error.message };
    }
  };
}

/** {capabilities,adapters,evidenceRoot,safetyGate,prepareTask} for createEcoRuntime().
 * execute/launchBrowser/buildDelivery/request are injection seams for tests only;
 * production callers should leave them at their real defaults. */
export function createStagingDelivery(options) {
  const mode = options.config.staging?.mode;
  if (mode === 'local-build-evidence') return new LocalEvidenceDelivery(options);
  if (mode === 'static-smoke') return new AmplifyStaticDelivery(options);
  if (mode === 'real-staging') return new NextStagingDelivery(options);
  if (mode === 'local-next-isolated') return new LocalNextDelivery(options);
  throw Error('Unknown staging mode; no static or production fallback is permitted');
}

export function createServiceBindings({
  config,
  paths,
  repo,
  logger,
  execute = runProcess,
  launchBrowser = null,
  buildDelivery = createStagingDelivery,
  request = fetch,
  resolveClaude = resolveClaudeExecutable,
  resolveCodex = resolveCodexExecutable,
}) {
  const runtimeFile = path.join(paths.dataRoot, "eco-runtime.json");
  const probesFile = path.join(paths.stateDir, "eco-probes.json");
  let profile = null;
  let loadError = null;
  try {
    const raw = JSON.parse(fs.readFileSync(runtimeFile, "utf8"));
    profile = validateRuntimeConfig(raw, config);
  } catch (error) {
    loadError = error.message;
  }

  const evidenceRoot = (id) => path.join(paths.evidenceDir, id);

  if (!profile) {
    const reason = loadError || "eco-runtime.json が未接続です";
    return {
      capabilities: () => ({
        browserQa: { connected: false, reason },
        codex: { connected: false, reason },
        claude: { connected: false, reason },
        staging: { connected: false, reason },
      }),
      adapters: {},
      evidenceRoot,
      safetyGate: async () => ({ allowed: false, reason }),
      prepareTask: () => {
        throw Error(reason);
      },
    };
  }

  // Bounded profiles may use their own verification/staging/model contract
  // (verification/staging/claude model), and only for the pieces below; the
  // main config object itself is never mutated, and executables/paths stay host-fixed.
  const isolatedProfile = profile.configurationScope === "isolated-profile";
  const boundedMain = profile.configurationScope === "bounded-main";
  const implementationProvider = profile.implementationProvider ?? "claude";
  const codexProfile = profile.models.codex;
  const phaseOptions = (phase) => ({
    model: codexProfile[phase]?.model ?? codexProfile.model,
    reasoningEffort: codexProfile[phase]?.reasoningEffort ?? codexProfile.reasoningEffort ??
      (implementationProvider === "codex" ? DEFAULT_CODEX_EFFORT : undefined),
  });
  const implementationOptions = Object.entries(DEFAULT_CODEX_MODEL_POLICY).map(([tier, defaults]) => ({
    ...defaults,
    ...codexProfile.implementation?.[tier],
  }));
  const codexModels = new Set(implementationOptions.map(modelKey));
  const modelPolicy = Object.fromEntries(Object.keys(DEFAULT_CODEX_MODEL_POLICY).map((tier, i) => [tier, implementationOptions[i]]));
  const claudeModel = ((isolatedProfile || boundedMain) && profile.models?.claude?.model) || config.claude?.model;
  const effectiveConfig = isolatedProfile || boundedMain
    ? { ...config, verification: profile.verification, staging: profile.staging, claude: { ...config.claude, model: claudeModel } }
    : config;

  const verifier = new IndependentVerifier({ config: effectiveConfig, paths, repo });
  const delivery = buildDelivery({ config: effectiveConfig, repo, verifier });
  if (profile.staging.mode === 'local-next-isolated') {
    verifier.assertSource = task => assertLocalNextSource(task);
    // Independently executed repository tests share the same enforced sandbox;
    // a stripped environment alone is insufficient filesystem/network isolation.
    verifier.execute = async (command, { worktree, fingerprint, plan }) => {
      const head = runGit(worktree, ['rev-parse','HEAD']);
      const status = runGit(worktree, ['status','--porcelain']);
      if (profile.staging.hostBundle && (!head.ok || !status.ok || status.stdout.trim())) throw Error('Pinned isolated verification requires a clean committed worktree');
      if (profile.staging.hostBundle && path.relative(worktree, command.cwd)) throw Error('Pinned isolated verification commands use the approved bundle script from the worktree root');
      if (!delivery.available()) throw Error('Pinned local verification host is unavailable');
      const result = await delivery.host.runVerification({ settings: structuredClone(profile.staging), source: { commit: head.stdout.trim(), fingerprint, plan }, command: { ...command, env: localEnvironment() } });
      assertIsolationProof(result.isolation, profile.staging);
      return result;
    };
  }

  // Only ever called for a task the host itself isolated via prepareTask() below,
  // against the one dedicated static-only repo this connected profile points at
  // (profile.repoPath, verified below). It must never be treated as a general
  // "is this dirty worktree safe" check against the orchestrator's own main repo.
  function assertIsolated(task, run) {
    if (!task || task.isolation !== "worktree" || !task.work_dir) throw Error("Isolated worktree required");
    if (path.resolve(task.repo_path) !== path.resolve(profile.repoPath))
      throw Error("Task repository does not match the connected bounded profile");
    const expected = fs.realpathSync(worktreePathFor(paths.worktreeRoot, task.id));
    if (fs.realpathSync(task.work_dir) !== expected) throw Error("Worktree scope mismatch");
    const branch = runGit(task.work_dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!branch.ok || branch.stdout !== branchNameFor(task.id)) throw Error("Worktree branch mismatch");
    // taskChangedFilesInWorktree() reports only what actually changed since the
    // worktree's own baseCommit (committed diff + working tree, including
    // deletions/renames/untracked). `git ls-files --cached` would instead list
    // every tracked file in the whole worktree, which false-flags an unmodified
    // repo as fully "changed" the moment it has any tracked file outside
    // allowedPaths.
    const changed = taskChangedFilesInWorktree(task.work_dir, task.base_commit);
    if (changed.some((file) => !profile.allowedPaths.includes(file))) throw Error("Change outside the host-approved file scope");
    void run;
  }

  function readProbes() {
    try {
      const saved = JSON.parse(fs.readFileSync(probesFile, "utf8"));
      if (delivery.revisionContract && saved.profileHash !== hash(profile)) return {};
      return saved;
    } catch {
      return {};
    }
  }
  function freshOk(entry) {
    return !!entry && entry.ok === true && Number.isFinite(entry.at) && Date.now() - entry.at <= PROBE_MAX_AGE_MS;
  }

  function capabilities() {
    const probes = readProbes();
    const stagingAvailable = delivery.available?.() ?? !delivery.revisionContract;
    const localHostAvailable = profile.staging.mode !== 'local-next-isolated' || stagingAvailable;
    return {
      implementationProvider,
      ...(implementationProvider === "codex" && { modelPolicy }),
      browserQa:
        localHostAvailable && freshOk(probes.browser) && freshOk(probes.codex) && probes.codex.account === "chatgpt"
          ? { connected: true, sessionScoped: false }
          : { connected: false, reason: localHostAvailable ? describeStaleProbe(probes, ["browser", "codex"], "ブラウザQA") : 'Pinned local browser host is unavailable' },
      codex: freshOk(probes.codex) && probes.codex.account === "chatgpt"
        ? { connected: true }
        : { connected: false, reason: describeStaleProbe(probes, ["codex"], "Codex実行") },
      claude: implementationProvider === "claude" && freshOk(probes.claude)
        ? { connected: true }
        : { connected: false, reason: implementationProvider === "codex"
          ? "Codex-only profile" : describeStaleProbe(probes, ["claude"], "Claude実行") },
      staging: stagingAvailable && freshOk(probes.staging)
        ? { connected: true, mode: profile.staging.mode, qaUrl: profile.qaUrl }
        : { connected: false, reason: stagingAvailable ? describeStaleProbe(probes, ["staging"], "staging isolation") : profile.staging.mode === 'real-staging' ? 'Trusted immutable Next.js release transport is unavailable' : 'Pinned local isolation host is unavailable' },
    };
  }

  /** ホストが自分のスケジュールで呼ぶ。この呼び出し以外で実probeは行わない。 */
  async function refreshProbes() {
    const localHost = profile.staging.mode === 'local-next-isolated';
    const browserProbe = async () => {
      if (!profile.playwright) return { ok: true, reason: "この対象プロファイルはブラウザQAを使用しません" };
      if (localHost && delivery.capturesBrowser) {
        try { await delivery.probeBrowser(); return { ok: true }; }
        catch (error) { return { ok: false, reason: error.message }; }
      }
      return probeBrowserLaunch({
        modulePath: profile.playwright.modulePath,
        headless: profile.playwright.headless !== false,
        launch: localHost ? () => delivery.launchBrowser() : launchBrowser,
      });
    };
    // A "local" evidenceMode target app (Photo Station, Store Simulator) has
    // no browser QA target at all; a profile that forbids one must never
    // attempt to launch a browser to "prove" a capability it does not need or
    // claim.
    const [claude, codex, browser, staging] = await Promise.all([
      implementationProvider === "claude"
        ? probeClaudeAvailability({ config, execute, resolveExecutable: resolveClaude })
        : Promise.resolve({ ok: false, reason: "Codex-only profile" }),
      probeCodexLogin({ executable: config.codex?.executable, execute, resolveExecutable: resolveCodex }),
      browserProbe(),
      probeStagingPreflight({ delivery }),
    ]);
    const at = Date.now();
    const record = { profileHash: hash(profile), claude: { at, ...claude }, codex: { at, ...codex, ...(codex.ok && { account: "chatgpt" }) }, browser: { at, ...browser }, staging: { at, ...staging } };
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.writeFileSync(probesFile, JSON.stringify(record, null, 2));
    return record;
  }

  async function safetyGate({ run }) {
    const task = repo.getTask(run.task_id);
    try {
      assertIsolated(task, run);
    } catch (error) {
      return { allowed: false, reason: error.message };
    }
    if ((run.configSnapshot.qaUrl || "") !== (profile.qaUrl || ""))
      return { allowed: false, reason: "Configured QA URL is outside the connected profile" };
    if (delivery.revisionContract && run.configSnapshot.stagingMode !== profile.staging.mode)
      return { allowed: false, reason: 'Run staging mode does not match the approved Next.js profile' };
    if ((run.configSnapshot.allowedDomains || []).some((d) => !(profile.allowedDomains || []).includes(d)))
      return { allowed: false, reason: "Configured allowed domain is outside the connected profile" };
    if (run.state === "STAGING_DEPLOYING") {
      try {
        await delivery.preflight({ checkPort: false });
      } catch (error) {
        return { allowed: false, reason: "Staging isolation preflight failed: " + error.message };
      }
    }
    return { allowed: true };
  }

  function prepareTask(task, input) {
    if (path.resolve(task.repo_path) !== path.resolve(profile.repoPath)) throw Error("Task repository does not match the connected profile");
    if (!["system", "user_ui"].includes(task.source)) throw Error("Unapproved task source for a cooperative run");
    // A caller-supplied profileId is only ever a *confirmation* of which profile
    // it expects to run against; it is never a selector (this connected host
    // only ever builds the one profile validated at startup). Reject a
    // mismatch before touching git / creating a worktree. Approved target-app
    // profiles (AC-4) additionally require the caller to state the target app
    // explicitly every time; an unset or mismatched profileId is never
    // silently accepted as "the connected default".
    if (profile.targetApp && input?.profileId !== profile.id)
      throw Error(`Requests against this connected ${profile.targetApp} profile must declare a matching profileId`);
    if (!profile.targetApp && input?.profileId && input.profileId !== profile.id)
      throw Error(`Requested profileId does not match the connected ${SUPPORTED_PROFILE_ID} profile`);
    // Binds the checkpoint to the full profile (config, staging, verification,
    // models, qaSteps, ...), not just its id, plus the run's own revision/acIds
    // and the task's source. Any of those changing silently between the first
    // prepareTask() and a later one (e.g. an operator edited eco-runtime.json,
    // or the run's acIds changed) must not silently reuse the old worktree.
    const profileHash = hash(profile);
    const acIdsKey = JSON.stringify([...(input?.acIds ?? [])].sort());
    const existing = repo.store.get(
      "SELECT data FROM checkpoints WHERE task_id=? AND phase='eco_profile' ORDER BY id DESC LIMIT 1",
      [task.id],
    );
    if (existing) {
      const saved = JSON.parse(existing.data);
      const identityChanged =
        saved.profileId !== profile.id ||
        saved.source !== task.source ||
        saved.revision !== (input?.revision ?? null) ||
        saved.acIdsKey !== acIdsKey;
      if (identityChanged)
        throw Error("Task is bound to a different profile, revision, acIds or source than at first preparation");
      const clean = runGit(saved.workDir, ["status", "--porcelain"]);
      if (!clean.ok || clean.stdout.trim())
        throw Error("Cannot rebind a modified previously prepared isolated worktree");
      if (saved.profileHash !== profileHash) {
        const active = repo.store.get(
          "SELECT COUNT(*) AS count FROM eco_runs WHERE task_id=? AND state NOT IN ('COMPLETED_STAGING','FAILED','CANCELLED')",
          [task.id],
        );
        if (Number(active?.count) !== 1)
          throw Error("Profile changes require exactly one newly requested cooperative run");
        // Keep the old checkpoint as immutable history and append the corrected
        // host profile binding. Task identity, revision, ACs and a clean
        // isolated worktree must still match exactly.
        repo.checkpoint(task.id, "eco_profile", {
          profileId: profile.id,
          profileHash,
          source: task.source,
          workDir: saved.workDir,
          branch: saved.branch,
          baseCommit: saved.baseCommit,
          allowedPaths: profile.allowedPaths,
          revision: input?.revision ?? null,
          acIds: input?.acIds,
          acIdsKey,
          reboundFromProfileHash: saved.profileHash,
        });
      }
      return repo.updateTask(task.id, {
        isolation: "worktree",
        work_dir: saved.workDir,
        worktree_path: saved.workDir,
        worktree_branch: saved.branch,
        base_commit: saved.baseCommit,
      });
    }
    const created = createTaskWorktree({ repoPath: profile.repoPath, worktreeRoot: paths.worktreeRoot, taskId: task.id, logger });
    if (!created.ok) throw Error(created.reason);
    const clean = runGit(created.path, ["status", "--porcelain"]);
    if (!clean.ok || clean.stdout.trim()) throw Error("Isolated worktree is not clean after creation");
    repo.checkpoint(task.id, "eco_profile", {
      profileId: profile.id,
      profileHash,
      source: task.source,
      workDir: created.path,
      branch: created.branch,
      baseCommit: created.baseCommit,
      allowedPaths: profile.allowedPaths,
      revision: input?.revision ?? null,
      acIds: input?.acIds,
      acIdsKey,
    });
    return repo.updateTask(task.id, {
      isolation: "worktree",
      work_dir: created.path,
      worktree_path: created.path,
      worktree_branch: created.branch,
      base_commit: created.baseCommit,
    });
  }

  const contextFor = async (run) => {
    if (run.specId) {
      const spec = readArtifact(repo, run.specId);
      return { acIds: run.acIds, briefing: JSON.stringify(spec?.body?.acceptanceCriteria || run.acIds), baseUrl: run.configSnapshot.qaUrl };
    }
    const task = repo.getTask(run.task_id);
    return { acIds: run.acIds, briefing: String(task?.instruction || ""), baseUrl: profile.qaUrl };
  };

  const codexExecutable = resolveCodex(config.codex?.executable || "codex") || config.codex?.executable || "codex";
  const codexAssertSubscription = async () =>
    probeCodexLogin({ executable: config.codex?.executable, execute, resolveExecutable: resolveCodex });
  const gptWorkerDirectory = path.join(paths.stateDir, "eco-gpt-worker");
  const staticSmoke = effectiveConfig.staging?.mode === "static-smoke";

  // A "local" evidenceMode target app (Photo Station, Store Simulator) has no
  // page to open and no cloud deployment; a successful static-smoke/browser QA
  // pass must never stand in as its evidence (AC-2). Its QA phases are
  // host-synthesized from the same committed local UI evidence file the
  // delivery step already verified.
  function makeLocalUiQaWorker(phase) {
    const appLabel = APPROVED_TARGET_APPS[profile.targetApp]?.label || profile.targetApp;
    const readReceipt = (run, key) => {
      const row = repo.store.get(
        "SELECT data FROM checkpoints WHERE task_id=? AND phase=? ORDER BY id DESC LIMIT 1",
        [run.task_id, "eco:" + key],
      );
      return row ? JSON.parse(row.data) : null;
    };
    return {
      async reconcile({ run, operationKey }) {
        const old = readReceipt(run, operationKey);
        return old?.result || { status: old ? "unknown" : "absent" };
      },
      async execute({ run, operationKey }) {
        const old = readReceipt(run, operationKey);
        if (old) return old.result || { status: "unknown" };
        const task = repo.getTask(run.task_id);
        await assertIsolated(task, run);
        const root = evidenceRoot(run.id);
        fs.mkdirSync(root, { recursive: true });
        const proofName = hash(operationKey) + ".json";
        const proofFile = path.join(root, proofName);
        let result;
        if (phase === "qaInitial") {
          fs.writeFileSync(
            proofFile,
                JSON.stringify({ phase, note: appLabel + " baseline: no verified implementation evidence exists before delivery." }, null, 2),
            { flag: "wx" },
          );
          result = {
            status: "succeeded",
            usage: { measuredTokens: 0, estimatedTokens: 0, costUsd: 0, costKnown: true },
            artifact: {
              schemaVersion: 1,
              runId: run.id,
              revision: run.revision,
              producer: "host",
              kind: "qa",
              parentArtifactIds: [],
              evidenceRefs: [proofName],
              body: {
                specId: "baseline-qa-initial",
                deploymentId: "baseline",
                url: run.configSnapshot.qaUrl,
                revision: "baseline",
                browser: delivery.revisionContract ? 'not-run' : 'local-evidence',
                viewport: "n/a",
                accountType: delivery.revisionContract ? 'none' : 'local-build',
                acceptanceCriteria: run.acIds.map((id) => ({
                  id,
                  result: "NOT_RUN",
                  steps: ["baseline: no verified implementation evidence collected yet"],
                  evidenceRefs: [],
                })),
                findings: "実装に対応する検証証跡のベースラインは未収集です",
                verdict: "BLOCKED",
                reason: appLabel + " baseline requires implementation and verified delivery before evidence exists",
              },
            },
          };
        } else {
          const row = delivery.row(run.task_id);
          if (row?.state !== "succeeded" || row.commit_id !== run.headSHA)
            result = { status: "blocked", reason: "Local UI evidence delivery does not match the run revision" };
          else {
            let artifact;
            try {
              artifact = delivery.artifact(task);
            } catch (error) {
              result = { status: "blocked", reason: error.message };
            }
            if (artifact) {
              fs.writeFileSync(
                proofFile,
                JSON.stringify({ phase, sha256: artifact.sha256, evidencePath: artifact.evidencePath }, null, 2),
                { flag: "wx" },
              );
              result = {
                status: "succeeded",
                usage: { measuredTokens: 0, estimatedTokens: 0, costUsd: 0, costKnown: true },
                currentRevision: run.headSHA,
                artifact: {
                  schemaVersion: 1,
                  runId: run.id,
                  revision: run.revision,
                  producer: "host",
                  kind: "qa",
                  parentArtifactIds: run.specId ? [run.specId] : [],
                  evidenceRefs: [proofName],
                  body: {
                    specId: run.specId,
                    deploymentId: row.job_id,
                    url: run.configSnapshot.qaUrl,
                    revision: run.headSHA,
                    browser: "local-evidence",
                    viewport: "n/a",
                    accountType: "local-build",
                    acceptanceCriteria: run.acIds.map((id) => ({
                      id,
                      result: "PASS",
                      steps: ["committed local build/test/UI evidence verified: " + artifact.evidencePath],
                      evidenceRefs: [proofName],
                    })),
                    findings: [],
                    verdict: "PASS",
                    reason: "Verified committed local build/test/UI evidence at the deployed revision",
                  },
                },
              };
            }
          }
        }
        repo.checkpoint(run.task_id, "eco:" + operationKey, { result });
        return result;
      },
    };
  }

  const qaInitial =
    profile.evidenceMode === "local" || delivery.revisionContract
      ? makeLocalUiQaWorker("qaInitial")
      : createBrowserQaWorker({
          phase: "qaInitial",
          ...phaseOptions("browserQa"),
          executable: codexExecutable,
          directory: path.join(gptWorkerDirectory, "qa-initial"),
          evidenceRoot,
          assertSubscription: codexAssertSubscription,
          playwrightModulePath: profile.playwright.modulePath,
          headless: profile.playwright.headless !== false,
          allowedDomains: profile.allowedDomains,
          sequence: profile.qaSteps.sequence,
          staticSmoke,
          localNextIsolated: profile.staging.mode === 'local-next-isolated',
          timeBudgetMs: profile.qaSteps.maxTotalSeconds * 1000,
          verifyBuild: makeVerifyInitialBuild({ profile, request }),
          contextFor,
          launch: profile.staging.mode === 'local-next-isolated' ? () => delivery.launchBrowser() : launchBrowser,
          execute,
        });

  const qaVerify =
    profile.evidenceMode === "local"
      ? makeLocalUiQaWorker("qaVerify")
      : createBrowserQaWorker({
          phase: "qaVerify",
          ...phaseOptions("browserQa"),
          executable: codexExecutable,
          directory: path.join(gptWorkerDirectory, "qa-verify"),
          evidenceRoot,
          assertSubscription: codexAssertSubscription,
          playwrightModulePath: profile.playwright.modulePath,
          headless: profile.playwright.headless !== false,
          allowedDomains: profile.allowedDomains,
          sequence: profile.qaSteps.sequence,
          staticSmoke,
          localNextIsolated: profile.staging.mode === 'local-next-isolated',
          timeBudgetMs: profile.qaSteps.maxTotalSeconds * 1000,
          verifyBuild: makeVerifyDeployedBuild({ repo, delivery, assertIsolated, request }),
          contextFor,
          capture: profile.staging.mode === 'local-next-isolated' && delivery.capturesBrowser
            ? (run, options) => delivery.captureQaSession(repo.getTask(run.task_id), options) : null,
          launch: profile.staging.mode === 'local-next-isolated' ? () => delivery.launchBrowser() : launchBrowser,
          execute,
        });

  const specification = buildSpecificationAdapter({
    repo,
    ...phaseOptions("specification"),
    executable: codexExecutable,
    directory: path.join(gptWorkerDirectory, "specification"),
    assertSubscription: codexAssertSubscription,
    allowedPaths: profile.allowedPaths,
    execute,
  });

  async function modelAvailable(candidate) {
    if (candidate.provider !== implementationProvider) return false;
    const probes = readProbes();
    return implementationProvider === "codex"
      ? codexModels.has(modelKey(candidate)) && probes.codex?.account === "chatgpt" && freshOk(probes.codex)
      : candidate.model === claudeModel && freshOk(probes.claude);
  }

  const existing = existingAdapters({
    repo,
    taskForRun: (run) => repo.getTask(run.task_id),
    evidenceRoot,
    assertIsolated,
    allowedPaths: profile.allowedPaths,
    runnerForModel: (selected) => {
      if (selected.provider !== implementationProvider) throw Error("Implementation provider is outside the connected profile");
      if (selected.provider === "codex") {
        const codex = { ...effectiveConfig.codex, model: selected.model, reasoningEffort: selected.reasoningEffort };
        return new CodexRunner({ config: { ...effectiveConfig, codex }, paths, logger, execute, resolveExecutable: resolveCodex });
      }
      return new ClaudeRunner({ config: scopedClaudeConfig(effectiveConfig, selected.model, profile.allowedPaths), paths, logger });
    },
    modelAvailable,
    verifier,
    delivery,
  });

  return {
    capabilities,
    adapters: { ...existing, specification, qaInitial, qaVerify },
    evidenceRoot,
    safetyGate,
    prepareTask,
    refreshProbes,
    systemErrorRepairContract: {
      profileId: profile.id, repoPath: profile.repoPath, allowedPaths: profile.allowedPaths,
      stagingMode: profile.staging.mode, implementationProvider,
      verificationRequired: profile.verification?.required === true,
      requiresFrozenBundleReview: !!profile.staging.hostBundle,
    },
    stop: () => delivery.stop?.(),
    stopRun: run => delivery.stopTask?.(run.task_id),
  };
}
