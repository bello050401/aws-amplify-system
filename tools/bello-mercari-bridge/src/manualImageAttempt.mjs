import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const HASH = /^[a-f0-9]{64}$/;
const OUTCOMES = new Set(["UNKNOWN", "BLOCKED_BEFORE_SELECT"]);
const DIAGNOSTICS = new Set(["CLAIMED_BEFORE_SELECT", "FILE_INPUT_CHECK",
  "FINAL_TARGET_CHECK", "FILE_SELECT_UNCERTAIN", "FILE_SELECT_RETURNED",
  "ORIGINAL_IMAGE_NOT_OBSERVED", "ADDED_IMAGE_UI_OBSERVED"]);

function markerPath(root, target) {
  if (!isAbsolute(root) || ["shopId", "remoteId", "inventoryCode"].some(key =>
      typeof target?.[key] !== "string" || !ID.test(target[key])) ||
      !Number.isSafeInteger(target.priceYen) || target.priceYen < 0 ||
      !Number.isSafeInteger(target.quantity) || target.quantity < 0)
    throw Error("Invalid existing-product image target");
  return join(root, "manual-image-once", `${target.shopId}-${target.remoteId}.json`);
}

export async function claimManualImageOnce(root, target, sha256) {
  if (!HASH.test(sha256)) throw Error("Invalid pinned image hash");
  const path = markerPath(root, target);
  await mkdir(join(root, "manual-image-once"), { recursive: true });
  const record = { schemaVersion: 1, operation: "ADD_EXISTING_IMAGE_ONCE",
    attemptId: randomUUID(), shopId: target.shopId, remoteId: target.remoteId,
    inventoryCode: target.inventoryCode, priceYen: target.priceYen,
    quantity: target.quantity, imageSha256: sha256, claimedAt: new Date().toISOString() };
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(record) + "\n", "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  return record;
}

export async function readManualImageClaim(root, target, sha256) {
  const path = markerPath(root, target);
  try {
    const record = JSON.parse(await readFile(path, "utf8"));
    const valid = record?.schemaVersion === 1 && record.operation === "ADD_EXISTING_IMAGE_ONCE" &&
      record.shopId === target.shopId && record.remoteId === target.remoteId &&
      record.inventoryCode === target.inventoryCode && record.priceYen === target.priceYen &&
      record.quantity === target.quantity && record.imageSha256 === sha256 &&
      typeof record.attemptId === "string";
    return { claimed: true, valid, attemptId: valid ? record.attemptId : null };
  } catch (error) {
    if (error?.code === "ENOENT") return { claimed: false, valid: true };
    return { claimed: true, valid: false };
  }
}

export async function writeManualImageOutcome(root, target, attemptId, outcome, diagnostic) {
  if (!/^[0-9a-f-]{36}$/i.test(attemptId) || !OUTCOMES.has(outcome) || !DIAGNOSTICS.has(diagnostic))
    throw Error("Invalid image-attempt result");
  const path = markerPath(root, target).replace(/\.json$/, ".result.json");
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, attemptId, outcome,
    diagnostic, recordedAt: new Date().toISOString() }) + "\n", "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}

export async function readManualImageOutcome(root, target, sha256) {
  const claim = await readManualImageClaim(root, target, sha256);
  if (!claim.claimed || !claim.valid) return null;
  const path = markerPath(root, target).replace(/\.json$/, ".result.json");
  try {
    const record = JSON.parse(await readFile(path, "utf8"));
    return record?.schemaVersion === 1 && record.attemptId === claim.attemptId &&
      OUTCOMES.has(record.outcome) && DIAGNOSTICS.has(record.diagnostic) ?
      { outcome: record.outcome, diagnostic: record.diagnostic } : null;
  } catch { return null; }
}
