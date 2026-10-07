import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { bindAccount } from "./queue.mjs";
import { PRIVATE_CREATE_SHOP_ID } from "./privateCreatePreparation.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const REASON = /^[A-Z][A-Z0-9_]{0,80}$/;
const CONDITIONS = new Set(["NEW", "LIKE_NEW", "NO_NOTABLE_DAMAGE",
  "SLIGHT_DAMAGE", "DAMAGE", "BAD"]);
const RESERVED = new Set([
  "dd273c1e-9b2a-4013-acc6-c445a481fab8", // B005659 UNKNOWN
  "5b0f3587-cbbb-4c09-ae78-595b2b3e353f", // B005413 UNKNOWN
  "c9ee4ea7-070f-491c-bd4c-c1547cb73436", // B005757 UNKNOWN
]);
const TOP_LEVEL = ["schemaVersion", "kind", "shopId", "inventoryId", "draftId",
  "draftUpdatedAt", "title", "description", "condition", "imageRefs",
  "priceYen", "quantity", "categoryId", "categoryPath", "brandId", "brandName",
  "managementCode", "shipping", "status"];
const IMAGE_KEYS = ["source", "storageKey", "sortOrder", "photoAssetId"];
const RESULT_KEYS = ["attemptId", "outcome", "listingConfirmed",
  "observedRemoteId", "observedDraftId", "reasonCode"];
const SHIPPING = { method: "METHOD_TYPE_UNDECIDED", payer: "PAYER_TYPE_SELLER",
  origin: "jp11", duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" };
const sameKeys = (value, expected) => value !== null &&
  typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === expected.length &&
  expected.every(key => Object.hasOwn(value, key));
const digest = value => createHash("sha256").update(value).digest("hex");

export function exactGeneralPrivateCreatePack(input) {
  if (!sameKeys(input, TOP_LEVEL) || input.schemaVersion !== 1 ||
      input.kind !== "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK" ||
      input.shopId !== PRIVATE_CREATE_SHOP_ID ||
      typeof input.inventoryId !== "string" || !UUID.test(input.inventoryId) ||
      RESERVED.has(input.inventoryId.toLowerCase()) ||
      typeof input.draftId !== "string" || !UUID.test(input.draftId) ||
      typeof input.draftUpdatedAt !== "string" ||
      !Number.isFinite(Date.parse(input.draftUpdatedAt)) ||
      typeof input.title !== "string" || !input.title.trim() ||
      input.title.length > 130 || typeof input.description !== "string" ||
      !input.description.trim() || input.description.length > 3000 ||
      !CONDITIONS.has(input.condition) ||
      !Number.isSafeInteger(input.priceYen) || input.priceYen < 300 ||
      input.priceYen > 9_999_999 || !Number.isSafeInteger(input.quantity) ||
      input.quantity < 1 || typeof input.categoryId !== "string" ||
      !ID.test(input.categoryId) ||
      typeof input.categoryPath !== "string" ||
      !input.categoryPath.startsWith("家具・インテリア > ") ||
      input.categoryPath.split(" > ").length < 2 ||
      (input.brandId !== null &&
        (typeof input.brandId !== "string" || !ID.test(input.brandId))) ||
      (input.brandName !== null &&
        (typeof input.brandName !== "string" || !input.brandName.trim())) ||
      (input.brandId === null) !== (input.brandName === null) ||
      input.managementCode !==
        `BELLO_${input.inventoryId.replace(/-/g, "").toUpperCase()}` ||
      input.status !== "PREPARED_NO_SEND" ||
      !sameKeys(input.shipping, Object.keys(SHIPPING)) ||
      Object.keys(SHIPPING).some(key => input.shipping[key] !== SHIPPING[key]) ||
      !Array.isArray(input.imageRefs) || input.imageRefs.length < 1 ||
      input.imageRefs.length > 20) return null;
  const imageKeys = new Set();
  for (const [index, image] of input.imageRefs.entries()) {
    if (!sameKeys(image, IMAGE_KEYS) ||
        !["INVENTORY", "PHOTO_ASSET"].includes(image.source) ||
        typeof image.storageKey !== "string" || !image.storageKey ||
        image.storageKey.length > 512 || /[?#\x00-\x1f]/.test(image.storageKey) ||
        image.storageKey.includes("://") || image.sortOrder !== index ||
        (image.source === "PHOTO_ASSET" ?
          typeof image.photoAssetId !== "string" || !UUID.test(image.photoAssetId) :
          image.photoAssetId !== null) || imageKeys.has(image.storageKey)) return null;
    imageKeys.add(image.storageKey);
  }
  return Object.fromEntries(TOP_LEVEL.map(key => [key, key === "imageRefs" ?
    input.imageRefs.map(image => Object.fromEntries(IMAGE_KEYS.map(name =>
      [name, image[name]]))) : key === "shipping" ? { ...SHIPPING } : input[key]]));
}

function paths(root, inventoryId) {
  if (typeof root !== "string" || !isAbsolute(root) ||
      typeof inventoryId !== "string" || !UUID.test(inventoryId))
    throw Error("Invalid private-create queue target");
  const dir = join(root, "general-private-create-once");
  const prefix = join(dir, inventoryId.toLowerCase());
  return { dir, job: `${prefix}.job.json`, claim: `${prefix}.claim.json`,
    result: `${prefix}.result.json` };
}

async function writeOnce(path, value) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value) + "\n", "utf8");
    await handle.sync(); }
  finally { await handle.close(); }
}

