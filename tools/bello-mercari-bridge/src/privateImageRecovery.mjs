import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { openExistingProductReadSession } from "./session.mjs";
import { readPinnedEditFields, privateSaveControl } from "./saveExistingPrivateOnce.mjs";
import { readExistingUploadedImages, exactSingleImageInput } from "./addExistingImageOnce.mjs";
import { waitForExactlyOneAddedImage } from "./privateImageWorkflow.mjs";
import { privateFromExactListRow } from "./existingProductReader.mjs";
import { inspectExistingImage } from "./prepareExistingImage.mjs";
import { observeManualShopsMutation, safeManualMutationSummary } from
  "./manualMutationObservation.mjs";
import { readManualImageClaim } from "./manualImageAttempt.mjs";
import { readManualSaveClaim } from "./manualSaveAttempt.mjs";
import { isPinnedB005757ImageTarget } from "./privateImagePreflight.mjs";
import { readPrivateImageWorkflowClaim, readPrivateImageWorkflowResult,
  readPrivateImageSaveClaim } from "./privateImageWorkflowAttempt.mjs";
import { readPrivateImageRecoveryClaim, claimPrivateImageRecovery,
  readPrivateImageRecoverySave, claimPrivateImageRecoverySave,
  writePrivateImageRecoveryResult } from
  "./privateImageRecoveryAttempt.mjs";

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

function exactlyTwo(images, originalHash, addedHash) {
  return images?.length === 2 && originalHash !== addedHash &&
    images.filter(item => item.pathHash === originalHash).length === 1 &&
    images.filter(item => item.pathHash === addedHash).length === 1;
}

async function probePrivateTwo(context, expectedUrl, target, title,
  originalHash, addedHash, readFields, readImages, checkPrivate) {
  let probe = null;
  try {
    probe = await context.newPage();
    await probe.goto(expectedUrl, { waitUntil: "domcontentloaded", timeout: 12000 });
    for (let pass = 0; pass < 2; pass++) {
      const fields = await readFields(probe, expectedUrl, target);
      const images = await readImages(probe, expectedUrl);
      if (!fields || fields.title !== title ||
          !exactlyTwo(images, originalHash, addedHash)) return false;
      if (pass === 0 && !await checkPrivate(probe, target, expectedUrl, title))
        return false;
    }
    return probe.url() === expectedUrl;
  } catch { return false; }
  finally { if (probe) { try { await probe.close(); } catch { /* Keep original page. */ } } }
}

