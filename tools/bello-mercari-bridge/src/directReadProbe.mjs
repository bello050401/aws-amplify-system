import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { openExistingProductReadSession } from "./session.mjs";
import { latestReadTrafficEvidence } from "./trafficEvidence.mjs";
import { safeDirectReadProbeResult } from "./directReadProbeObserver.mjs";

// Each target needs its own normal read evidence and durable one-time claim.
const PINNED_TARGETS = new Map([
  ["2JXePE4ke8UCBTj6mxc4cf", { inventoryCode: "B005795" }],
  ["2JXjWPRVBxjZ2K2vgTGNqy", { inventoryCode: "B005757",
    shopId: "evkhihBFFNn5hukMS9s36H",
    requestId: "7ecb7f7837d93390fe5f701abdc62e9acfaf5b35b4b751789c4183a2a376e825" }],
]);
export const PINNED_READ_QUERY_SHA256 =
  "307abc058c96db65d9be11acda8b5f40bf69e91be21579e1b4fb219e7e5e05bf";
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const OUTCOMES = new Set(["MATCHED", "NO_EXACT_NORMAL_READ", "NORMAL_READ_UNVERIFIED",
  "REQUEST_CONTEXT_UNAVAILABLE", "DIRECT_HTTP_UNVERIFIED", "DIRECT_RESPONSE_UNVERIFIED",
  "DIRECT_AUTH_REQUIRED", "DIRECT_REQUEST_FAILED", "AUTH_REQUIRED",
  "NAVIGATION_UNVERIFIED", "READ_FAILED"]);

export function assertPinnedDirectReadTarget(target, requestId = null) {
  const pinned = PINNED_TARGETS.get(target?.remoteId);
  if (!pinned || !ID.test(target?.shopId) ||
      target.inventoryCode !== pinned.inventoryCode ||
      (pinned.shopId && target.shopId !== pinned.shopId) ||
      (requestId !== null && (!HASH.test(requestId) ||
        pinned.requestId && requestId !== pinned.requestId)))
    throw Error("Invalid pinned direct read target");
}

function paths(root, target, requestId = null) {
  if (!isAbsolute(root)) throw Error("Invalid pinned direct read root");
  assertPinnedDirectReadTarget(target, requestId);
  const key = createHash("sha256").update(`${target.shopId}:${target.remoteId}`).digest("hex");
  const dir = join(root, "direct-read-probe-once");
  return { dir, claim: join(dir, `${key}.json`), result: join(dir, `${key}.result.json`) };
}

function priorEvidenceReady(evidence) {
  return evidence.status === "OBSERVED" && evidence.readQueries.some(item =>
    item.operationName === "EditProductPage" &&
    item.querySha256 === PINNED_READ_QUERY_SHA256 &&
    item.variableShapeComplete === true && item.variableFields.length === 1 &&
    item.variableFields[0].field === "id" && item.variableFields[0].type === "string" &&
    item.requestProductMatch === "MATCH" && item.responseProductMatch === "MATCH" &&
    item.responseShopMatch === "MATCH" && item.httpStatus === 200 &&
    item.graphqlErrors === "NONE" && item.authPresenceObserved === true &&
    item.authPresence.cookie === true);
}

export async function directReadProbeAvailable(root, requestId, target) {
  paths(root, target, requestId);
  if (!HASH.test(requestId)) throw Error("Invalid read request identity");
  const [evidence, prior] = await Promise.all([
    latestReadTrafficEvidence(root, requestId), readDirectReadProbeOutcome(root, target),
  ]);
  return priorEvidenceReady(evidence) && !prior.claimed;
}

