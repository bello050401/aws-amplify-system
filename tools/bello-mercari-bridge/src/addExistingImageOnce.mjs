import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { openExistingProductReadSession } from "./session.mjs";
import { privateFromExactListRow } from "./existingProductReader.mjs";
import { readPinnedEditFields } from "./saveExistingPrivateOnce.mjs";
import { inspectExistingImage } from "./prepareExistingImage.mjs";
import { observeManualShopsMutation, safeManualMutationSummary } from "./manualMutationObservation.mjs";
import { claimManualImageOnce, readManualImageClaim, writeManualImageOutcome } from "./manualImageAttempt.mjs";
import { readPrivateImageWorkflowClaim } from "./privateImageWorkflowAttempt.mjs";

function digest(value) { return createHash("sha256").update(value).digest("hex"); }

/** Read only the already-rendered product images. Never retain an image URL or its query. */
export async function readExistingUploadedImages(page, expectedUrl) {
  if (page.url() !== expectedUrl) return null;
  const seen = await page.locator('img[alt="uploaded-image"]').evaluateAll((elements, expected) => {
    if (document.location.href !== expected) return null;
    return elements.map(element => {
      if (!(element instanceof HTMLImageElement) || !element.complete ||
          element.naturalWidth < 1 || element.naturalHeight < 1) return null;
      try {
        const url = new URL(element.currentSrc || element.src);
        return url.protocol === "https:" ?
          { pathname: url.pathname, width: element.naturalWidth, height: element.naturalHeight } : null;
      } catch { return null; }
    });
  }, expectedUrl);
  if (!Array.isArray(seen) || seen.length < 1 || seen.length > 20 || seen.some(item =>
      !item || typeof item.pathname !== "string" || !item.pathname.startsWith("/") ||
      !Number.isSafeInteger(item.width) || !Number.isSafeInteger(item.height))) return null;
  if (page.url() !== expectedUrl) return null;
  return seen.map(item => ({ pathHash: digest(item.pathname), width: item.width, height: item.height }));
}

/** Inspect the retained edit page without navigation, file input, save, or network request. */
export async function readRetainedImageState(session, target, {
  readFields = readPinnedEditFields, readImages = readExistingUploadedImages,
} = {}) {
  const expectedUrl = `https://mercari-shops.com/seller/shops/${target.shopId}/products/${target.remoteId}/edit`;
  if (!session?.page || !/^[a-f0-9]{64}$/.test(session.originalImageHash ?? "") ||
      session.page.url() !== expectedUrl) return "PAGE_UNVERIFIED";
  const fields = await readFields(session.page, expectedUrl, target);
  if (!fields) return "PAGE_UNVERIFIED";
  const images = await readImages(session.page, expectedUrl);
  if (!images || session.page.url() !== expectedUrl) return "IMAGES_UNVERIFIED";
  const originalCount = images.filter(image => image.pathHash === session.originalImageHash).length;
  if (originalCount !== 1) return "ORIGINAL_UNVERIFIED";
  if (images.length === 1) return "ORIGINAL_ONLY_VISIBLE";
  if (images.length === 2 && images[1].pathHash !== images[0].pathHash)
    return "ORIGINAL_AND_ONE_ADDITION_VISIBLE";
  return "IMAGE_COUNT_UNVERIFIED";
}

export async function exactSingleImageInput(page, expectedUrl) {
  if (page.url() !== expectedUrl) return null;
  const inputs = page.locator('input[type="file"]');
  if (await inputs.count() !== 1) return null;
  const properties = await inputs.evaluateAll(elements => elements.map(element =>
    element instanceof HTMLInputElement ?
      { type: element.type, multiple: element.multiple, name: element.name, disabled: element.disabled } : null));
  return page.url() === expectedUrl && properties?.length === 1 &&
    properties[0]?.type === "file" && properties[0].multiple === true &&
    properties[0].name === "" && properties[0].disabled === false ? inputs : null;
}

async function privateExistingProduct(page, target, expectedUrl, title) {
  const result = await privateFromExactListRow(page, target.shopId, expectedUrl, title);
  return result.value.kind === "OBSERVED" && result.value.value === "PRIVATE" &&
    page.url() === expectedUrl;
}

/** Select one pinned local image for an existing private Shops product, once.
 * File selection itself may upload. This function never saves or publishes the product.
 */
