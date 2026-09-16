import fs from "node:fs";
import path from "node:path";
import { runGit } from "../core/git.mjs";
import { fingerprint } from "../pipeline/verification.mjs";
import { redactValue } from "../log/redact.mjs";
import { routeModel, hash } from "./policy.mjs";
import {
  planWork,
  selectForWork,
  verifyEvaluationEvidence,
} from "./taskRouting.mjs";

const zeroUsage = {
  measuredTokens: 0,
  estimatedTokens: 0,
  costUsd: 0,
  costKnown: true,
};

export function implementationFailure(result) {
  const text = String(
    result.providerError || result.error || result.stderrTail || "",
  );
  if (
    result.apiErrorStatus === 429 ||
    /weekly limit|usage limit|rate.limit|quota.exceeded/i.test(text)
  )
    return {
      status: "capacity",
      effectCompleted: true,
      reason: "Implementation provider usage limit; no model escalation",
    };
  if (
    result.apiErrorStatus === 401 ||
    /not logged in|authentication.required|login.required/i.test(text)
  )
    return {
      status: "auth",
      effectCompleted: true,
      reason: "Implementation provider authentication required",
    };
  if (result.terminationReason === "spawn_failed")
    return {
      status: "blocked",
      effectCompleted: true,
      reason: "Implementation executable could not start",
    };
  return { status: "failed" };
}

/** Adapter for the existing Runner, IndependentVerifier and staging delivery.
 * All effects require a host-owned isolation check. Nothing in an Agent report
 * can authorize a target or choose the test commands.
 */
