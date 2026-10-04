import { readFile } from "node:fs/promises";
import { openExistingProductReadSession } from "./session.mjs";
import { readPinnedEditFields, privateSaveControl } from "./saveExistingPrivateOnce.mjs";
import { readExistingUploadedImages, exactSingleImageInput } from "./addExistingImageOnce.mjs";
import { privateFromExactListRow } from "./existingProductReader.mjs";
import { inspectExistingImage } from "./prepareExistingImage.mjs";
import { observeManualShopsMutation, safeManualMutationSummary } from "./manualMutationObservation.mjs";
import { readManualImageClaim } from "./manualImageAttempt.mjs";
import { readManualSaveClaim } from "./manualSaveAttempt.mjs";
import { readPrivateImageWorkflowClaim, claimPrivateImageWorkflow,
  claimPrivateImageSaveStage, writePrivateImageWorkflowResult } from "./privateImageWorkflowAttempt.mjs";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function privateExactProduct(page, target, expectedUrl, title) {
  const result = await privateFromExactListRow(page, target.shopId, expectedUrl, title);
  return result.value.kind === "OBSERVED" && result.value.value === "PRIVATE" &&
    page.url() === expectedUrl;
}

export async function waitForExactlyOneAddedImage(page, expectedUrl, originalHash,
  readImages = readExistingUploadedImages, timeoutMs = 30000) {
  if (!/^[a-f0-9]{64}$/.test(originalHash) || !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 || timeoutMs > 30000) throw Error("Invalid image visibility check");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.url() !== expectedUrl) return null;
    const images = await readImages(page, expectedUrl);
    if (images?.length === 2 &&
        images.filter(image => image.pathHash === originalHash).length === 1) {
      const added = images.find(image => image.pathHash !== originalHash);
      if (added && /^[a-f0-9]{64}$/.test(added.pathHash)) return added.pathHash;
    }
    if (images && images.length > 2) return null;
    await pause(Math.min(250, Math.max(1, deadline - Date.now())));
  }
  return null;
}

function isAuthRequired(page) {
  try {
    const url = new URL(page.url());
    return url.origin === "https://mercari-shops.com" && url.pathname.startsWith("/signin/");
  } catch { return false; }
}

/** One explicit image-and-private-save action for a fresh existing product.
 * Old image/save markers always block this path; an uncertain stage is never replayed.
 */
