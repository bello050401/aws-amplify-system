import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const DIAGNOSTICS = new Set(["CLAIMED_BEFORE_NEXT", "NEXT_CONTROL_CHECK",
  "NEXT_CLICK_UNCERTAIN", "POST_NEXT_FIELDS_CHECK", "PRIVATE_CONTROL_CHECK",
  "PRIVATE_CLICK_UNCERTAIN", "PRIVATE_CLICK_RETURNED"]);

function attemptPath(root, target) {
  if (!root || !isAbsolute(root) ||
      ["shopId", "remoteId", "inventoryCode"].some(key =>
        typeof target?.[key] !== "string" || !ID.test(target[key])) ||
      !Number.isSafeInteger(target.priceYen) || target.priceYen < 0 ||
      !Number.isSafeInteger(target.quantity) || target.quantity < 0)
    throw Error("Invalid exact-product save target");
  return join(root, "manual-save-once", `${target.shopId}-${target.remoteId}.json`);
}

/** The marker survives crashes and never expires. Existing or uncertain attempts cannot be replayed. */
export async function claimManualSaveOnce(root, target) {
  const path = attemptPath(root, target);
  await mkdir(join(root, "manual-save-once"), { recursive: true });
  const record = { schemaVersion: 1, operation: "NO_CHANGE_PRIVATE_SAVE_ONCE",
    attemptId: randomUUID(), shopId: target.shopId, remoteId: target.remoteId,
    inventoryCode: target.inventoryCode, priceYen: target.priceYen,
    quantity: target.quantity, claimedAt: new Date().toISOString() };
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(record) + "\n", "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  return record;
}

export async function readManualSaveClaim(root, target) {
  const path = attemptPath(root, target);
  try {
    const record = JSON.parse(await readFile(path, "utf8"));
    if (record?.schemaVersion !== 1 || record.operation !== "NO_CHANGE_PRIVATE_SAVE_ONCE" ||
        record.shopId !== target.shopId || record.remoteId !== target.remoteId ||
        record.inventoryCode !== target.inventoryCode || record.priceYen !== target.priceYen ||
        record.quantity !== target.quantity || typeof record.attemptId !== "string")
      return { claimed: true, valid: false };
    return { claimed: true, valid: true, attemptId: record.attemptId,
      claimedAt: record.claimedAt };
  } catch (error) {
    if (error?.code === "ENOENT") return { claimed: false, valid: true };
    return { claimed: true, valid: false };
  }
}

/** Results are separate; a result failure never removes the irreversible attempt marker. */
export async function writeManualSaveOutcome(root, target, attemptId, outcome,
  { postflightPrivate = false, diagnostic = null } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(attemptId) ||
      !["CONFIRMED_PRIVATE", "UNKNOWN", "BLOCKED_BEFORE_CLICK"].includes(outcome) ||
      typeof postflightPrivate !== "boolean" ||
      (diagnostic !== null && !DIAGNOSTICS.has(diagnostic)))
    throw Error("Invalid save outcome");
  const path = attemptPath(root, target).replace(/\.json$/, ".result.json");
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, attemptId, outcome,
    postflightPrivate, diagnostic,
    recordedAt: new Date().toISOString() }) + "\n", "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}

export async function readManualSaveOutcome(root, target) {
  const claim = await readManualSaveClaim(root, target);
  if (!claim.claimed || !claim.valid) return null;
  const path = attemptPath(root, target).replace(/\.json$/, ".result.json");
  try {
    const record = JSON.parse(await readFile(path, "utf8"));
    if (record?.schemaVersion !== 1 || record.attemptId !== claim.attemptId ||
        !["CONFIRMED_PRIVATE", "UNKNOWN", "BLOCKED_BEFORE_CLICK"].includes(record.outcome) ||
        typeof record.postflightPrivate !== "boolean" ||
        (record.diagnostic !== undefined && record.diagnostic !== null &&
         !DIAGNOSTICS.has(record.diagnostic))) return null;
    return { outcome: record.outcome, postflightPrivate: record.postflightPrivate,
      diagnostic: record.diagnostic ?? null };
  } catch { return null; }
}