export function existingAdapters({
  repo,
  eco,
  taskForRun,
  evidenceRoot,
  assertIsolated,
  runnerForModel,
  verifier,
  delivery,
  modelAvailable,
  allowedPaths = [],
}) {
  const task = async (run) => {
    const value = await taskForRun(run);
    if (
      !value ||
      value.id !== run.task_id ||
      value.isolation !== "worktree" ||
      !value.work_dir
    )
      throw Error("Isolated task binding required");
    await assertIsolated(value, run);
    return value;
  };
  const head = (value) => {
    const result = runGit(value.work_dir, ["rev-parse", "HEAD"]);
    if (!result.ok) throw Error("Cannot read revision");
    return result.stdout.trim();
  };
  const artifact = (id) => {
    const row = repo.store.get("SELECT data FROM eco_artifacts WHERE id=?", [
      id,
    ]);
    if (!row) throw Error("Accepted specification missing");
    return JSON.parse(row.data);
  };
  const receipt = (run, key) => {
    const row = repo.store.get(
      "SELECT data FROM checkpoints WHERE task_id=? AND phase=? ORDER BY id DESC LIMIT 1",
      [run.task_id, "eco:" + key],
    );
    return row ? JSON.parse(row.data) : null;
  };
  const evidence = (run, key, data) => {
    const root = evidenceRoot(run.id);
    fs.mkdirSync(root, { recursive: true });
    const name = hash(key) + ".json";
    const file = path.join(root, name);
    const text = JSON.stringify(redactValue(data), null, 2);
    if (fs.existsSync(file)) {
      if (fs.readFileSync(file, "utf8") !== text)
        throw Error("Immutable operation evidence changed");
    } else fs.writeFileSync(file, text, { flag: "wx" });
    return name;
  };
  const journal = (execute) => ({
    async reconcile({ run, operationKey }) {
      const old = receipt(run, operationKey);
      return old?.result || { status: old ? "unknown" : "absent" };
    },
    async execute(context) {
      const { run, operationKey } = context;
      const old = receipt(run, operationKey);
      if (old) return old.result || { status: "unknown" };
      repo.checkpoint(run.task_id, "eco:" + operationKey, { dispatched: true });
      const result = await execute(context);
      repo.checkpoint(run.task_id, "eco:" + operationKey, { result });
      return result;
    },
  });
  const implementation = journal(async ({ run, operationKey, signal }) => {
    const value = await task(run);
    const spec = artifact(run.specId);
    if (
      spec.runId !== run.id ||
      spec.revision !== run.revision ||
      spec.kind !== "spec"
    )
      throw Error("Specification binding mismatch");
    const work = planWork({
      instruction: value.instruction,
      spec: spec.body,
      phase: "implementation",
      files: allowedPaths,
      risk: run.risk || "unknown",
      acIds: run.acIds,
    });
    const baseline = routeModel(run.configSnapshot, {
      phase: work.tier === "advanced" ? "architecture" : "implementation",
      logicalFailures: run.logicalFailures,
    });
    const availability = new Set();
    for (const candidate of run.configSnapshot.taskRouting?.catalog || []) {
      if (
        candidate.provider === baseline.provider &&
        (await modelAvailable(candidate))
      )
        availability.add(candidate.provider + ":" + candidate.model);
    }
    const selection = selectForWork({
      policy: run.configSnapshot.taskRouting,
      autoRouting: run.configSnapshot.modelAutoRouting,
      work,
      baseline,
      logicalFailures: run.logicalFailures,
      roleProvider: baseline.provider,
      available: (candidate) =>
        availability.has(candidate.provider + ":" + candidate.model),
      evidenceVerified: (model, category, ev) =>
        verifyEvaluationEvidence(repo.store, model, category, ev),
    });
    repo.checkpoint(run.task_id, "eco_routing:" + operationKey, {
      specId: run.specId,
      selection,
    });
    if (selection.waiting)
      return { status: "blocked", reason: selection.reason };
    if (!(await modelAvailable(selection)))
      return {
        status: "blocked",
        reason: "Selected model availability has not been verified",
      };
    const baseSHA = head(value);
    const instruction = [
      "Implement only this accepted specification in the isolated worktree.",
      "Do not deploy, access external services, read credentials, change infra, commit, or push.",
      "Report results in the existing completion report format. The host runs independent tests.",
      JSON.stringify(spec.body),
      run.finalQaId
        ? "Latest QA findings: " +
          JSON.stringify(artifact(run.finalQaId).body.findings)
        : "",
    ].join("\n");
    const result = await runnerForModel(selection).run({
      task: value,
      instruction,
      shouldStop: signal,
    });
    const proof = evidence(run, operationKey, { model: selection, result });
    if (!result.ok || result.report?.status !== "completed")
      return { ...implementationFailure(result), evidenceRefs: [proof] };
    const currentSHA = head(value);
    return {
      status: "succeeded",
      model: selection,
      usage: {
        ...zeroUsage,
        costUsd: Number.isFinite(result.costUsd) ? result.costUsd : 0,
        costKnown: Number.isFinite(result.costUsd),
        measuredTokens: result.usage
          ? [
              "input_tokens",
              "output_tokens",
              "cache_creation_input_tokens",
              "cache_read_input_tokens",
            ].reduce((sum, key) => sum + (Number(result.usage[key]) || 0), 0)
          : 0,
        estimatedTokens: result.usage
          ? 0
          : Math.ceil(
              Buffer.byteLength(instruction + JSON.stringify(result.report)) /
                3,
            ),
      },
      artifact: {
        schemaVersion: 1,
        runId: run.id,
        revision: run.revision,
        producer: selection.provider,
        kind: "implementation",
        parentArtifactIds: [run.specId],
        evidenceRefs: [proof],
        body: {
          specId: run.specId,
          specRevision: run.revision,
          baseSHA,
          headSHA: currentSHA,
          worktreeDigest: fingerprint(value.work_dir),
          changes: result.report.changes,
          acceptanceCriteria: run.acIds,
          tests: result.report.tests,
          build: "independent verification pending",
          deployment: "not run",
          rollback: baseSHA,
          remaining: result.report.remainingIssues || [],
        },
      },
    };
  });
  const tests = journal(async ({ run, operationKey, signal }) => {
    const value = await task(run);
    if (!verifier.required || !verifier.settings.commands.length)
      throw Error("Independent test plan required");
    const report = await verifier.run(value, signal);
    const proof = evidence(run, operationKey, report);
    if (!report.passed || !verifier.check(value).passed)
      return { status: "failed", evidenceRefs: [proof], usage: zeroUsage };
    // Only the host commits, after independent checks. No remote write here.
    const dirty = runGit(value.work_dir, ["status", "--porcelain"]);
    if (!dirty.ok) throw Error("Cannot inspect verified worktree");
    if (dirty.stdout.trim()) {
      await assertIsolated(value, run);
      const tracked = runGit(value.work_dir, [
        "diff",
        "--name-only",
        "-z",
        "HEAD",
      ]);
      const untracked = runGit(value.work_dir, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ]);
      if (!tracked.ok || !untracked.ok) throw Error("Cannot enumerate changes");
      const changed = [
        ...new Set(
          (tracked.stdoutRaw + untracked.stdoutRaw).split("\0").filter(Boolean),
        ),
      ];
      if (
        !changed.length ||
        changed.some((file) => !allowedPaths.includes(file))
      )
        throw Error("Change outside host-approved file scope");
      if (
        !runGit(value.work_dir, ["add", "--", ...changed]).ok ||
        !runGit(value.work_dir, [
          "commit",
          "-m",
          "BELLO isolated verification " + run.id,
        ]).ok
      )
        throw Error("Cannot commit verified change");
    }
    const revision = head(value);
    if (!verifier.check(value).passed)
      throw Error("Source changed after independent tests");
    repo.updateTask(value.id, { git_end_commit: revision });
    return {
      status: "succeeded",
      independent: true,
      buildPassed: true,
      revision,
      sourceRevision: run.headSHA,
      evidenceRefs: [proof],
      usage: zeroUsage,
    };
  });
  const deploymentResult = (run, row) => {
    if (row?.state === "succeeded") {
      if (row.commit_id !== run.headSHA)
        return {
          status: "blocked",
          reason: "Deployment belongs to a different revision",
        };
      return {
        status: "succeeded",
        healthPassed: true,
        revision: row.commit_id,
        deploymentId: row.job_id,
        url: run.configSnapshot.qaUrl,
        usage: zeroUsage,
      };
    }
    if (["blocked", "failed", "starting"].includes(row?.state))
      return {
        status: "blocked",
        reason: "Deployment needs reconciliation: " + row.state,
      };
    return { status: "pending" };
  };
  return {
    discover: journal(async ({ run }) => {
      const value = await task(run);
      return {
        status: "succeeded",
        isolated: true,
        revision: head(value),
        usage: zeroUsage,
      };
    }),
    implement: implementation,
    test: tests,
    deploy: {
      async reconcile({ run }) {
        const value = await task(run);
        const row = delivery.row(value.id);
        if (!row) return { status: "absent" };
        if (row.state === "ready") return { status: "absent" };
        if (row.state === "running")
          return deploymentResult(run, await delivery.advance(value));
        // Recheck published bytes on every final QA invocation in the QA bridge.
        return deploymentResult(run, row);
      },
      async execute({ run }) {
        const value = await task(run);
        if (!verifier.check(value).passed || head(value) !== run.headSHA)
          throw Error("Staging requires the verified revision");
        const row = delivery.prepare(value);
        if (row.state !== "ready") return deploymentResult(run, row);
        return deploymentResult(run, await delivery.advance(value));
      },
    },
  };
}
