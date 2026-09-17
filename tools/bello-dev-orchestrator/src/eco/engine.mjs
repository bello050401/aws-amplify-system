import crypto from "node:crypto";
import { hash, retryDelay } from "./policy.mjs";
import { safeEvidence } from "./cache.mjs";
import { inspectInstruction } from "./taskRouting.mjs";

const terminal = new Set(["COMPLETED_STAGING", "CANCELLED", "FAILED"]);
const suspended = new Set([
  "PAUSED",
  "WAITING_APPROVAL",
  "WAITING_USER_AUTH",
  "WAITING_CAPACITY",
  "HUMAN_REVIEW",
]);
const phaseAdapter = {
  DISCOVERING: "discover",
  QA_INITIAL: "qaInitial",
  SPEC_READY: "specification",
  IMPLEMENTING: "implement",
  TESTING: "test",
  STAGING_DEPLOYING: "deploy",
  QA_VERIFY: "qaVerify",
};
// Phases where the adapter is a read-only model call (spec text or QA
// judgement), never a mutation of the isolated worktree. Only these phases
// may auto-regenerate a bounded number of times on a typed invalid-artifact
// failure without counting as a communication failure or an implementation
// repair loop.
const readOnlyArtifactPhases = new Set(["QA_INITIAL", "SPEC_READY", "QA_VERIFY"]);

/** Durable coordinator. Adapters must reconcile the persisted operation key before
 * dispatching; an unknown external result is never retried as a new operation.
 * This class does not authorize production operations or execute arbitrary commands.
 */
export class EcoEngine {
  constructor({
    repo,
    adapters = {},
    evidenceRoot,
    safetyGate = async () => ({
      allowed: false,
      reason: "Independent safety policy is not connected",
    }),
    now = () => Date.now(),
    paused = () => false,
    worker = crypto.randomUUID(),
  }) {
    Object.assign(this, {
      repo,
      adapters,
      evidenceRoot,
      safetyGate,
      now,
      paused,
      worker,
    });
  }

  change(run, next, patch = {}, reason = "") {
    return this.repo.mutate(
      run.id,
      run.version,
      next,
      patch,
      reason,
      this.worker,
    );
  }

  control(id, version, action, key) {
    return this.repo.idempotent(key, { id, version, action }, () => {
      const run = this.repo.get(id);
      if (!run || run.version !== version || terminal.has(run.state))
        throw Error("Run version conflict or terminal run");
      const next =
        action === "pause"
          ? "PAUSED"
          : action === "cancel"
            ? "CANCELLED"
            : action === "resume" && suspended.has(run.state)
              ? run.resumeState
              : null;
      if (!next) throw Error("Cannot resume without a verified resume phase");
      if (action === "resume" && run.pendingEffect?.status === "unknown")
        throw Error("Reconcile the external operation before resuming");
      return this.repo.mutate(
        run.id,
        run.version,
        next,
        {},
        "Operator " + action,
        "operator",
      );
    });
  }