export async function runPrivateImageWorkflowOnce({ root, profileDir, playwrightModulePath,
  target, imagePath, imageSha256, onMetadata = null, onStage = null,
  launchPersistentContext = null }, {
    openSession = openExistingProductReadSession, readFields = readPinnedEditFields,
    readImages = readExistingUploadedImages, checkPrivate = privateExactProduct,
    fileInput = exactSingleImageInput, saveControl = privateSaveControl,
    waitForAddedImage = waitForExactlyOneAddedImage,
    observe = (page, url) => observeManualShopsMutation(page, url, { shopsOnly: true }),
  } = {}) {
  const prior = await Promise.all([
    readManualImageClaim(root, target, imageSha256), readManualSaveClaim(root, target),
    readPrivateImageWorkflowClaim(root, target),
  ]);
  if (prior.some(item => item.claimed)) return { status: "BLOCKED_PREVIOUS_ATTEMPT" };
  const bytes = await readFile(imagePath);
  const image = inspectExistingImage(bytes,
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
  let result = null;
  let stage = "IMAGE_CLAIMED";
  const setStage = value => {
    stage = value;
    if (typeof onStage === "function") {
      try { onStage(value); } catch { /* Progress display cannot change the attempt. */ }
    }
  };
  let originalHash = null;
  let addedHash = null;
  const retainedSession = () => ({ context: session.context, page: session.page,
    observer, originalImageHash: originalHash,
    onClose: callback => {
      if (contextClosed) callback();
      else closeListeners.add(callback);
    } });
  try {
    if (session.state === "AUTH_REQUIRED") return { status: "AUTH_REQUIRED" };
    if (session.state !== "NAVIGATED_UNVERIFIED") return { status: "PREFLIGHT_BLOCKED" };
    const before = await readFields(session.page, expectedUrl, target);
    const imagesBefore = await readImages(session.page, expectedUrl);
    if (!before || imagesBefore?.length !== 1 ||
        !/^[a-f0-9]{64}$/.test(imagesBefore[0].pathHash) ||
        !await checkPrivate(session.page, target, expectedUrl, before.title))
      return { status: "PREFLIGHT_BLOCKED" };
    originalHash = imagesBefore[0].pathHash;
    const again = await readFields(session.page, expectedUrl, target);
    const imagesAgain = await readImages(session.page, expectedUrl);
    if (!again || again.title !== before.title || imagesAgain?.length !== 1 ||
        imagesAgain[0].pathHash !== originalHash ||
        !await fileInput(session.page, expectedUrl)) return { status: "PREFLIGHT_BLOCKED" };
    observer = observe(session.page, expectedUrl);
    claim = await claimPrivateImageWorkflow(root, target, imageSha256);
    setStage("IMAGE_CLAIMED");
    setStage("FILE_SELECTION_UNCERTAIN");
    const input = await fileInput(session.page, expectedUrl);
    if (!input || !await readFields(session.page, expectedUrl, target))
      throw Error("Pinned image input or product changed");
    await input.setInputFiles({ name: image.filename, mimeType: image.mimeType,
      buffer: bytes }, { timeout: 12000 });
    addedHash = await waitForAddedImage(session.page, expectedUrl, originalHash, readImages);
    if (!addedHash) throw Error("The second image was not uniquely visible");
    setStage("TWO_IMAGES_VISIBLE");
    const beforeSave = await readFields(session.page, expectedUrl, target);
    const twoImages = await readImages(session.page, expectedUrl);
    if (!beforeSave || beforeSave.title !== before.title || twoImages?.length !== 2 ||
        twoImages.filter(item => item.pathHash === originalHash).length !== 1 ||
        twoImages.filter(item => item.pathHash === addedHash).length !== 1)
      throw Error("Pinned product or images changed before save");
    await claimPrivateImageSaveStage(root, target, claim.attemptId);
    setStage("SAVE_CLAIMED");
    const checkpoint = observer.checkpoint();
    const next = session.page.getByRole("button", { name: "公開設定に進む", exact: true });
    if (await next.count() !== 1 || !await next.isEnabled() || session.page.url() !== expectedUrl)
      throw Error("Private save path changed");
    setStage("NEXT_CLICK_UNCERTAIN");
    await next.click({ timeout: 12000 });
    const beforeFinal = await readFields(session.page, expectedUrl, target, false);
    if (!beforeFinal || beforeFinal.title !== before.title)
      throw Error("Pinned product changed in save dialog");
    const privateButton = await saveControl(session.page, expectedUrl);
    if (!privateButton) throw Error("Private save dialog changed");
    setStage("PRIVATE_CLICK_UNCERTAIN");
    await privateButton.click({ timeout: 12000 });
    setStage("PRIVATE_CLICK_RETURNED");
    const acknowledged = await observer.waitForExactPrivateUpdate(checkpoint);
    if (!acknowledged) {
      setStage("SAVE_ACK_UNVERIFIED");
      throw Error("Exact private save acknowledgement unverified");
    }
    await session.page.goto(expectedUrl, { waitUntil: "domcontentloaded", timeout: 12000 });
    if (isAuthRequired(session.page)) {
      setStage("AUTH_REQUIRED");
      result = "AUTH_REQUIRED";
      return { status: result, stage, retainedSession: retainedSession() };
    }
    setStage("READBACK_UNVERIFIED");
    const after = await readFields(session.page, expectedUrl, target);
    const imagesAfter = await readImages(session.page, expectedUrl);
    if (!after || after.title !== before.title || imagesAfter?.length !== 2 ||
        imagesAfter.filter(item => item.pathHash === originalHash).length !== 1 ||
        imagesAfter.filter(item => item.pathHash === addedHash).length !== 1 ||
        !await checkPrivate(session.page, target, expectedUrl, before.title))
      throw Error("Exact private product readback unverified");
    const final = await readFields(session.page, expectedUrl, target);
    const finalImages = await readImages(session.page, expectedUrl);
    if (!final || final.title !== before.title || finalImages?.length !== 2 ||
        finalImages.filter(item => item.pathHash === originalHash).length !== 1 ||
        finalImages.filter(item => item.pathHash === addedHash).length !== 1)
      throw Error("Product changed after private list correlation");
    setStage("PRIVATE_READBACK_CONFIRMED");
    result = "CONFIRMED_PRIVATE_WITH_IMAGE";
    return { status: result, stage };
  } catch {
    if (!claim) return { status: "PREFLIGHT_BLOCKED" };
    result = isAuthRequired(session.page) ? "AUTH_REQUIRED" : "UNKNOWN";
    if (result === "AUTH_REQUIRED") setStage("AUTH_REQUIRED");
    return { status: result, stage, retainedSession: retainedSession() };
  } finally {
    if (claim) {
      if (typeof onMetadata === "function" && observer) {
        try { onMetadata(safeManualMutationSummary(observer.snapshot())); } catch { /* UI only. */ }
      }
      try { await writePrivateImageWorkflowResult(root, target, claim.attemptId,
        result ?? "UNKNOWN", stage); } catch { /* The claim still blocks replay. */ }
    }
    if (!claim || result === "CONFIRMED_PRIVATE_WITH_IMAGE") {
      if (observer) { try { await observer.stop(); } catch { /* Browser close still follows. */ } }
      await session.context.close();
    }
  }
}
