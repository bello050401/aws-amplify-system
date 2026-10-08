import { createHash } from "node:crypto";
import { openBelloAdminContext, validBelloOrigin } from "./belloSession.mjs";
import { exactGeneralPrivateCreatePack } from "./generalPrivateCreateJob.mjs";
import { MAX_SHOPS_IMAGE_BYTES } from "./prepareExistingImage.mjs";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_END = Buffer.from([73, 69, 78, 68, 174, 66, 96, 130]);

export function inspectGeneralPrivateCreateImage(bytes, storageKey, index) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 20 ||
      bytes.length > MAX_SHOPS_IMAGE_BYTES ||
      typeof storageKey !== "string" || !storageKey ||
      !Number.isInteger(index) || index < 0 || index > 19)
    throw Error("GENERAL_IMAGE_UNVERIFIED");
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
    bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  const png = bytes.subarray(0, 8).equals(PNG) &&
    bytes.subarray(-8).equals(PNG_END);
  if (!jpeg && !png) throw Error("GENERAL_IMAGE_UNVERIFIED");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { storageKey, index, buffer: bytes, sha256,
    mimeType: jpeg ? "image/jpeg" : "image/png",
    filename: `BELLO-${index + 1}-${sha256.slice(0, 16)}.${jpeg ? "jpg" : "png"}` };
}

/** Fetches current BELLO images in memory before the one-time Shops claim. */
export async function fetchCurrentGeneralPrivateCreateSnapshot({ origin,
  belloProfileDir, playwrightModulePath, pack }, {
    openContext = openBelloAdminContext,
  } = {}) {
  const exact = exactGeneralPrivateCreatePack(pack);
  if (!exact || !validBelloOrigin(origin))
    throw Error("GENERAL_PACK_UNVERIFIED");
  const context = await openContext({ origin, profileDir: belloProfileDir,
    playwrightModulePath });
  try {
    const response = await context.request.post(
      `${origin}/api/inventory/mercari-bridge/manual-pack`, {
        headers: { Origin: origin, "Content-Type": "application/json",
          "x-bello-mercari-bridge": "MANUAL_PACK" },
        data: JSON.stringify(exact), failOnStatusCode: false,
      });
    if (!response.ok()) throw Error(response.status() === 403 ?
      "BELLO_ADMIN_LOGIN_REQUIRED" : "GENERAL_PACK_CHANGED_OR_UNAVAILABLE");
    const payload = await response.json();
    if (payload?.ok !== true || payload.inventoryId !== exact.inventoryId ||
        payload.draftId !== exact.draftId || !Array.isArray(payload.images) ||
        payload.images.length !== exact.imageRefs.length)
      throw Error("GENERAL_IMAGE_PROOF_UNVERIFIED");
    if (!(payload.sourcePriceYen === null &&
          payload.sourceShippingMethod === null) &&
        (!Number.isSafeInteger(payload.sourcePriceYen) ||
          payload.sourcePriceYen < 300 ||
          !["KAZAI", "SAGAWA"].includes(payload.sourceShippingMethod)))
      throw Error("GENERAL_SOURCE_PROOF_UNVERIFIED");
    const files = [];
    for (const [index, image] of payload.images.entries()) {
      if (image?.index !== index ||
          image.storageKey !== exact.imageRefs[index].storageKey ||
          typeof image.url !== "string")
        throw Error("GENERAL_IMAGE_PROOF_UNVERIFIED");
      let url;
      try { url = new URL(image.url); } catch { throw Error("GENERAL_IMAGE_PROOF_UNVERIFIED"); }
      if (url.protocol !== "https:" || url.username || url.password)
        throw Error("GENERAL_IMAGE_PROOF_UNVERIFIED");
      const imageResponse = await context.request.get(image.url, {
        failOnStatusCode: false, maxRedirects: 0,
      });
      if (!imageResponse.ok()) throw Error("GENERAL_IMAGE_DOWNLOAD_UNAVAILABLE");
      const bytes = await imageResponse.body();
      files.push(inspectGeneralPrivateCreateImage(bytes, image.storageKey, index));
    }
    return { files, sourcePriceYen: payload.sourcePriceYen,
      sourceShippingMethod: payload.sourceShippingMethod };
  } finally { await context.close().catch(() => {}); }
}

export async function fetchCurrentGeneralPrivateCreateImages(options, dependencies) {
  return (await fetchCurrentGeneralPrivateCreateSnapshot(options, dependencies)).files;
}