/** Importing a BELLO pack only queues human review; no Shops browser is opened. */
export async function enqueueGeneralPrivateCreate(root, input) {
  const pack = exactGeneralPrivateCreatePack(input);
  if (!pack) throw Error("GENERAL_PRIVATE_CREATE_PACK_UNVERIFIED");
  const path = paths(root, pack.inventoryId);
  await bindAccount(root, pack.shopId);
  const record = { schemaVersion: 1, operation: "GENERAL_PRIVATE_CREATE_NO_SEND",
    fingerprint: digest(JSON.stringify(pack)), pack };
  await mkdir(path.dir, { recursive: true });
  try { await writeOnce(path.job, record); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const prior = await readGeneralPrivateCreate(root, pack.inventoryId);
    if (prior.fingerprint !== record.fingerprint)
      throw Error("GENERAL_PRIVATE_CREATE_PACK_CHANGED");
  }
  return { inventoryId: pack.inventoryId, managementCode: pack.managementCode,
    status: "PREPARED_NO_SEND" };
}

export async function readGeneralPrivateCreate(root, inventoryId) {
  const path = paths(root, inventoryId);
  const bytes = await readFile(path.job);
  if (bytes.length > 65536) throw Error("GENERAL_PRIVATE_CREATE_PACK_UNVERIFIED");
  const record = JSON.parse(bytes.toString("utf8"));
  const pack = exactGeneralPrivateCreatePack(record?.pack);
  if (!pack || record.schemaVersion !== 1 ||
      record.operation !== "GENERAL_PRIVATE_CREATE_NO_SEND" ||
      record.fingerprint !== digest(JSON.stringify(pack)) ||
      pack.inventoryId.toLowerCase() !== inventoryId.toLowerCase())
    throw Error("GENERAL_PRIVATE_CREATE_PACK_UNVERIFIED");
  return { ...record, pack };
}

/** The claim is permanent and precedes all official Shops navigation. */
export async function claimGeneralPrivateCreateOnce(root, inventoryId) {
  const record = await readGeneralPrivateCreate(root, inventoryId);
  const path = paths(root, inventoryId);
  const claim = { schemaVersion: 1, operation: "GENERAL_PRIVATE_CREATE_ONCE",
    attemptId: randomUUID(), shopId: record.pack.shopId,
    inventoryId: record.pack.inventoryId, fingerprint: record.fingerprint,
    status: "UNKNOWN", claimedAt: new Date().toISOString() };
  try { await writeOnce(path.claim, claim); }
  catch (error) {
    if (error?.code === "EEXIST") throw Error("GENERAL_PRIVATE_CREATE_ALREADY_CLAIMED");
    throw error;
  }
  return claim;
}