export async function addExistingImageOnce({ root, profileDir, playwrightModulePath,
  target, imagePath, imageSha256, launchPersistentContext = null, onMetadata = null }, {
    openSession = openExistingProductReadSession, readFields = readPinnedEditFields,
    checkPrivate = privateExistingProduct, readImages = readExistingUploadedImages,
    fileInput = exactSingleImageInput, observe = observeManualShopsMutation,
  } = {}) {
  const [prior, workflow] = await Promise.all([
    readManualImageClaim(root, target, imageSha256),
    readPrivateImageWorkflowClaim(root, target),
  ]);
  if (prior.claimed || workflow.claimed) return { status: "ALREADY_ATTEMPTED" };
  const imageBytes = await readFile(imagePath);
  const image = inspectExistingImage(imageBytes,
    { inventoryCode: target.inventoryCode, expectedSha256: imageSha256 });
  const expectedUrl = `https://mercari-shops.com/seller/shops/${target.shopId}/products/${target.remoteId}/edit`;
  const session = await openSession({ root, profileDir, playwrightModulePath,
    shopId: target.shopId, remoteId: target.remoteId, launchPersistentContext });
  let contextClosed = false;
  const closeListeners = new Set();
  session.context.once("close", () => {
    contextClosed = true;
    for (const callback of closeListeners) callback();
    closeListeners.clear();
  });
  let observer = null;
  let claim = null;
  let selectionMayHaveSent = false;
  let diagnostic = "CLAIMED_BEFORE_SELECT";
  try {
    if (session.state !== "NAVIGATED_UNVERIFIED") return { status: "PREFLIGHT_BLOCKED" };
    const before = await readFields(session.page, expectedUrl, target);
    const imagesBefore = await readImages(session.page, expectedUrl);
    // One previously observed 960px Shops image is the exact baseline for this proof.
    if (!before || imagesBefore?.length !== 1 || imagesBefore[0].width !== 960 ||
        imagesBefore[0].height !== 960 ||
        !await checkPrivate(session.page, target, expectedUrl, before.title))
      return { status: "PREFLIGHT_BLOCKED" };
    const again = await readFields(session.page, expectedUrl, target);
    const imagesAgain = await readImages(session.page, expectedUrl);
    if (!again || again.title !== before.title || imagesAgain?.length !== 1 ||
        imagesAgain[0].pathHash !== imagesBefore[0].pathHash ||
        imagesAgain[0].width !== 960 || imagesAgain[0].height !== 960)
      return { status: "PREFLIGHT_BLOCKED" };
    const input = await fileInput(session.page, expectedUrl);
    if (!input) return { status: "PREFLIGHT_BLOCKED" };
    observer = observe(session.page, expectedUrl);
    try { claim = await claimManualImageOnce(root, target, imageSha256); }
    catch (error) {
      if (error?.code === "EEXIST") return { status: "ALREADY_ATTEMPTED" };
      throw error;
    }
    try {
      diagnostic = "FILE_INPUT_CHECK";
      const finalInput = await fileInput(session.page, expectedUrl);
      if (!finalInput) throw Error("Image input changed");
      diagnostic = "FINAL_TARGET_CHECK";
      const finalFields = await readFields(session.page, expectedUrl, target);
      const finalImages = await readImages(session.page, expectedUrl);
      if (!finalFields || finalFields.title !== before.title ||
          finalImages?.length !== 1 || finalImages[0].pathHash !== imagesBefore[0].pathHash)
        throw Error("Existing product or image changed");
      diagnostic = "FILE_SELECT_UNCERTAIN";
      selectionMayHaveSent = true;
      await finalInput.setInputFiles({ name: image.filename, mimeType: image.mimeType,
        buffer: imageBytes }, { timeout: 12000 });
      diagnostic = "FILE_SELECT_RETURNED";
      const after = await readImages(session.page, expectedUrl);
      if (!after?.some(item => item.pathHash === imagesBefore[0].pathHash))
        diagnostic = "ORIGINAL_IMAGE_NOT_OBSERVED";
      else if (after.length === 2)
        diagnostic = "ADDED_IMAGE_UI_OBSERVED";
    } catch { /* A file selection may have reached Shops even when Playwright fails. */ }
    let metadata = [];
    try { metadata = safeManualMutationSummary(observer.snapshot()); }
    catch { /* Metadata collection cannot replay an image selection. */ }
    if (typeof onMetadata === "function") {
      try { onMetadata(metadata); } catch { /* Display cannot change the attempt. */ }
    }
    const status = selectionMayHaveSent ? "UNKNOWN" : "BLOCKED_BEFORE_SELECT";
    try { await writeManualImageOutcome(root, target, claim.attemptId, status, diagnostic); }
    catch { /* The durable claim still prevents replay. */ }
    return { status, diagnostic, metadata, retainedSession: { context: session.context,
      page: session.page, originalImageHash: imagesBefore[0].pathHash, observer,
      onClose: callback => {
        if (contextClosed) callback();
        else closeListeners.add(callback);
      } } };
  } finally {
    if (!claim) {
      if (observer) { try { await observer.stop(); } catch { /* No selection was claimed. */ } }
      await session.context.close();
    }
  }
}
