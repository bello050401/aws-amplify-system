import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { bindAccount } from "./queue.mjs";

export const PRIVATE_CREATE_SHOP_ID = "evkhihBFFNn5hukMS9s36H";
const PRIVATE_TEST_INVENTORY_ID = "dd273c1e-9b2a-4013-acc6-c445a481fab8";
const PRIVATE_TEST_CODE = "TEST_B005659_E51E4F6B7B86DD150546";
export const NEXT_PRIVATE_TEST_INVENTORY_ID = "5b0f3587-cbbb-4c09-ae78-595b2b3e353f";
export const NEXT_PRIVATE_TEST_CODE = "TEST_B005413_B63EF3F86211FFE0F890D81E";
const NEXT_DRAFT_ID = "7bbdd5b7-5df6-4b93-97ba-dd7f675feab9";
const NEXT_DRAFT_UPDATED_AT = "2026-09-02T00:53:48.206Z";
const NEXT_TITLE = "Anonymous Lounge Chair";
const NEXT_DESCRIPTION_SHA256 = "c1b95825120d1851f698fc2f4095d627ce3639f2791c88265a7466328dbb8586";
const NEXT_IMAGE_KEY = "inventory/16fd3352-1e54-4b5e-a2ab-8e20ef4bafa9.jpg";
const EXISTING_PUBLIC_PRODUCT_ID = "2JWp7EJx6aqKfn6dTXc5Q9";
const RESERVED_PRIVATE_TEST_CODES = new Set(["B005659", PRIVATE_TEST_CODE,
  "B005413", NEXT_PRIVATE_TEST_CODE]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SKU = /^[A-Za-z0-9_-]{1,40}$/;
const CONDITIONS = new Set(["NEW", "LIKE_NEW", "NO_NOTABLE_DAMAGE",
  "SLIGHT_DAMAGE", "DAMAGE", "BAD"]);
const SOURCES = new Set(["INVENTORY", "PHOTO_ASSET"]);
const FIELDS = ["schemaVersion", "kind", "shopId", "inventoryId", "inventoryCode",
  "draftId", "draftUpdatedAt", "title", "description", "priceYen", "quantity",
  "condition", "shippingMethod", "imageRefs"];
const PRIVATE_TEST_FIELDS = ["schemaVersion", "kind", "shopId", "inventoryId",
  "sourceInventoryCode", "sourcePriceYen", "testManagementCode", "testPriceYen",
  "visibility", "doNotModifyProductId", "contentEvidence", "draftId",
  "draftUpdatedAt", "title", "description", "quantity", "condition",
  "shippingMethod", "imageRefs"];
const IMAGE_FIELDS = ["source", "storageKey", "sortOrder", "photoAssetId"];
const keys = value => Object.keys(value).sort().join(",");
const exact = (value, names) => value && typeof value === "object" &&
  !Array.isArray(value) && keys(value) === [...names].sort().join(",");
const validUuid = value => typeof value === "string" && UUID.test(value);
const digest = value => createHash("sha256").update(value).digest("hex");

/** Strict, no-send snapshot. A caller must obtain it from a current BELLO admin read. */
export function buildPrivateCreatePreparation(input) {
  const isPrivateTest = input?.schemaVersion === 2;
  const fields = isPrivateTest ? PRIVATE_TEST_FIELDS : FIELDS;
  const sourceCode = isPrivateTest ? input.sourceInventoryCode : input?.inventoryCode;
  const sourcePrice = isPrivateTest ? input.sourcePriceYen : input?.priceYen;
  const reservedV1 = !isPrivateTest && (
    (typeof input?.inventoryId === "string" &&
      [PRIVATE_TEST_INVENTORY_ID, NEXT_PRIVATE_TEST_INVENTORY_ID].includes(
        input.inventoryId.toLowerCase())) ||
    (typeof sourceCode === "string" &&
      RESERVED_PRIVATE_TEST_CODES.has(sourceCode.toUpperCase())));
  const oldPrivateTest = input?.kind === "BELLO_SEPARATE_PRIVATE_TEST_PREPARATION" &&
    input.inventoryId === PRIVATE_TEST_INVENTORY_ID &&
    sourceCode === "B005659" && sourcePrice === 54200 &&
    input.testManagementCode === PRIVATE_TEST_CODE &&
    input.testPriceYen === 99999 && input.visibility === "PRIVATE_ONLY" &&
    input.doNotModifyProductId === EXISTING_PUBLIC_PRODUCT_ID &&
    input.contentEvidence === "BELLO_SAVED_DRAFT_ONLY" &&
    input.quantity === 1 && input.condition === "NO_NOTABLE_DAMAGE" &&
    input.shippingMethod === "KAZAI";
  const nextPrivateTest = input?.kind === "BELLO_SEPARATE_PRIVATE_TEST_PREPARATION" &&
    input.inventoryId === NEXT_PRIVATE_TEST_INVENTORY_ID &&
    sourceCode === "B005413" && sourcePrice === 30000 &&
    input.testManagementCode === NEXT_PRIVATE_TEST_CODE &&
    input.testPriceYen === 99999 && input.visibility === "PRIVATE_ONLY" &&
    input.doNotModifyProductId === null &&
    input.contentEvidence === "BELLO_SAVED_DRAFT_ONLY" &&
    input.draftId === NEXT_DRAFT_ID &&
    input.draftUpdatedAt === NEXT_DRAFT_UPDATED_AT &&
    input.title === NEXT_TITLE &&
    typeof input.description === "string" &&
    digest(input.description) === NEXT_DESCRIPTION_SHA256 &&
    input.quantity === 1 && input.condition === "NO_NOTABLE_DAMAGE" &&
    input.shippingMethod === "KAZAI" &&
    input.imageRefs?.length === 1 &&
    input.imageRefs[0]?.source === "INVENTORY" &&
    input.imageRefs[0]?.storageKey === NEXT_IMAGE_KEY &&
    input.imageRefs[0]?.sortOrder === 0 &&
    input.imageRefs[0]?.photoAssetId === null;
  if (!exact(input, fields) ||
      (isPrivateTest ?
        !oldPrivateTest && !nextPrivateTest :
        input.schemaVersion !== 1 ||
        input.kind !== "BELLO_PRIVATE_CREATE_PREPARATION" || reservedV1) ||
      input.shopId !== PRIVATE_CREATE_SHOP_ID ||
      !validUuid(input.inventoryId) || typeof sourceCode !== "string" ||
      !SKU.test(sourceCode) ||
      !validUuid(input.draftId) ||
      typeof input.draftUpdatedAt !== "string" ||
      !ISO.test(input.draftUpdatedAt) ||
      !Number.isFinite(Date.parse(input.draftUpdatedAt)) ||
      typeof input.title !== "string" || !input.title.trim() ||
      input.title.length > 130 || typeof input.description !== "string" ||
      !input.description.trim() || input.description.length > 3000 ||
      !Number.isSafeInteger(sourcePrice) || sourcePrice < 300 ||
      sourcePrice > 9_999_999 || !Number.isSafeInteger(input.quantity) ||
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
        (image.source === "PHOTO_ASSET" ? !validUuid(image.photoAssetId) :
          image.photoAssetId !== null) || seen.has(image.storageKey))
      throw Error("BELLO private-create image selection is incomplete");
    seen.add(image.storageKey);
  }
  const canonical = Object.fromEntries(fields.map(name => [name, input[name]]));
  canonical.imageRefs = input.imageRefs.map(image =>
    Object.fromEntries(IMAGE_FIELDS.map(name => [name, image[name]])));
  const snapshot = JSON.stringify(canonical);
  return { schemaVersion: input.schemaVersion,
    operation: isPrivateTest ? "PREPARE_SEPARATE_PRIVATE_TEST_NO_SEND" :
      "PREPARE_PRIVATE_CREATE_NO_SEND",
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
    if (input.schemaVersion === 2)
      throw Error("Private test preparation already claimed; no retry");
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
