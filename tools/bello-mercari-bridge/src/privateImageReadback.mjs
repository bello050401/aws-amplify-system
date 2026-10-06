import { isAbsolute } from "node:path";
import { openExistingProductReadSession } from "./session.mjs";
import { readPinnedEditFields } from "./saveExistingPrivateOnce.mjs";
import { readExistingUploadedImages } from "./addExistingImageOnce.mjs";
import { privateFromExactListRow } from "./existingProductReader.mjs";
import { isPinnedB005757ImageTarget } from "./privateImagePreflight.mjs";
import { readPrivateImageWorkflowClaim, readPrivateImageWorkflowResult } from
  "./privateImageWorkflowAttempt.mjs";

function authRequired(page) {
  try {
    const url = new URL(page?.url());
    return url.origin === "https://mercari-shops.com" &&
      url.pathname.startsWith("/signin/");
  } catch { return false; }
}

async function exactPrivate(page, target, expectedUrl, title) {
  const result = await privateFromExactListRow(page, target.shopId, expectedUrl, title);
  return result.value.kind === "OBSERVED" && result.value.value === "PRIVATE" &&
    page.url() === expectedUrl;
}

function stableImages(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after) ||
      before.length !== after.length || ![1, 2].includes(before.length)) return false;
  const key = image => `${image.pathHash}:${image.width}:${image.height}`;
  const first = before.map(key);
  return first.every(value => /^[a-f0-9]{64}:[1-9]\d*:[1-9]\d*$/.test(value)) &&
    new Set(first).size === first.length &&
    first.sort().join("|") === after.map(key).sort().join("|");
}

/** A fresh exact-product read after an uncertain image selection. No upload, save, or claim. */
export async function verifyPrivateImageWorkflowReadOnly({ root, profileDir,
  playwrightModulePath, requestId, target, launchPersistentContext = null }, {
    readClaim = readPrivateImageWorkflowClaim,
    readResult = readPrivateImageWorkflowResult,
    openSession = openExistingProductReadSession,
    readFields = readPinnedEditFields,
    readImages = readExistingUploadedImages,
    checkPrivate = exactPrivate,
  } = {}) {
  if (![root, profileDir, playwrightModulePath].every(value =>
        typeof value === "string" && isAbsolute(value)) ||
      !isPinnedB005757ImageTarget(target, requestId))
    throw Error("Invalid private-image readback target");
  const claim = await readClaim(root, target);
  const prior = await readResult(root, target);
  if (!claim.claimed || !claim.valid || prior?.status !== "UNKNOWN" ||
      prior.stage !== "FILE_SELECTION_UNCERTAIN")
    return { status: "NO_ELIGIBLE_ATTEMPT" };
  const expectedUrl = `https://mercari-shops.com/seller/shops/${target.shopId}/products/${target.remoteId}/edit`;
  let session = null;
  try {
    session = await openSession({ root, profileDir, playwrightModulePath,
      shopId: target.shopId, remoteId: target.remoteId, launchPersistentContext });
    if (session.state === "AUTH_REQUIRED") return { status: "AUTH_REQUIRED" };
    if (session.state !== "NAVIGATED_UNVERIFIED") return { status: "UNVERIFIED" };
    const fields = await readFields(session.page, expectedUrl, target);
    const images = await readImages(session.page, expectedUrl);
    if (!fields || !images || !await checkPrivate(session.page, target, expectedUrl,
      fields.title)) return { status: authRequired(session.page) ? "AUTH_REQUIRED" : "UNVERIFIED" };
    const again = await readFields(session.page, expectedUrl, target);
    const imagesAgain = await readImages(session.page, expectedUrl);
    if (!again || again.title !== fields.title || !stableImages(images, imagesAgain) ||
        session.page.url() !== expectedUrl)
      return { status: authRequired(session.page) ? "AUTH_REQUIRED" : "UNVERIFIED" };
    return { status: images.length === 1 ? "PRIVATE_ONE_IMAGE_OBSERVED" :
      "PRIVATE_TWO_IMAGES_UNATTRIBUTED" };
  } catch {
    return { status: authRequired(session?.page) ? "AUTH_REQUIRED" : "UNVERIFIED" };
  } finally {
    if (session) { try { await session.context.close(); } catch { /* Read result stands. */ } }
  }
}
