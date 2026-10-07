import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { openExistingProductReadSession } from "./session.mjs";
import { readPinnedEditFields } from "./saveExistingPrivateOnce.mjs";
import { readExistingUploadedImages, exactSingleImageInput } from "./addExistingImageOnce.mjs";
import { privateFromExactListRow } from "./existingProductReader.mjs";
import { inspectExistingImage } from "./prepareExistingImage.mjs";
import { CREATE_TEST_TARGET } from "./createTestAttempt.mjs";

const HASH = /^[a-f0-9]{64}$/;
export const PINNED_B005757_REMOTE_ID = "2JXjWPRVBxjZ2K2vgTGNqy";
const PINNED_B005757_REQUEST_ID =
  "7ecb7f7837d93390fe5f701abdc62e9acfaf5b35b4b751789c4183a2a376e825";
const blocked = reasonCode => ({ status: "PREFLIGHT_BLOCKED", reasonCode });

export function isPinnedB005757ImageTarget(target, requestId) {
  return requestId === PINNED_B005757_REQUEST_ID && target !== null &&
    typeof target === "object" && !Array.isArray(target) &&
    Object.keys(target).sort().join(",") ===
      "inventoryCode,priceYen,quantity,remoteId,shopId,skuCode" &&
    target.shopId === CREATE_TEST_TARGET.shopId &&
    target.remoteId === PINNED_B005757_REMOTE_ID &&
    target.inventoryCode === CREATE_TEST_TARGET.inventoryCode &&
    target.skuCode === CREATE_TEST_TARGET.skuCode &&
    target.priceYen === CREATE_TEST_TARGET.priceYen && target.quantity === 1;
}

async function exactPrivate(page, target, expectedUrl, title) {
  const result = await privateFromExactListRow(page, target.shopId, expectedUrl, title);
  return result.value.kind === "OBSERVED" && result.value.value === "PRIVATE" &&
    page.url() === expectedUrl;
}

function authRequired(page) {
  try {
    const url = new URL(page?.url());
    return url.origin === "https://mercari-shops.com" && url.pathname.startsWith("/signin/");
  } catch { return false; }
}

/** Read-only rehearsal of the existing image workflow guards. No claim, file selection, or save. */
export async function inspectPrivateImagePreflight({ root, profileDir, playwrightModulePath,
  requestId, target, imagePath, imageSha256, launchPersistentContext = null }, {
    openSession = openExistingProductReadSession, readFields = readPinnedEditFields,
    readImages = readExistingUploadedImages, checkPrivate = exactPrivate,
    fileInput = exactSingleImageInput,
  } = {}) {
  if (![root, profileDir, playwrightModulePath, imagePath].every(value =>
        typeof value === "string" && isAbsolute(value)) ||
      !isPinnedB005757ImageTarget(target, requestId) || !HASH.test(imageSha256))
    throw Error("Invalid exact private-image preflight target");
  try {
    inspectExistingImage(await readFile(imagePath),
      { inventoryCode: target.inventoryCode, expectedSha256: imageSha256 });
  } catch { return blocked("IMAGE_PROOF_UNVERIFIED"); }
  const expectedUrl = `https://mercari-shops.com/seller/shops/${target.shopId}/products/${target.remoteId}/edit`;
  let session = null;
  try {
    session = await openSession({ root, profileDir, playwrightModulePath,
      shopId: target.shopId, remoteId: target.remoteId, launchPersistentContext });
    const stop = reasonCode => authRequired(session.page) ?
      { status: "AUTH_REQUIRED", reasonCode: "LOGIN_REQUIRED" } : blocked(reasonCode);
    if (session.state === "AUTH_REQUIRED") return { status: "AUTH_REQUIRED", reasonCode: "LOGIN_REQUIRED" };
    if (session.state !== "NAVIGATED_UNVERIFIED") return stop("NAVIGATION_UNVERIFIED");
    const fields = await readFields(session.page, expectedUrl, target);
    if (!fields) return stop("FIELDS_UNVERIFIED");
    const images = await readImages(session.page, expectedUrl);
    if (images?.length !== 1 || !HASH.test(images[0].pathHash))
      return stop("ORIGINAL_IMAGE_UNVERIFIED");
    if (!await checkPrivate(session.page, target, expectedUrl, fields.title))
      return stop("PRIVATE_STATE_UNVERIFIED");
    const again = await readFields(session.page, expectedUrl, target);
    const imagesAgain = await readImages(session.page, expectedUrl);
    if (!again || again.title !== fields.title || imagesAgain?.length !== 1 ||
        imagesAgain[0].pathHash !== images[0].pathHash)
      return stop("RECHECK_UNVERIFIED");
    if (!await fileInput(session.page, expectedUrl)) return stop("FILE_INPUT_UNVERIFIED");
    return { status: "READY", reasonCode: "EXACT_PRIVATE_PRODUCT_READY" };
  } catch {
    return authRequired(session?.page) ?
      { status: "AUTH_REQUIRED", reasonCode: "LOGIN_REQUIRED" } :
      blocked("READ_FAILED");
  } finally {
    if (session) { try { await session.context.close(); } catch { /* Read-only result stands. */ } }
  }
}
