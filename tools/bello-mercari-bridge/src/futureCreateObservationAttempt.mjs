import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { bindAccount } from "./queue.mjs";
import { buildPrivateCreatePreparation, PRIVATE_CREATE_SHOP_ID } from
  "./privateCreatePreparation.mjs";
import { safeFutureCreateTrafficSummary } from "./futureCreateTrafficObservation.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BLOCKED_INVENTORY_ID = "c9ee4ea7-070f-491c-bd4c-c1547cb73436";
const BLOCKED_CODES = new Set(["B005757", "B005795"]);
const digest = value => createHash("sha256").update(value).digest("hex");

function paths(root, inventoryId) {
  if (typeof root !== "string" || !isAbsolute(root) || !UUID.test(inventoryId))
    throw Error("Valid absolute observation root and inventory ID required");
  const dir = join(root, "future-private-create-observation-once");
  const name = `${PRIVATE_CREATE_SHOP_ID}-once`;
  return { prepared: join(root, "private-create-prepared", `${inventoryId}.json`),
    dir, claim: join(dir, `${name}.claim.json`),
    result: join(dir, `${name}.result.json`) };
}

async function writeOnce(path, value) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value) + "\n", "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}

/** Consumes the one-shop attempt before any browser navigation or possible autosave. */
export async function claimFutureCreateObservationOnce(root, inventoryId) {
  const path = paths(root, inventoryId);
  await bindAccount(root, PRIVATE_CREATE_SHOP_ID);
  let job;
  try {
    const raw = await readFile(path.prepared, "utf8");
    if (Buffer.byteLength(raw) > 65536) throw Error("Invalid size");
    job = JSON.parse(raw);
    const expected = buildPrivateCreatePreparation(JSON.parse(job.snapshotJson));
    if (Object.keys(expected).sort().join(",") !== Object.keys(job).sort().join(",") ||
        Object.keys(expected).some(key => expected[key] !== job[key]))
      throw Error("Invalid preparation");
  } catch { throw Error("PREPARED_PRIVATE_CREATE_UNVERIFIED"); }
  if (job.shopId !== PRIVATE_CREATE_SHOP_ID || job.inventoryId !== inventoryId ||
      job.status !== "PREPARED_NO_SEND" || job.remoteId !== null ||
      job.listingConfirmed !== false || inventoryId === BLOCKED_INVENTORY_ID ||
      BLOCKED_CODES.has(JSON.parse(job.snapshotJson).inventoryCode))
    throw Error("FUTURE_CREATE_TARGET_BLOCKED");
  const claim = { schemaVersion: 1, operation: "OBSERVE_FUTURE_PRIVATE_CREATE_ONCE",
    attemptId: randomUUID(), shopId: PRIVATE_CREATE_SHOP_ID,
    inventoryFingerprint: digest(inventoryId),
    snapshotFingerprint: job.snapshotFingerprint, remoteProductId: null,
    remoteDraftId: null, outcome: "UNKNOWN", listingConfirmed: false,
    claimedAt: new Date().toISOString() };
  await mkdir(path.dir, { recursive: true });
  try { await writeOnce(path.claim, claim); }
  catch (error) {
    if (error?.code === "EEXIST") throw Error("FUTURE_CREATE_ATTEMPT_ALREADY_CLAIMED");
    throw Error("FUTURE_CREATE_CLAIM_UNAVAILABLE");
  }
  return { attemptId: claim.attemptId, shopId: claim.shopId,
    outcome: claim.outcome, listingConfirmed: false };
}

/** Persist only bounded, revalidated traffic metadata. No result can authorize replay. */
export async function recordFutureCreateObservationOnce(root, inventoryId,
  attemptId, observation) {
  const path = paths(root, inventoryId);
  let claim;
  try { claim = JSON.parse(await readFile(path.claim, "utf8")); }
  catch { throw Error("FUTURE_CREATE_CLAIM_UNVERIFIED"); }
  if (!UUID.test(attemptId) || claim?.schemaVersion !== 1 ||
      claim.operation !== "OBSERVE_FUTURE_PRIVATE_CREATE_ONCE" ||
      claim.attemptId !== attemptId ||
      claim.inventoryFingerprint !== digest(inventoryId) ||
      claim.shopId !== PRIVATE_CREATE_SHOP_ID)
    throw Error("FUTURE_CREATE_CLAIM_UNVERIFIED");
  const safe = safeFutureCreateTrafficSummary(observation);
  if (!safe) throw Error("FUTURE_CREATE_OBSERVATION_UNVERIFIED");
  const result = { schemaVersion: 1, attemptId, outcome: "OBSERVED_UNVERIFIED",
    ...safe, listingConfirmed: false, recordedAt: new Date().toISOString() };
  try { await writeOnce(path.result, result); }
  catch (error) {
    if (error?.code === "EEXIST") throw Error("FUTURE_CREATE_OBSERVATION_ALREADY_RECORDED");
    throw Error("FUTURE_CREATE_OBSERVATION_UNAVAILABLE");
  }
  return { outcome: result.outcome, listingConfirmed: false,
    eventCount: result.events.length, unknownDraftCount: result.draftIds.length };
}
