import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { openExistingProductReadSession } from "./session.mjs";
import { readPinnedEditFields } from "./saveExistingPrivateOnce.mjs";
import { readExistingUploadedImages } from "./addExistingImageOnce.mjs";
import { privateFromExactListRow } from "./existingProductReader.mjs";
import { readManualImageClaim, readManualImageOutcome } from "./manualImageAttempt.mjs";
import { readManualSaveClaim, readManualSaveOutcome } from "./manualSaveAttempt.mjs";

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f-]{36}$/i;
const STATUSES = new Set(["OBSERVED_PRIVATE_TWO_IMAGES", "UNKNOWN", "AUTH_REQUIRED"]);

function resultPath(root, target) {
  if (!isAbsolute(root) || ["shopId", "remoteId", "inventoryCode"].some(key =>
      !ID.test(target?.[key] ?? "")) || !Number.isSafeInteger(target?.priceYen) ||
      target.priceYen < 0 || !Number.isSafeInteger(target?.quantity) || target.quantity < 0)
    throw Error("Invalid saved-product readback target");
  return join(root, "existing-saved-product-readback", `${target.shopId}-${target.remoteId}.json`);
}

async function priorRecords(root, target, imageSha256) {
  if (!HASH.test(imageSha256)) throw Error("Invalid existing image proof");
  const [imageClaim, saveClaim, imageOutcome, saveOutcome] = await Promise.all([
    readManualImageClaim(root, target, imageSha256), readManualSaveClaim(root, target),
    readManualImageOutcome(root, target, imageSha256), readManualSaveOutcome(root, target),
  ]);
  return imageClaim.claimed && imageClaim.valid && UUID.test(imageClaim.attemptId ?? "") &&
    saveClaim.claimed && saveClaim.valid && UUID.test(saveClaim.attemptId ?? "") ?
    { imageAttemptId: imageClaim.attemptId, saveAttemptId: saveClaim.attemptId,
      imageOutcome: imageOutcome?.outcome ?? "UNRECORDED",
      saveOutcome: saveOutcome?.outcome ?? "UNRECORDED" } : null;
}

async function exactPrivate(page, target, expectedUrl, title) {
  const result = await privateFromExactListRow(page, target.shopId, expectedUrl, title);
  return result.value.kind === "OBSERVED" && result.value.value === "PRIVATE" &&
    page.url() === expectedUrl;
}

function matchingTwoImages(before, after) {
  if (before?.length !== 2 || after?.length !== 2 ||
      before[0].pathHash === before[1].pathHash) return false;
  const key = image => `${image.pathHash}:${image.width}:${image.height}`;
  return before.map(key).sort().join("|") === after.map(key).sort().join("|");
}

/** Read only. Existing attempt IDs correlate records; they do not prove which save caused the state. */
export async function verifyExistingSavedProductReadOnly({ root, profileDir, playwrightModulePath,
  target, imageSha256, launchPersistentContext = null }, {
    openSession = openExistingProductReadSession, readFields = readPinnedEditFields,
    readImages = readExistingUploadedImages, checkPrivate = exactPrivate,
  } = {}) {
  const path = resultPath(root, target);
  const prior = await priorRecords(root, target, imageSha256);
  if (!prior) return { status: "PRIOR_ATTEMPT_MISMATCH" };
  const expectedUrl = `https://mercari-shops.com/seller/shops/${target.shopId}/products/${target.remoteId}/edit`;
  let session = null;
  let status = "UNKNOWN";
  try {
    session = await openSession({ root, profileDir, playwrightModulePath,
      shopId: target.shopId, remoteId: target.remoteId, launchPersistentContext });
    if (session.state === "AUTH_REQUIRED") status = "AUTH_REQUIRED";
    else if (session.state === "NAVIGATED_UNVERIFIED") {
      const before = await readFields(session.page, expectedUrl, target);
      const imagesBefore = await readImages(session.page, expectedUrl);
      if (before && imagesBefore?.length === 2 &&
          await checkPrivate(session.page, target, expectedUrl, before.title)) {
        const after = await readFields(session.page, expectedUrl, target);
        const imagesAfter = await readImages(session.page, expectedUrl);
        if (after?.title === before.title && matchingTwoImages(imagesBefore, imagesAfter) &&
            session.page.url() === expectedUrl) status = "OBSERVED_PRIVATE_TWO_IMAGES";
      }
    }
  } catch { status = "UNKNOWN"; }
  finally { if (session) { try { await session.context.close(); } catch { /* Read result still stands. */ } } }
  const record = { schemaVersion: 1, shopId: target.shopId, remoteId: target.remoteId,
    inventoryCode: target.inventoryCode, priceYen: target.priceYen,
    quantity: target.quantity, imageSha256, ...prior, status,
    readAt: new Date().toISOString() };
  await mkdir(join(root, "existing-saved-product-readback"), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(record) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  return { status, imageOutcome: prior.imageOutcome, saveOutcome: prior.saveOutcome };
}

export async function readExistingSavedProductReadback(root, target, imageSha256) {
  const path = resultPath(root, target);
  const prior = await priorRecords(root, target, imageSha256);
  if (!prior) return null;
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value?.schemaVersion === 1 && value.shopId === target.shopId &&
      value.remoteId === target.remoteId && value.inventoryCode === target.inventoryCode &&
      value.priceYen === target.priceYen && value.quantity === target.quantity &&
      value.imageSha256 === imageSha256 && value.imageAttemptId === prior.imageAttemptId &&
      value.saveAttemptId === prior.saveAttemptId && STATUSES.has(value.status) &&
      value.imageOutcome === prior.imageOutcome && value.saveOutcome === prior.saveOutcome ?
      { status: value.status, imageOutcome: prior.imageOutcome,
        saveOutcome: prior.saveOutcome } : null;
  } catch { return null; }
}
