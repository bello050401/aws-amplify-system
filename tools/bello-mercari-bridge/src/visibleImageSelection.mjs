const HASH = /^[a-f0-9]{64}$/;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The current Shops editor opens its hidden input from the visible add-image tile. */
export async function selectPinnedImageFromVisibleBox(page, expectedUrl, image, bytes) {
  if (page.url() !== expectedUrl || !Buffer.isBuffer(bytes) ||
      !image || typeof image.filename !== "string" ||
      !["image/jpeg", "image/png"].includes(image.mimeType))
    throw Error("Invalid visible image selection target");
  const boxes = page.getByTestId("image_box");
  if (await boxes.count() < 1) throw Error("Visible image box is missing");
  const box = boxes.first();
  if (!await box.isVisible() ||
      await box.locator('img[alt="uploaded-image"]').count() !== 0)
    throw Error("Visible image box changed");
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 12000 }),
    box.click({ timeout: 12000 }),
  ]);
  if (page.url() !== expectedUrl || !chooser.isMultiple())
    throw Error("Image chooser changed");
  await chooser.setFiles({ name: image.filename, mimeType: image.mimeType,
    buffer: bytes }, { timeout: 12000 });
}

/** Compare fixed digests only. A data: preview is never a persisted Shops asset. */
export function matchesExactPendingPreview(slots, originalHash, selectedSha256) {
  return HASH.test(originalHash) && HASH.test(selectedSha256) &&
    Array.isArray(slots) && slots.length === 2 &&
    slots.filter(slot => slot?.kind === "REMOTE" && slot.hash === originalHash &&
      Number.isSafeInteger(slot.width) && slot.width > 0 &&
      Number.isSafeInteger(slot.height) && slot.height > 0).length === 1 &&
    slots.filter(slot => slot?.kind === "DATA_PREVIEW" && slot.hash === selectedSha256 &&
      Number.isSafeInteger(slot.width) && slot.width > 0 &&
      Number.isSafeInteger(slot.height) && slot.height > 0).length === 1;
}

/** Read complete image nodes without exposing URLs or data URI bytes to Node. */
export async function readExactPendingPreview(page, expectedUrl, originalHash,
  selectedSha256) {
  if (page.url() !== expectedUrl) return false;
  const slots = await page.locator('img[alt="uploaded-image"]').evaluateAll(async (elements,
    expected) => {
    if (document.location.href !== expected || elements.length !== 2) return null;
    const digest = async bytes => Array.from(new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes)), byte =>
      byte.toString(16).padStart(2, "0")).join("");
    const result = [];
    for (const element of elements) {
      if (!(element instanceof HTMLImageElement) || !element.complete ||
          element.naturalWidth < 1 || element.naturalHeight < 1) return null;
      const src = element.currentSrc || element.src;
      if (src.startsWith("data:")) {
        const match = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/]+={0,2})$/.exec(src);
        if (!match || match[2].length > 10_666_672) return null;
        let decoded;
        try { decoded = atob(match[2]); } catch { return null; }
        if (!decoded.length || decoded.length > 8_000_000) return null;
        const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
        result.push({ kind: "DATA_PREVIEW", hash: await digest(bytes),
          width: element.naturalWidth, height: element.naturalHeight });
      } else {
        let url;
        try { url = new URL(src); } catch { return null; }
        if (url.protocol !== "https:") return null;
        result.push({ kind: "REMOTE", hash: await digest(
          new TextEncoder().encode(url.pathname)),
        width: element.naturalWidth, height: element.naturalHeight });
      }
    }
    return result;
  }, expectedUrl);
  return page.url() === expectedUrl &&
    matchesExactPendingPreview(slots, originalHash, selectedSha256);
}

/** Stop as soon as either a remote second image or an exact local preview appears. */
export async function waitForVisibleImageSelection(page, expectedUrl, originalHash,
  selectedSha256, readImages, readPreview = readExactPendingPreview, timeoutMs = 30000) {
  if (!HASH.test(originalHash) || !HASH.test(selectedSha256) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw Error("Invalid visible image wait");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.url() !== expectedUrl) return null;
    const images = await readImages(page, expectedUrl);
    if (images?.length === 2 &&
        images.filter(image => image.pathHash === originalHash).length === 1) {
      const added = images.find(image => image.pathHash !== originalHash);
      if (added && HASH.test(added.pathHash))
        return { kind: "REMOTE_SECOND_IMAGE", pathHash: added.pathHash };
    }
    if (images && images.length > 2) return null;
    if (await readPreview(page, expectedUrl, originalHash, selectedSha256))
      return { kind: "PENDING_PREVIEW_MATCHED" };
    await pause(Math.min(250, Math.max(1, deadline - Date.now())));
  }
  return null;
}