export async function readDirectReadProbeOutcome(root, target) {
  const path = paths(root, target);
  let claim;
  try { claim = JSON.parse(await readFile(path.claim, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return { claimed: false, outcome: null, httpStatus: null };
    return { claimed: true, outcome: null, httpStatus: null };
  }
  if (claim?.schemaVersion !== 1 || claim.operation !== "EXACT_READ_HTTP_PROBE_ONCE" ||
      typeof claim.attemptId !== "string")
    return { claimed: true, outcome: null, httpStatus: null };
  try {
    const result = JSON.parse(await readFile(path.result, "utf8"));
    if (result?.schemaVersion !== 1 || result.attemptId !== claim.attemptId ||
        !OUTCOMES.has(result.outcome) ||
        (result.httpStatus !== null && (!Number.isInteger(result.httpStatus) ||
          result.httpStatus < 100 || result.httpStatus > 599)))
      return { claimed: true, outcome: null, httpStatus: null };
    return { claimed: true, outcome: result.outcome, httpStatus: result.httpStatus };
  } catch { return { claimed: true, outcome: null, httpStatus: null }; }
}

/** Only a completed, pinned HTTP 200 read can be reported to BELLO. The older
 * one-time claim format has no request ID, so its exact target and the saved
 * normal-read evidence must both match the owned BELLO dispatch. */
export async function readDirectReadProbeProof(root, requestId, target) {
  const path = paths(root, target, requestId);
  if (!HASH.test(requestId)) throw Error("Invalid read request identity");
  const evidence = await latestReadTrafficEvidence(root, requestId);
  if (!priorEvidenceReady(evidence)) throw Error("Normal read evidence missing");
  const claim = JSON.parse(await readFile(path.claim, "utf8"));
  const result = JSON.parse(await readFile(path.result, "utf8"));
  if (claim?.schemaVersion !== 1 || claim.operation !== "EXACT_READ_HTTP_PROBE_ONCE" ||
      !UUID.test(claim.attemptId) || claim.querySha256 !== PINNED_READ_QUERY_SHA256 ||
      (claim.requestId !== undefined && claim.requestId !== requestId) ||
      result?.schemaVersion !== 1 || result.attemptId !== claim.attemptId ||
      result.outcome !== "MATCHED" || result.httpStatus !== 200 ||
      !Number.isFinite(Date.parse(claim.claimedAt)) ||
      !Number.isFinite(Date.parse(result.recordedAt)) ||
      Date.parse(result.recordedAt) < Date.parse(claim.claimedAt))
    throw Error("Pinned direct read proof is not confirmed");
  return { attemptId: claim.attemptId };
}

/** Explicit, one-time read probe. No query, variable, URL value, or credential is saved. */
export async function runPinnedDirectReadProbeOnce({ root, profileDir, playwrightModulePath,
  requestId, target, launchPersistentContext = null, probeWaitMs = 12000 }) {
  const path = paths(root, target, requestId);
  if (!HASH.test(requestId)) throw Error("Invalid read request identity");
  const evidence = await latestReadTrafficEvidence(root, requestId);
  if (!priorEvidenceReady(evidence)) throw Error("The pinned normal read is not proven");
  await mkdir(path.dir, { recursive: true });
  const attemptId = randomUUID();
  const handle = await open(path.claim, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ schemaVersion: 1,
      operation: "EXACT_READ_HTTP_PROBE_ONCE", attemptId, requestId,
      querySha256: PINNED_READ_QUERY_SHA256, claimedAt: new Date().toISOString() }) + "\n");
    await handle.sync();
  } finally { await handle.close(); }
  let result = { outcome: "READ_FAILED", httpStatus: null };
  let session = null;
  try {
    session = await openExistingProductReadSession({ root, profileDir,
      playwrightModulePath, shopId: target.shopId, remoteId: target.remoteId,
      launchPersistentContext, probeQuerySha256: PINNED_READ_QUERY_SHA256, probeWaitMs });
    result = session.state === "AUTH_REQUIRED" ?
      { outcome: "AUTH_REQUIRED", httpStatus: null } :
      session.state !== "NAVIGATED_UNVERIFIED" ?
        { outcome: "NAVIGATION_UNVERIFIED", httpStatus: null } :
        safeDirectReadProbeResult(await session.directReadProbe.probe());
  } catch { result = { outcome: "READ_FAILED", httpStatus: null }; }
  finally {
    session?.directReadProbe?.stop();
    try { await session?.context?.close(); } catch { /* The claim still prevents replay. */ }
  }
  const resultHandle = await open(path.result, "wx", 0o600);
  try {
    await resultHandle.writeFile(JSON.stringify({ schemaVersion: 1, attemptId,
      outcome: result.outcome, httpStatus: result.httpStatus,
      recordedAt: new Date().toISOString() }) + "\n");
    await resultHandle.sync();
  } finally { await resultHandle.close(); }
  return result;
}