/** A separately claimed, one-time recovery after an independent one-image read. */
export async function recoverPrivateImageOnce({ root, profileDir, playwrightModulePath,
  requestId, target, imagePath, imageSha256, readbackObserved,
  launchPersistentContext = null, onMetadata = null, onStage = null }, {
    openSession = openExistingProductReadSession, readFields = readPinnedEditFields,
    readImages = readExistingUploadedImages, checkPrivate = exactPrivate,
    fileInput = exactSingleImageInput, saveControl = privateSaveControl,
    waitForAddedImage = waitForExactlyOneAddedImage,
    observe = (page, url) => observeManualShopsMutation(page, url, { shopsOnly: true }),
  } = {}) {
  if (![root, profileDir, playwrightModulePath, imagePath].every(value =>
        typeof value === "string" && isAbsolute(value)) ||
      !isPinnedB005757ImageTarget(target, requestId) ||
      !/^[a-f0-9]{64}$/.test(imageSha256))
    throw Error("Invalid exact private-image recovery target");
  if (readbackObserved !== "PRIVATE_ONE_IMAGE_OBSERVED")
    return { status: "PREFLIGHT_BLOCKED" };
  const [originalClaim, originalResult, originalSave, manualImage, manualSave,
    recovery, recoverySave] =
    await Promise.all([
      readPrivateImageWorkflowClaim(root, target),
      readPrivateImageWorkflowResult(root, target),
      readPrivateImageSaveClaim(root, target),
      readManualImageClaim(root, target, imageSha256),
      readManualSaveClaim(root, target),
      readPrivateImageRecoveryClaim(root, target, requestId),
      readPrivateImageRecoverySave(root, target, requestId),
    ]);
  if (!originalClaim.claimed || !originalClaim.valid ||
      originalClaim.imageSha256 !== imageSha256 ||
      originalResult?.status !== "UNKNOWN" ||
      originalResult.stage !== "FILE_SELECTION_UNCERTAIN" ||
      originalSave.claimed || manualImage.claimed || manualSave.claimed ||
      recovery.claimed || recoverySave.claimed)
    return { status: "BLOCKED_PREVIOUS_ATTEMPT" };
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
  let originalHash = null;
  let addedHash = null;
  let readbackPrivateWithImage = false;
  const setStage = value => {
    stage = value;
    if (typeof onStage === "function") { try { onStage(value); } catch { /* UI only. */ } }
  };
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
        !await fileInput(session.page, expectedUrl))
      return { status: "PREFLIGHT_BLOCKED" };
    observer = observe(session.page, expectedUrl);
    try {
      claim = await claimPrivateImageRecovery(root, target, requestId,
        originalClaim.attemptId, imageSha256);
    } catch (error) {
      if (error?.code === "EEXIST") return { status: "BLOCKED_PREVIOUS_ATTEMPT" };
      throw error;
    }
    setStage("IMAGE_CLAIMED");
    const input = await fileInput(session.page, expectedUrl);
    const beforeSelection = await readFields(session.page, expectedUrl, target);
    const imagesBeforeSelection = await readImages(session.page, expectedUrl);
    if (!input || !beforeSelection || beforeSelection.title !== before.title ||
        imagesBeforeSelection?.length !== 1 ||
        imagesBeforeSelection[0].pathHash !== originalHash)
      throw Error("Pinned image input or product changed");
    setStage("FILE_SELECTION_UNCERTAIN");
    await input.setInputFiles({ name: image.filename, mimeType: image.mimeType,
      buffer: bytes }, { timeout: 12000 });
    addedHash = await waitForAddedImage(session.page, expectedUrl, originalHash, readImages);
    if (!addedHash) throw Error("The second image was not uniquely visible");
    setStage("TWO_IMAGES_VISIBLE");
    const beforeSave = await readFields(session.page, expectedUrl, target);
    const twoImages = await readImages(session.page, expectedUrl);
    if (!beforeSave || beforeSave.title !== before.title ||
        !exactlyTwo(twoImages, originalHash, addedHash))
      throw Error("Pinned product or images changed before save");
    await claimPrivateImageRecoverySave(root, target, requestId, claim.attemptId);
    setStage("SAVE_CLAIMED");
    const next = session.page.getByRole("button", { name: "公開設定に進む", exact: true });
    if (await next.count() !== 1 || !await next.isEnabled() ||
        session.page.url() !== expectedUrl)
      throw Error("Private save path changed");
    setStage("NEXT_CLICK_UNCERTAIN");
    await next.click({ timeout: 12000 });
    const beforeFinal = await readFields(session.page, expectedUrl, target, false);
    if (!beforeFinal || beforeFinal.title !== before.title)
      throw Error("Pinned product changed in save dialog");
    const privateButton = await saveControl(session.page, expectedUrl);
    if (!privateButton) throw Error("Private save dialog changed");
    const checkpoint = observer.checkpoint();
    setStage("PRIVATE_CLICK_UNCERTAIN");
    await privateButton.click({ timeout: 12000 });
    setStage("PRIVATE_CLICK_RETURNED");
    const acknowledged = await observer.waitForExactPrivateUpdate(checkpoint);
    if (!acknowledged) {
      setStage("SAVE_ACK_UNVERIFIED");
      readbackPrivateWithImage = await probePrivateTwo(session.context, expectedUrl,
        target, before.title, originalHash, addedHash,
        readFields, readImages, checkPrivate);
      result = authRequired(session.page) ? "AUTH_REQUIRED" : "UNKNOWN";
      return { status: result, stage, readbackPrivateWithImage,
        retainedSession: retainedSession() };
    }
    await session.page.goto(expectedUrl, { waitUntil: "domcontentloaded", timeout: 12000 });
    if (authRequired(session.page)) {
      setStage("AUTH_REQUIRED");
      result = "AUTH_REQUIRED";
      return { status: result, stage, retainedSession: retainedSession() };
    }
    setStage("READBACK_UNVERIFIED");
    const after = await readFields(session.page, expectedUrl, target);
    const imagesAfter = await readImages(session.page, expectedUrl);
    if (!after || after.title !== before.title ||
        !exactlyTwo(imagesAfter, originalHash, addedHash) ||
        !await checkPrivate(session.page, target, expectedUrl, before.title))
      throw Error("Exact private product readback unverified");
    const final = await readFields(session.page, expectedUrl, target);
    const finalImages = await readImages(session.page, expectedUrl);
    if (!final || final.title !== before.title ||
        !exactlyTwo(finalImages, originalHash, addedHash))
      throw Error("Product changed after private list correlation");
    setStage("PRIVATE_READBACK_CONFIRMED");
    readbackPrivateWithImage = true;
    result = "CONFIRMED_PRIVATE_WITH_IMAGE";
    return { status: result, stage, readbackPrivateWithImage };
  } catch {
    if (!claim) return { status: "PREFLIGHT_BLOCKED" };
    result = authRequired(session.page) ? "AUTH_REQUIRED" : "UNKNOWN";
    if (result === "AUTH_REQUIRED") setStage("AUTH_REQUIRED");
    return { status: result, stage, readbackPrivateWithImage,
      retainedSession: retainedSession() };
  } finally {
    if (claim) {
      if (typeof onMetadata === "function" && observer) {
        try { onMetadata(safeManualMutationSummary(observer.snapshot())); }
        catch { /* UI only. */ }
      }
      try { await writePrivateImageRecoveryResult(root, target, requestId,
        claim.attemptId, result ?? "UNKNOWN", stage, readbackPrivateWithImage); }
      catch { /* The durable claim still prevents replay. */ }
    }
    if (!claim || result === "CONFIRMED_PRIVATE_WITH_IMAGE") {
      if (observer) { try { await observer.stop(); } catch { /* Browser close still follows. */ } }
      await session.context.close();
    }
  }
}
