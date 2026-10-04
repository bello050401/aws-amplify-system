import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const HASH = /^[a-f0-9]{64}$/;
const RESULTS = new Set(["CONFIRMED_PRIVATE_WITH_IMAGE", "UNKNOWN", "AUTH_REQUIRED"]);
const STAGES = new Set(["IMAGE_CLAIMED", "FILE_SELECTION_UNCERTAIN", "TWO_IMAGES_VISIBLE",
  "SAVE_CLAIMED", "NEXT_CLICK_UNCERTAIN", "PRIVATE_CLICK_UNCERTAIN",
  "PRIVATE_CLICK_RETURNED", "SAVE_ACK_UNVERIFIED", "READBACK_UNVERIFIED",
  "PRIVATE_READBACK_CONFIRMED", "AUTH_REQUIRED"]);

function paths(root, target) {
  if (!root || !isAbsolute(root) || ["shopId", "remoteId", "inventoryCode"].some(key =>
      typeof target?.[key] !== "string" || !ID.test(target[key])) ||
      !Number.isSafeInteger(target.priceYen) || target.priceYen < 0 ||
      !Number.isSafeInteger(target.quantity) || target.quantity < 0)
    throw Error("Invalid private-image workflow target");
  const dir = join(root, "private-image-workflow-once");
  const base = `${target.shopId}-${target.remoteId}`;
  return { dir, image: join(dir, `${base}.image.json`),
    save: join(dir, `${base}.save.json`), result: join(dir, `${base}.result.json`) };
}

async function writeOnce(path, value) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value) + "\n", "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}

export async function readPrivateImageWorkflowClaim(root, target) {
  const path = paths(root, target).image;
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return { claimed: true, valid: value?.schemaVersion === 1 &&
      value?.operation === "SELECT_IMAGE_AND_PRIVATE_SAVE_ONCE" &&
      value.shopId === target.shopId && value.remoteId === target.remoteId &&
      value.inventoryCode === target.inventoryCode && value.priceYen === target.priceYen &&
      value.quantity === target.quantity && HASH.test(value.imageSha256) &&
      typeof value.attemptId === "string", attemptId: value?.attemptId ?? null };
  } catch (error) {
    if (error?.code === "ENOENT") return { claimed: false, valid: true };
    return { claimed: true, valid: false };
  }
}

export async function claimPrivateImageWorkflow(root, target, imageSha256) {
  if (!HASH.test(imageSha256)) throw Error("Invalid private-image workflow hash");
  const path = paths(root, target);
  await mkdir(path.dir, { recursive: true });
  const claim = { schemaVersion: 1, operation: "SELECT_IMAGE_AND_PRIVATE_SAVE_ONCE",
    attemptId: randomUUID(), shopId: target.shopId, remoteId: target.remoteId,
    inventoryCode: target.inventoryCode, priceYen: target.priceYen,
    quantity: target.quantity, imageSha256, claimedAt: new Date().toISOString() };
  await writeOnce(path.image, claim);
  return claim;
}

/** A separate durable boundary for the explicit private-save stage. */
export async function claimPrivateImageSaveStage(root, target, imageAttemptId) {
  if (!/^[0-9a-f-]{36}$/i.test(imageAttemptId)) throw Error("Invalid image attempt ID");
  const imageClaim = await readPrivateImageWorkflowClaim(root, target);
  if (!imageClaim.claimed || !imageClaim.valid || imageClaim.attemptId !== imageAttemptId)
    throw Error("Matching image-selection claim is required before private save");
  const path = paths(root, target);
  const claim = { schemaVersion: 1, operation: "PRIVATE_SAVE_AFTER_IMAGE_ONCE",
    attemptId: randomUUID(), imageAttemptId,
    shopId: target.shopId, remoteId: target.remoteId,
    claimedAt: new Date().toISOString() };
  await writeOnce(path.save, claim);
  return claim;
}

export async function writePrivateImageWorkflowResult(root, target, attemptId, status, stage) {
  if (!/^[0-9a-f-]{36}$/i.test(attemptId) || !RESULTS.has(status) || !STAGES.has(stage))
    throw Error("Invalid private-image workflow result");
  await writeOnce(paths(root, target).result, { schemaVersion: 1,
    attemptId, status, stage, recordedAt: new Date().toISOString() });
}

export async function readPrivateImageWorkflowResult(root, target) {
  const claim = await readPrivateImageWorkflowClaim(root, target);
  if (!claim.claimed || !claim.valid) return null;
  try {
    const value = JSON.parse(await readFile(paths(root, target).result, "utf8"));
    return value?.schemaVersion === 1 && value.attemptId === claim.attemptId &&
      RESULTS.has(value.status) && STAGES.has(value.stage) ?
      { status: value.status, stage: value.stage } : null;
  } catch { return null; }
}
