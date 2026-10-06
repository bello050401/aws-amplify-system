import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { bindAccount } from "./queue.mjs";

export const PRIVATE_CREATE_SHOP_ID = "evkhihBFFNn5hukMS9s36H";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SKU = /^[A-Za-z0-9_-]{1,40}$/;
const CONDITIONS = new Set(["NEW", "LIKE_NEW", "NO_NOTABLE_DAMAGE",
  "SLIGHT_DAMAGE", "DAMAGE", "BAD"]);
const SOURCES = new Set(["INVENTORY", "PHOTO_ASSET"]);
const FIELDS = ["schemaVersion", "kind", "shopId", "inventoryId", "inventoryCode",
  "draftId", "draftUpdatedAt", "title", "description", "priceYen", "quantity",
  "condition", "shippingMethod", "imageRefs"];
const IMAGE_FIELDS = ["source", "storageKey", "sortOrder", "photoAssetId"];
const keys = value => Object.keys(value).sort().join(",");
const exact = (value, names) => value && typeof value === "object" &&
  !Array.isArray(value) && keys(value) === [...names].sort().join(",");
const digest = value => createHash("sha256").update(value).digest("hex");

/** Strict, no-send snapshot. A caller must obtain it from a current BELLO admin read. */
export function buildPrivateCreatePreparation(input) {
  if (!exact(input, FIELDS) || input.schemaVersion !== 1 ||
      input.kind !== "BELLO_PRIVATE_CREATE_PREPARATION" ||
      input.shopId !== PRIVATE_CREATE_SHOP_ID ||
      !UUID.test(input.inventoryId) || !SKU.test(input.inventoryCode) ||
      !UUID.test(input.draftId) || !ISO.test(input.draftUpdatedAt) ||
      !Number.isFinite(Date.parse(input.draftUpdatedAt)) ||
      typeof input.title !== "string" || !input.title.trim() ||
      input.title.length > 130 || typeof input.description !== "string" ||
      !input.description.trim() || input.description.length > 3000 ||
      !Number.isSafeInteger(input.priceYen) || input.priceYen < 300 ||
      input.priceYen > 9_999_999 || !Number.isSafeInteger(input.quantity) ||
      input.quantity < 1 || !CONDITIONS.has(input.condition) ||
      !["KAZAI", "SAGAWA"].includes(input.shippingMethod) ||
      !Array.isArray(input.imageRefs) || input.imageRefs.length < 1 ||
      input.imageRefs.length > 20)
    throw Error("BELLO private-create preparation is incomplete");
  const seen = new Set();
  for (const [index, image] of input.imageRefs.entries()) {
    if (!exact(image, IMAGE_FIELDS) || !SOURCES.has(image.source) ||
        typeof image.storageKey !== "string" || !image.storageKey ||
        image.storageKey.length > 512 || /[?#\x00-\x1f]/.test(image.storageKey) ||
        image.storageKey.includes("://") || image.sortOrder !== index ||
        (image.source === "PHOTO_ASSET" ? !UUID.test(image.photoAssetId) :
          image.photoAssetId !== null) || seen.has(image.storageKey))
      throw Error("BELLO private-create image selection is incomplete");
    seen.add(image.storageKey);
  }
  const canonical = Object.fromEntries(FIELDS.map(name => [name, input[name]]));
  canonical.imageRefs = input.imageRefs.map(image =>
    Object.fromEntries(IMAGE_FIELDS.map(name => [name, image[name]])));
  const snapshot = JSON.stringify(canonical);
  return { schemaVersion: 1, operation: "PREPARE_PRIVATE_CREATE_NO_SEND",
    requestId: digest(`PREPARE_PRIVATE_CREATE\0${input.shopId}\0${input.inventoryId}`),
    snapshotFingerprint: digest(snapshot), snapshotJson: snapshot,
    shopId: input.shopId, inventoryId: input.inventoryId,
    status: "PREPARED_NO_SEND", remoteId: null, listingConfirmed: false };
}

/** One inventory may have only one local preparation, even if its draft later changes. */
export async function preparePrivateCreateOnce(root, input) {
  if (typeof root !== "string" || !isAbsolute(root)) throw Error("Absolute queue root required");
  const job = buildPrivateCreatePreparation(input);
  await bindAccount(root, PRIVATE_CREATE_SHOP_ID);
  const dir = join(root, "private-create-prepared");
  const path = join(dir, `${job.inventoryId}.json`);
  await mkdir(dir, { recursive: true });
  try {
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(job) + "\n", "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    return job;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let prior = null;
    for (let attempt = 0; attempt < 10 && prior === null; attempt++) {
      try { prior = JSON.parse(await readFile(path, "utf8")); }
      catch {
        if (attempt === 9) throw Error("Previous private-create preparation is unreadable");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    if (keys(prior) !== keys(job) || Object.keys(job).some(key => prior[key] !== job[key]))
      throw Error("Previous private-create preparation differs; no retry");
    return job;
  }
}
