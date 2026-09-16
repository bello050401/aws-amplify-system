import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { hash } from "./policy.mjs";
import { runGit } from "../core/git.mjs";
import { runProcess, writeEvidence } from "../pipeline/process.mjs";
import { IndependentVerifier, fingerprint } from "../pipeline/verification.mjs";

const CONTEXT_LIMITATION =
  "This packet only reduces prompt duplication for the host's own bounded implementation context. It cannot and does not prevent a native Read tool call against the physical file; any such call must be recorded separately via noteNativeRead.";

const MAX_SUMMARY_BYTES = 6000;
const DEFAULT_MAX_CONTEXT_BYTES = 12000;
const DEFAULT_MAX_PREVIOUS_RESULT_BYTES = 2000;

function contentHashOf(fullPath) {
  return hash(fs.readFileSync(fullPath));
}

/**
 * Stores a short change-purpose summary for one allowed file, keyed by
 * repository/branch/path/contentHash + spec/policy/schema dependency digests.
 * A rename, delete, external edit, or dependency version change all produce a
 * different key, so the old summary is simply never hit again (safe expiry by
 * construction, not by explicit invalidation).
 */
export function putContextPacket({
  cache,
  repository,
  branch,
  root,
  allowedPaths,
  dependencyDigest,
  specVersion,
  policyVersion,
  schemaVersion,
  purpose,
  expiresAt,
}) {
  if (!cache) return [];
  const summary = String(purpose || "").slice(0, MAX_SUMMARY_BYTES);
  if (!summary) throw Error("Context packet requires a non-empty purpose summary");
  const ids = [];
  for (const relativePath of allowedPaths) {
    const full = path.resolve(root, relativePath);
    let contentHash;
    try {
      contentHash = contentHashOf(full);
    } catch {
      continue;
    }
    const input = {
      repository,
      branch,
      path: relativePath,
      contentHash,
      dependencyDigest,
      specVersion,
      policyVersion,
      schemaVersion,
    };
    try {
      ids.push(cache.putContext(input, summary, [], expiresAt));
    } catch {
      // A secret-shaped or oversized summary is rejected by the cache itself;
      // skip that path rather than silently dropping the whole packet.
    }
  }
  return ids;
}

/**
 * Looks up which allowedPaths already have a valid, dependency-matched
 * summary (safe to skip restating as fresh reads) versus which are unread
 * or invalidated (must be read fresh by the implementation Agent/host).
 */
export function getContextPacket({
  cache,
  repository,
  branch,
  root,
  allowedPaths,
  dependencyDigest,
  specVersion,
  policyVersion,
  schemaVersion,
}) {
  const hits = [];
  const unread = [];
  for (const relativePath of allowedPaths) {
    let contentHash;
    try {
      contentHash = contentHashOf(path.resolve(root, relativePath));
    } catch {
      unread.push({ path: relativePath, reason: "missing_or_unreadable" });
      continue;
    }
    if (!cache) {
      unread.push({ path: relativePath, reason: "cache_disabled" });
      continue;
    }
    const result = cache.context(
      {
        repository,
        branch,
        path: relativePath,
        contentHash,
        dependencyDigest,
        specVersion,
        policyVersion,
        schemaVersion,
      },
      { sufficient: true },
    );
    if (result.hit)
      hits.push({ path: relativePath, summary: result.value.summary, source: result.source });
    else unread.push({ path: relativePath, reason: result.reason || "missing_or_changed" });
  }
  return { hits, unread, limitation: CONTEXT_LIMITATION };
}

/**
 * Bounds what actually goes into the implementation prompt: accepted spec,
 * a short previous-result summary, and per-file cached summaries/changed
 * metadata only -- never full file contents or diffs. Total byte size is
 * capped; oldest/lowest-priority packets are dropped first if it would
 * exceed the bound, and that drop is recorded, not silently truncated mid-word.
 */
export function buildImplementationContext({
  spec,
  previousResultSummary = "",
  packets = { hits: [], unread: [], limitation: CONTEXT_LIMITATION },
  changedFiles = [],
  maxBytes = DEFAULT_MAX_CONTEXT_BYTES,
  maxPreviousResultBytes = DEFAULT_MAX_PREVIOUS_RESULT_BYTES,
}) {
  const boundedPrevious = String(previousResultSummary || "").slice(0, maxPreviousResultBytes);
  const changedFileMetadata = changedFiles.map((f) => ({
    path: typeof f === "string" ? f : f.path,
    digest: typeof f === "string" ? null : f.digest ?? null,
  }));
  const included = [];
  const dropped = [];
  let usedBytes = Buffer.byteLength(JSON.stringify({ spec, boundedPrevious, changedFileMetadata }));
  for (const hit of packets.hits || []) {
    const entry = { path: hit.path, summary: hit.summary };
    const bytes = Buffer.byteLength(JSON.stringify(entry));
    if (usedBytes + bytes > maxBytes) {
      dropped.push(hit.path);
      continue;
    }
    usedBytes += bytes;
    included.push(entry);
  }
  const summaryText = included.map((e) => `${e.path}: ${e.summary}`).join("\n");
  return {
    spec,
    previousResultSummary: boundedPrevious,
    changedFileMetadata,
    includedPackets: included,
    droppedForByteLimit: dropped,
    unread: (packets.unread || []).map((u) => u.path),
    summaryText,
    byteSize: usedBytes,
    limitation: packets.limitation || CONTEXT_LIMITATION,
  };
}

