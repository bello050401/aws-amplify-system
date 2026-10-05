import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { safeWriteContractSummary } from "./writeContractObservation.mjs";

export const CREATE_TEST_TARGET = Object.freeze({
  kind: "CREATE_PRODUCT",
  shopId: "evkhihBFFNn5hukMS9s36H",
  sourceInventoryId: "c9ee4ea7-070f-491c-bd4c-c1547cb73436",
  inventoryCode: "B005757",
  skuCode: "B005757-TEST-20261004-caf445ac6e676343",
  existingRemoteId: "2JXdS6R5NNQPJadMexKmTr",
  excludedRemoteId: "2JXdS6R5NNQPJadMexKmTr",
  remoteId: null,
  expectedName: "BoConcept Jersey Side Table",
  priceYen: 98000,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const validCreateTestClaimedAt = value =>
  typeof value === "string" && ISO.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const KINDS = new Set(["MATCHED", "UNVERIFIED"]);
const PINNED = ["shopId", "sourceInventoryId", "inventoryCode", "skuCode",
  "existingRemoteId", "expectedName", "priceYen"];
const ATTEMPT_DIRS = ["private-create-test-once", "manual-image-once",
  "manual-save-once", "private-image-workflow-once", "direct-read-probe-once"];

function paths(root) {
  if (!isAbsolute(root)) throw Error("An absolute local queue root is required");
  const dir = join(root, "private-create-test-once");
  // One shop-scoped marker also excludes a concurrent candidate for another source item.
  const name = `${CREATE_TEST_TARGET.shopId}-private-create-once`;
  return { dir, claim: join(dir, `${name}.json`),
    result: join(dir, `${name}.result.json`) };
}

/** Review every known local attempt ledger without claiming remote SKU absence. */
export async function readCreateTestPreflight(root) {
  paths(root);
  let checkedRecords = 0;
  for (const name of ATTEMPT_DIRS) {
    let entries;
    try { entries = await readdir(join(root, name), { withFileTypes: true }); }
    catch (error) {
      if (error?.code === "ENOENT") continue;
      return { clear: false, reason: "LEDGER_UNVERIFIED", checkedRecords };
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json"))
        return { clear: false, reason: "LEDGER_UNVERIFIED", checkedRecords };
      // Any prior create marker or result means this one-shop test must be reconciled.
      if (name === "private-create-test-once")
        return { clear: false, reason: "PRIOR_CREATE_ATTEMPT", checkedRecords };
      if (entry.name.endsWith(".result.json")) continue;
      let record;
      try { record = JSON.parse(await readFile(join(root, name, entry.name), "utf8")); }
      catch { return { clear: false, reason: "LEDGER_UNVERIFIED", checkedRecords }; }
      if (!record || typeof record !== "object" || Array.isArray(record) ||
          typeof record.operation !== "string" || !UUID.test(record.attemptId ?? ""))
        return { clear: false, reason: "LEDGER_UNVERIFIED", checkedRecords };
      checkedRecords++;
      if (record.sourceInventoryId === CREATE_TEST_TARGET.sourceInventoryId ||
          record.skuCode === CREATE_TEST_TARGET.skuCode ||
          (/CREATE/i.test(record.operation) &&
            record.inventoryCode === CREATE_TEST_TARGET.inventoryCode))
        return { clear: false, reason: "PRIOR_CREATE_ATTEMPT", checkedRecords };
    }
  }
  return { clear: true, reason: "LOCAL_ATTEMPTS_CLEAR", checkedRecords };
}

async function writeOnce(path, record) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(record) + "\n", "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}

/** The claim is durable before any image selection or final UI save. */
export async function claimCreateTestOnce(root) {
  const preflight = await readCreateTestPreflight(root);
  if (!preflight.clear) throw Error(`Private-create preflight: ${preflight.reason}`);
  const path = paths(root);
  await mkdir(path.dir, { recursive: true });
  const record = { schemaVersion: 1, operation: "CREATE_PRIVATE_TEST_ONCE",
    attemptId: randomUUID(), ...Object.fromEntries(PINNED.map(key =>
      [key, CREATE_TEST_TARGET[key]])), claimedAt: new Date().toISOString() };
  await writeOnce(path.claim, record);
  return { attemptId: record.attemptId, claimedAt: record.claimedAt };
}

export async function readCreateTestClaim(root) {
  try {
    const record = JSON.parse(await readFile(paths(root).claim, "utf8"));
    const valid = record?.schemaVersion === 1 &&
      record.operation === "CREATE_PRIVATE_TEST_ONCE" && UUID.test(record.attemptId) &&
      validCreateTestClaimedAt(record.claimedAt) &&
      PINNED.every(key => record[key] === CREATE_TEST_TARGET[key]);
    return { claimed: true, valid, attemptId: valid ? record.attemptId : null,
      claimedAt: valid ? record.claimedAt : null };
  } catch (error) {
    if (error?.code === "ENOENT") return { claimed: false, valid: true,
      attemptId: null, claimedAt: null };
    return { claimed: true, valid: false, attemptId: null, claimedAt: null };
  }
}

/** Result is separate from BELLO ChannelListing and cannot unlock another attempt. */
export async function recordCreateTestObservation(root, attemptId, summary) {
  const claim = await readCreateTestClaim(root);
  if (!claim.claimed || !claim.valid || claim.attemptId !== attemptId)
    throw Error("Matching private-create claim is required");
  const safe = safeWriteContractSummary(summary);
  const matched = safe.status === "MATCHED" && safe.reason === "MATCHED" &&
    safe.expectedKind === "CREATE_PRODUCT" &&
    ID.test(safe.newRemoteId ?? "") &&
    safe.newRemoteId !== CREATE_TEST_TARGET.existingRemoteId;
  const persisted = matched ? safe : { ...safe, status: "UNVERIFIED",
    reason: safe.reason === "MATCHED" ? "RESPONSE_UNVERIFIED" : safe.reason,
    newRemoteId: null };
  const record = { schemaVersion: 1, attemptId,
    outcome: matched ? "OBSERVED_PRIVATE_CREATE_RESPONSE" : "UNVERIFIED",
    ...persisted, newRemoteId: matched ? safe.newRemoteId : null,
    listingConfirmed: false, recordedAt: new Date().toISOString() };
  await writeOnce(paths(root).result, record);
  return { outcome: record.outcome, newRemoteId: record.newRemoteId,
    listingConfirmed: false, reason: persisted.reason };
}

/** The GPT in-app tab has no request observer. Persist one explicit UI attempt
 * without claiming an HTTP response, product ID, privacy, or listing success. */
export async function recordCreateTestUiAttemptUnverified(root, attemptId) {
  return recordCreateTestObservation(root, attemptId, {
    status: "UNVERIFIED", reason: "NETWORK_NOT_OBSERVED",
    expectedKind: "CREATE_PRODUCT", observedKind: null, newRemoteId: null,
  });
}

export async function readCreateTestObservation(root) {
  const claim = await readCreateTestClaim(root);
  if (!claim.claimed || !claim.valid) return { claim, result: null };
  try {
    const record = JSON.parse(await readFile(paths(root).result, "utf8"));
    const safe = safeWriteContractSummary(record);
    if (record?.schemaVersion !== 1 || record.attemptId !== claim.attemptId ||
        !KINDS.has(record.status) || record.listingConfirmed !== false ||
        !["OBSERVED_PRIVATE_CREATE_RESPONSE", "UNVERIFIED"].includes(record.outcome) ||
        (record.outcome === "UNVERIFIED" &&
          (safe.status !== "UNVERIFIED" || record.newRemoteId !== null)) ||
        (record.outcome === "OBSERVED_PRIVATE_CREATE_RESPONSE" &&
          (safe.status !== "MATCHED" || safe.expectedKind !== "CREATE_PRODUCT" ||
            !ID.test(record.newRemoteId ?? "") ||
            record.newRemoteId === CREATE_TEST_TARGET.existingRemoteId)))
      return { claim, result: null };
    return { claim, result: { outcome: record.outcome,
      newRemoteId: record.outcome === "OBSERVED_PRIVATE_CREATE_RESPONSE" ?
        record.newRemoteId : null, listingConfirmed: false, reason: safe.reason } };
  } catch { return { claim, result: null }; }
}