export async function readGeneralPrivateCreateClaim(root, inventoryId) {
  const path = paths(root, inventoryId);
  try {
    const claim = JSON.parse(await readFile(path.claim, "utf8"));
    const job = await readGeneralPrivateCreate(root, inventoryId);
    if (claim?.schemaVersion !== 1 || claim.operation !== "GENERAL_PRIVATE_CREATE_ONCE" ||
        !UUID.test(claim.attemptId) || claim.shopId !== job.pack.shopId ||
        claim.inventoryId !== job.pack.inventoryId ||
        claim.fingerprint !== job.fingerprint || claim.status !== "UNKNOWN" ||
        !Number.isFinite(Date.parse(claim.claimedAt)))
      throw Error("GENERAL_PRIVATE_CREATE_CLAIM_UNVERIFIED");
    return claim;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeGeneralPrivateCreateResultOnce(root, inventoryId, result) {
  const path = paths(root, inventoryId);
  const claim = await readGeneralPrivateCreateClaim(root, inventoryId);
  if (!claim || !sameKeys(result, RESULT_KEYS) ||
      result.attemptId !== claim.attemptId ||
      !["UNKNOWN", "PRIVATE_READBACK_CONFIRMED"].includes(result.outcome) ||
      result.listingConfirmed !== false ||
      typeof result.reasonCode !== "string" || !REASON.test(result.reasonCode) ||
      (result.outcome === "PRIVATE_READBACK_CONFIRMED" &&
        result.observedRemoteId === null) ||
      (result.observedRemoteId !== null &&
        (typeof result.observedRemoteId !== "string" ||
          !ID.test(result.observedRemoteId))) ||
      (result.observedDraftId !== null &&
        (typeof result.observedDraftId !== "string" ||
          !ID.test(result.observedDraftId))))
    throw Error("GENERAL_PRIVATE_CREATE_RESULT_UNVERIFIED");
  await writeOnce(path.result, { schemaVersion: 1, inventoryId,
    ...Object.fromEntries(RESULT_KEYS.map(key => [key, result[key]])),
    recordedAt: new Date().toISOString() });
}

export async function listGeneralPrivateCreateJobs(root) {
  const { dir } = paths(root, "00000000-0000-4000-8000-000000000000");
  let names;
  try { names = await readdir(dir); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const jobs = [];
  for (const name of names) {
    if (!name.endsWith(".job.json")) continue;
    const inventoryId = name.slice(0, -".job.json".length);
    if (!UUID.test(inventoryId)) throw Error("GENERAL_PRIVATE_CREATE_QUEUE_UNVERIFIED");
    const { pack } = await readGeneralPrivateCreate(root, inventoryId);
    const claim = await readGeneralPrivateCreateClaim(root, inventoryId);
    let result = null;
    try {
      const raw = await readFile(paths(root, inventoryId).result);
      if (raw.length > 8192) throw Error("GENERAL_PRIVATE_CREATE_RESULT_UNVERIFIED");
      result = JSON.parse(raw.toString("utf8"));
      if (!sameKeys(result, ["schemaVersion", "inventoryId", ...RESULT_KEYS,
        "recordedAt"]) || result.schemaVersion !== 1 ||
          result.inventoryId !== inventoryId ||
          result.attemptId !== claim?.attemptId ||
          !["UNKNOWN", "PRIVATE_READBACK_CONFIRMED"].includes(result.outcome) ||
          result.listingConfirmed !== false ||
          !REASON.test(result.reasonCode) ||
          (result.outcome === "PRIVATE_READBACK_CONFIRMED" &&
            result.observedRemoteId === null) ||
          (result.observedRemoteId !== null &&
            (typeof result.observedRemoteId !== "string" ||
              !ID.test(result.observedRemoteId))) ||
          (result.observedDraftId !== null &&
            (typeof result.observedDraftId !== "string" ||
              !ID.test(result.observedDraftId))) ||
          typeof result.recordedAt !== "string" ||
          !Number.isFinite(Date.parse(result.recordedAt)))
        throw Error("GENERAL_PRIVATE_CREATE_RESULT_UNVERIFIED");
    }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    jobs.push({ inventoryId, managementCode: pack.managementCode,
      claimed: Boolean(claim), attemptId: claim?.attemptId ?? null,
      outcome: result?.outcome ?? null,
      observedRemoteId: result?.observedRemoteId ?? null });
  }
  return jobs;
}
