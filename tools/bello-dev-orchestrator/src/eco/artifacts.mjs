import { hash } from "./policy.mjs";
import { safeEvidence } from "./cache.mjs";
const sections = {
  spec: [
    "problem",
    "purpose",
    "scope",
    "steps",
    "expected",
    "actual",
    "environment",
    "requirements",
    "acceptanceCriteria",
    "risk",
    "tests",
    "rollback",
    "unresolved",
  ],
  implementation: [
    "specId",
    "specRevision",
    "baseSHA",
    "headSHA",
    "worktreeDigest",
    "changes",
    "acceptanceCriteria",
    "tests",
    "build",
    "deployment",
    "rollback",
    "remaining",
  ],
  qa: [
    "specId",
    "deploymentId",
    "url",
    "revision",
    "browser",
    "viewport",
    "accountType",
    "acceptanceCriteria",
    "findings",
    "verdict",
    "reason",
  ],
  clarification: ["specId", "specRevision", "question", "deadline"],
};
export function validateArtifact(
  a,
  { runId, revision, evidenceRoot, acIds = [] },
) {
  if (
    a.schemaVersion !== 1 ||
    a.runId !== runId ||
    a.revision !== revision ||
    !sections[a.kind] ||
    !a.producer ||
    !Array.isArray(a.parentArtifactIds)
  )
    throw Error("Artifact schema/run/revision mismatch");
  if (
    sections[a.kind].some(
      (k) => a.body?.[k] === undefined || a.body[k] === null,
    )
  )
    throw Error("Missing required artifact field");
  if (!Array.isArray(a.evidenceRefs)) throw Error("Evidence list required");
  const evidence = a.evidenceRefs.map((r) => safeEvidence(evidenceRoot, r));
  if (a.kind === "qa") {
    if (
      !["PASS", "FAIL", "BLOCKED"].includes(a.body.verdict) ||
      !Array.isArray(a.body.acceptanceCriteria)
    )
      throw Error("Invalid QA verdict");
    const rows = a.body.acceptanceCriteria;
    const ids = rows.map((x) => x.id);
    if (
      new Set(ids).size !== ids.length ||
      acIds.some((id) => !ids.includes(id)) ||
      ids.some((id) => !acIds.includes(id))
    )
      throw Error("AC coverage mismatch");
    if (
      rows.some(
        (x) =>
          !["PASS", "FAIL", "BLOCKED", "NOT_RUN"].includes(x.result) ||
          !Array.isArray(x.steps) ||
          !Array.isArray(x.evidenceRefs) ||
          x.evidenceRefs.some((r) => !a.evidenceRefs.includes(r)),
      )
    )
      throw Error("Invalid QA evidence");
    if (
      a.body.verdict === "PASS" &&
      (!rows.length ||
        rows.some(
          (x) =>
            x.result !== "PASS" || !x.steps.length || !x.evidenceRefs.length,
        ) ||
        !evidence.length)
    )
      throw Error("Unverified QA cannot pass");
  }
  return { ...a, digest: hash(a), evidence };
}
export function renderArtifact(a) {
  return (
    "---\n" +
    JSON.stringify({
      schema_version: 1,
      artifact_id: a.id,
      run_id: a.runId,
      revision: a.revision,
      producer: a.producer,
      input_artifacts: a.parentArtifactIds,
      status: "accepted",
    }) +
    "\n---\n\n" +
    Object.entries(a.body)
      .map(
        ([k, v]) =>
          "## " +
          k +
          "\n\n" +
          (typeof v === "string" ? v : JSON.stringify(v, null, 2)),
      )
      .join("\n\n")
  );
}