/**
 * Event hook a host can call after a native Read tool actually touched an
 * allowedPath, so the packet record honestly reflects that a real read
 * happened even though a cached summary existed. Returns a plain record for
 * the caller to persist (e.g. via repo.checkpoint); this module does not own
 * durable storage beyond the EcoCache context/test tables.
 */
export function noteNativeRead({ path: relativePath, reason, at = Date.now() }) {
  if (!reason) throw Error("noteNativeRead requires a reason for the re-read");
  return { path: relativePath, reason, at: new Date(at).toISOString() };
}

export const contextPacketsLimitation = CONTEXT_LIMITATION;

const verificationDigest = (value) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Same as verification.mjs's fingerprint(), but ignores files under
 * excludeDirs (e.g. the run's own evidence directory). Evidence for a run is
 * written inside the verified worktree, so a plain fingerprint would change
 * on every run just from that bookkeeping and could never be reused as a
 * stable cache key across separate CachedIndependentVerifier invocations.
 */
function fingerprintExcluding(cwd, excludeDirs) {
  const listed = runGit(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (!listed.ok) throw new Error("検証対象のファイル一覧を取得できません");
  const excluded = excludeDirs
    .map((dir) => path.relative(cwd, dir).split(path.sep).join("/"))
    .filter((rel) => rel && !rel.startsWith(".."));
  const h = crypto.createHash("sha256");
  for (const file of [...new Set(listed.stdoutRaw.split("\0").filter(Boolean))].sort()) {
    const normalized = file.split(path.sep).join("/");
    if (excluded.some((ex) => normalized === ex || normalized.startsWith(ex + "/"))) continue;
    const full = path.resolve(cwd, file);
    h.update(file + "\0");
    try {
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) h.update("link:" + fs.readlinkSync(full));
      else if (stat.isFile()) h.update(fs.readFileSync(full));
      else h.update("non-file");
    } catch (err) {
      if (err.code === "ENOENT") h.update("deleted");
      else throw err;
    }
    h.update("\0");
  }
  return h.digest("hex");
}

const CACHE_CONTEXT_FIELDS = [
  "repository",
  "dependencyDigest",
  "runtime",
  "environmentVersion",
  "fixtureRevision",
  "toolchain",
  "externalVersion",
];

/**
 * Duck-type compatible with IndependentVerifier (same constructor shape and
 * `.required`/`.settings`/`.run()`/`.check()`), but reuses a prior evidence
 * verified test result when the host-supplied cacheContext proves identical
 * repo/gitSHA/worktree fingerprint/test plan/dependency/runtime/toolchain
 * state. A missing or incomplete fingerprint, or any health-check/unproven
 * external command, always executes for real; the cache is never consulted
 * for those.
 */
export class CachedIndependentVerifier {
  constructor({
    config,
    paths,
    repo,
    execute = runProcess,
    cache = null,
    cacheContext = null,
  }) {
    this.base = new IndependentVerifier({ config, paths, repo, execute });
    this.settings = this.base.settings;
    this.paths = paths;
    this.repo = repo;
    this.cache = cache;
    this.cacheContext = cacheContext;
  }
  get required() {
    return this.base.required;
  }
  buildCacheInput(task) {
    const ctx = this.cacheContext;
    if (
      !ctx ||
      CACHE_CONTEXT_FIELDS.some(
        (k) => ctx[k] === undefined || ctx[k] === null || ctx[k] === "",
      )
    )
      return null;
    const cwd = task.work_dir || task.repo_path;
    const sha = runGit(cwd, ["rev-parse", "HEAD"]);
    if (!sha.ok) return null;
    return {
      repository: ctx.repository,
      gitSHA: sha.stdout.trim(),
      inputDigest: fingerprintExcluding(cwd, [this.paths.runsDir]),
      testDigest: verificationDigest(this.settings),
      command: verificationDigest(
        this.settings.commands.map((c) => [c.name, c.file, c.args, c.cwd]),
      ),
      dependencyDigest: ctx.dependencyDigest,
      runtime: ctx.runtime,
      environmentVersion: ctx.environmentVersion,
      fixtureRevision: ctx.fixtureRevision,
      toolchain: ctx.toolchain,
      externalVersion: ctx.externalVersion,
    };
  }
  async run(task, shouldStop = () => false) {
    const hasExternal = this.settings.commands.some((c) => c.external);
    const healthCheck = this.settings.commands.some((c) => c.healthCheck);
    const externalStateProven = this.cacheContext?.externalStateProven === true;
    const cwd = task.work_dir || task.repo_path;
    let input = null;
    if (this.cache) {
      try {
        input = this.buildCacheInput(task);
      } catch {
        input = null;
      }
    }
    if (input) {
      const hit = this.cache.test(input, {
        external: hasExternal,
        externalStateProven,
        healthCheck,
      });
      if (hit.hit) {
        const record = hit.value.record;
        const receipt = {
          attempt: task.attempts,
          fingerprint: record.finalFingerprint,
          plan: verificationDigest(this.settings),
          passed: true,
          results: record.results,
          cache: {
            status: "reused",
            source: hit.source,
            executedAt: record.executedAt,
          },
        };
        this.repo.checkpoint(task.id, "independent_verification", receipt);
        return receipt;
      }
    }
    const startedAt = Date.now();
    const receipt = await this.executeVerification(task, shouldStop);
    const cacheEligible = !!(
      input &&
      !healthCheck &&
      (!hasExternal || externalStateProven)
    );
    receipt.cache = {
      status: "executed",
      reason: !this.cache
        ? "no_cache"
        : !input
          ? "fingerprint_incomplete"
          : cacheEligible
            ? "stored"
            : healthCheck
              ? "health_check_never_cached"
              : "external_state_unproven",
      executedAt: new Date(startedAt).toISOString(),
    };
    if (cacheEligible) {
      try {
        const evidencePath = writeEvidence(
          path.join(this.paths.runsDir, task.id, "verification"),
          `cache-${task.attempts}-${crypto.randomUUID()}.json`,
          receipt,
        );
        const finalFingerprint = fingerprint(cwd);
        receipt.fingerprint = finalFingerprint;
        this.cache.putTest(
          input,
          {
            result: receipt.passed ? "passed" : "failed",
            evidencePath,
            external: hasExternal,
            externalStateProven,
            flaky: false,
            healthCheck: false,
            results: receipt.results,
            finalFingerprint,
            executedAt: receipt.cache.executedAt,
          },
          this.cacheContext.expiresAt ?? Date.now() + 24 * 3600 * 1000,
        );
      } catch {
        receipt.cache.reason = "cache_write_failed";
      }
    }
    this.repo.checkpoint(task.id, "independent_verification", receipt);
    return receipt;
  }
  /**
   * Mirrors IndependentVerifier.executeTask, but defers writing per-command
   * evidence until after the "after" fingerprint is captured. Evidence lives
   * inside the verified worktree (paths.runsDir is nested under cwd), so
   * writing it mid-loop makes the before/after worktree comparison see its
   * own bookkeeping file as a change and always fail.
   */
  async executeVerification(task, shouldStop = () => false) {
    const cwd = task.work_dir || task.repo_path;
    try {
      const before = fingerprint(cwd);
      const executed = [];
      for (const command of this.settings.commands) {
        const target = path.resolve(cwd, command.cwd || ".");
        const relative = path.relative(fs.realpathSync(cwd), fs.realpathSync(target));
        if (relative.startsWith("..") || path.isAbsolute(relative))
          throw new Error("検証コマンドの作業場所がworktree外です");
        const result = await this.base.execute({
          file: command.file,
          args: command.args,
          cwd: target,
          timeoutMs: (command.timeoutSeconds || 600) * 1000,
          shouldStop,
        });
        executed.push({ command, result });
        if (!result.ok) break;
      }
      const after = fingerprint(cwd);
      const results = executed.map(({ command, result }) => {
        const evidencePath = writeEvidence(
          path.join(this.paths.runsDir, task.id, "verification"),
          `${task.attempts}-${crypto.randomUUID()}.json`,
          { command, ...result },
        );
        return {
          name: command.name,
          exitCode: result.exitCode,
          passed: result.ok,
          reason: result.reason || result.error,
          evidencePath,
        };
      });
      const receipt = {
        attempt: task.attempts,
        fingerprint: after,
        plan: verificationDigest(this.settings),
        passed:
          results.length > 0 &&
          results.length === this.settings.commands.length &&
          results.every((r) => r.passed) &&
          before === after,
        results,
      };
      if (before !== after)
        receipt.error = "検証中にソースが変更されました。再検証が必要です。";
      if (!results.length) receipt.error = "独立検証コマンドが未設定です。";
      return receipt;
    } catch (err) {
      return {
        attempt: task.attempts,
        fingerprint: null,
        plan: verificationDigest(this.settings),
        passed: false,
        results: [],
        error: err.message,
      };
    }
  }
  check(task) {
    return this.base.check(task);
  }
}