  async tick(id) {
    if (
      this.paused() ||
      !this.repo.settings().config.enabled ||
      !this.repo.acquire(id, this.worker)
    )
      return false;
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      try {
        if (!this.repo.acquire(id, this.worker)) leaseLost = true;
      } catch {
        leaseLost = true;
      }
    }, 10000);
    heartbeat.unref();
    try {
      let run = this.repo.get(id);
      if (!run || terminal.has(run.state) || suspended.has(run.state))
        return false;
      if (run.retryAt && this.now() < run.retryAt) return false;
      if (
        this.now() >= run.deadline ||
        run.usage.measuredTokens + run.usage.estimatedTokens >=
          run.configSnapshot.maxTokens ||
        run.usage.costUsd >= run.configSnapshot.maxCostUsd
      ) {
        this.change(run, "HUMAN_REVIEW", {}, "Execution budget exhausted");
        return true;
      }
      if (run.state === "QUEUED") {
        this.change(run, "DISCOVERING");
        return true;
      }
      if (run.state === "REPAIR_PENDING") {
        this.change(run, "IMPLEMENTING");
        return true;
      }
      const adapter = this.adapters[phaseAdapter[run.state]];
      if (!adapter?.execute || !adapter?.reconcile) {
        this.change(
          run,
          "HUMAN_REVIEW",
          {},
          "Required adapter is not connected: " + phaseAdapter[run.state],
        );
        return true;
      }
      if (run.state === "STAGING_DEPLOYING") {
        if (!run.configSnapshot.stagingAutoDeploy) {
          this.change(
            run,
            "HUMAN_REVIEW",
            {},
            "Manual staging deployment requires revision verification",
          );
          return true;
        }
        this.repo.reserveEnvironment(id, run.configSnapshot.qaUrl);
      }
      if (!run.pendingEffect) {
        run = this.change(
          run,
          run.state,
          {
            pendingEffect: {
              key: hash({ id, state: run.state, version: run.version }),
              phase: run.state,
              status: "prepared",
            },
          },
          "Operation intent persisted",
        );
      }
      const effect = run.pendingEffect;
      const context = {
        run,
        operationKey: effect.key,
        signal: () =>
          leaseLost ||
          !this.repo.ownsLease(id, this.worker) ||
          this.paused() ||
          this.repo.get(id)?.version !== run.version,
      };
      // Even the first attempt is reconciled. The adapter must be authoritative.
      let result = await adapter.reconcile(context);
      if (context.signal()) return false;
      if (result?.status === "pending") return false;
      if (result?.status === "unknown" || !result) {
        this.change(
          run,
          "HUMAN_REVIEW",
          { pendingEffect: { ...effect, status: "unknown" } },
          "External operation result unknown; no redispatch",
        );
        return true;
      }
      if (result.status === "absent") {
        if (effect.status !== "prepared") {
          this.change(
            run,
            "HUMAN_REVIEW",
            {},
            "Dispatched operation cannot be proven absent",
          );
          return true;
        }
        const safety = await this.safetyGate({ run, operationKey: effect.key });
        if (!safety?.allowed) {
          this.change(
            run,
            "WAITING_APPROVAL",
            {},
            safety?.reason || "Independent safety gate denied execution",
          );
          return true;
        }
        if (context.signal()) return false;
        run = this.change(
          run,
          run.state,
          { pendingEffect: { ...effect, status: "dispatched" } },
          "Dispatching persisted operation",
        );
        context.run = run;
        result = await adapter.execute(context);
      }
      if (
        leaseLost ||
        !this.repo.ownsLease(id, this.worker) ||
        this.paused() ||
        this.repo.get(id)?.version !== run.version
      )
        return false;
      if (result?.status === "pending") return false;
      return this.accept(run, result);
    } catch (error) {
      const run = this.repo.get(id);
      if (
        run &&
        !terminal.has(run.state) &&
        !suspended.has(run.state) &&
        !leaseLost &&
        this.repo.ownsLease(id, this.worker)
      ) {
        // Timeouts may have completed externally. Keep the key and reconcile later.
        const field = error.artifactInvalid
          ? "artifactFailures"
          : "communicationFailures";
        const limit = error.artifactInvalid
          ? run.configSnapshot.artifactRetries
          : run.configSnapshot.communicationRetries;
        const count = run[field] + 1;
        this.change(
          run,
          count > limit ? "HUMAN_REVIEW" : run.state,
          { [field]: count, retryAt: this.now() + retryDelay(count) },
          error.artifactInvalid
            ? "Invalid artifact; correction required"
            : "Adapter error; result must be reconciled",
        );
      }
      return false;
    } finally {
      clearInterval(heartbeat);
      this.repo.release(id, this.worker);
    }
  }

  accept(run, result) {
    return this.repo.transaction(() => this.acceptResult(run, result));
  }

  acceptResult(run, result) {
    if (!result || typeof result !== "object") throw Error("Missing result");
    if (["auth", "capacity", "approval", "blocked"].includes(result.status)) {
      const state = {
        auth: "WAITING_USER_AUTH",
        capacity: "WAITING_CAPACITY",
        approval: "WAITING_APPROVAL",
        blocked: "HUMAN_REVIEW",
      }[result.status];
      this.change(
        run,
        state,
        result.effectCompleted ? { pendingEffect: null } : {},
        result.reason || result.status,
      );
      return true;
    }
    if (!["succeeded", "failed"].includes(result.status))
      throw Error("Unconfirmed result");
    if (
      result.status === "failed" &&
      result.effectCompleted === true &&
      result.artifactInvalid === true &&
      readOnlyArtifactPhases.has(run.state)
    ) {
      const usage = { ...run.usage };
      if (!result.usage) usage.costKnown = false;
      else {
        for (const key of ["measuredTokens", "estimatedTokens", "costUsd"]) {
          if (!Number.isFinite(result.usage[key]) || result.usage[key] < 0)
            throw Error("Invalid usage");
          usage[key] += result.usage[key];
        }
        usage.costKnown = usage.costKnown && result.usage.costKnown === true;
      }
      const count = run.artifactFailures + 1;
      const capped = count > run.configSnapshot.artifactRetries;
      this.change(
        run,
        capped ? "HUMAN_REVIEW" : run.state,
        { pendingEffect: null, retryAt: null, usage, artifactFailures: count },
        capped
          ? "Artifact retry limit reached: " + (result.reason || "invalid artifact")
          : "Invalid artifact; regenerating: " + (result.reason || ""),
      );
      return true;
    }
    let artifact;
    if (result.artifact) {
      try {
        artifact = this.repo.artifact(
          run.id,
          run.version,
          result.artifact,
          this.evidenceRoot(run.id),
        );
      } catch (error) {
        error.artifactInvalid = true;
        throw error;
      }
    }
    const usage = { ...run.usage };
    if (!result.usage) usage.costKnown = false;
    else {
      for (const key of ["measuredTokens", "estimatedTokens", "costUsd"]) {
        if (!Number.isFinite(result.usage[key]) || result.usage[key] < 0)
          throw Error("Invalid usage");
        usage[key] += result.usage[key];
      }
      usage.costKnown = usage.costKnown && result.usage.costKnown === true;
    }
    const patch = { pendingEffect: null, retryAt: null, usage };
    let next;
    switch (run.state) {
      case "DISCOVERING":
        if (
          result.status !== "succeeded" ||
          !result.isolated ||
          !result.revision
        )
          throw Error("Isolated discovery required");
        patch.discoveredRevision = result.revision;
        next = "QA_INITIAL";
        break;
      case "QA_INITIAL":
        if (artifact?.kind !== "qa")
          throw Error("Initial QA artifact required");
        patch.initialQaId = artifact.id;
        // Initial QA is a baseline. Missing UI/behavior is expected before implementation,
        // and its BLOCKED/FAIL findings become specification input. Transport/auth failures
        // arrive as typed adapter statuses earlier and still suspend the run.
        next = "SPEC_READY";
        break;
      case "SPEC_READY":
        if (artifact?.kind !== "spec") throw Error("Specification required");
        patch.instructionCheck = inspectInstruction(
          this.repo.store.get("SELECT instruction FROM tasks WHERE id=?", [
            run.task_id,
          ])?.instruction,
          artifact.body,
          run.acIds,
        );
        if (!patch.instructionCheck.ready) {
          next = "HUMAN_REVIEW";
          patch.instructionBlocker = "指示・仕様の不足を解消してから実装します";
          break;
        }
        patch.specId = artifact.id;
        next = "IMPLEMENTING";
        break;
      case "IMPLEMENTING":
        if (result.status !== "succeeded") {
          next = "REPAIR_PENDING";
          break;
        }
        if (
          artifact?.kind !== "implementation" ||
          artifact.body.specId !== run.specId ||
          artifact.body.specRevision !== run.revision
        )
          throw Error("Implementation must match accepted specification");
        patch.implementationId = artifact.id;
        patch.headSHA = artifact.body.headSHA;
        next = "TESTING";
        break;
      case "TESTING":
        if (result.status !== "succeeded") {
          next = "REPAIR_PENDING";
          break;
        }
        if (
          !result.independent ||
          !result.buildPassed ||
          (result.sourceRevision || result.revision) !== run.headSHA ||
          !result.evidenceRefs?.length
        )
          throw Error("Independent test/build evidence required");
        result.evidenceRefs.forEach((ref) =>
          safeEvidence(this.evidenceRoot(run.id), ref),
        );
        patch.testRecord = result;
        patch.headSHA = result.revision;
        next = "STAGING_DEPLOYING";
        break;
      case "STAGING_DEPLOYING":
        if (
          result.status !== "succeeded" ||
          !result.healthPassed ||
          result.revision !== run.headSHA ||
          result.url !== run.configSnapshot.qaUrl ||
          !result.deploymentId
        )
          throw Error("Staging health/revision mismatch");
        patch.deployment = result;
        next = "QA_VERIFY";
        break;
      case "QA_VERIFY":
        if (
          artifact?.kind !== "qa" ||
          artifact.body.specId !== run.specId ||
          artifact.body.deploymentId !== run.deployment?.deploymentId ||
          artifact.body.revision !== run.headSHA ||
          artifact.body.url !== run.configSnapshot.qaUrl ||
          result.currentRevision !== run.headSHA
        )
          throw Error("QA is not for the deployed build");
        patch.finalQaId = artifact.id;
        next =
          artifact.body.verdict === "PASS"
            ? "COMPLETED_STAGING"
            : artifact.body.verdict === "FAIL"
              ? "REPAIR_PENDING"
              : "HUMAN_REVIEW";
        break;
      default:
        throw Error("Unsupported phase");
    }
    this.change(run, next, patch, "Validated phase result");
    if (next === "COMPLETED_STAGING") this.repo.releaseEnvironment(run.id);
    return true;
  }
}
