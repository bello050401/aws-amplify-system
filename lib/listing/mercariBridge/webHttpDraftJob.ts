import { createHash } from "node:crypto";
import type { MercariManualListingPack } from "@/app/actions/mercariManualListingPack";
import type { PrivateCreatePreparation } from
  "@/app/actions/mercariPrivateCreatePreparation";
import { B005396_INVENTORY_ID, B005396_REVIEW_PRICE_YEN,
  type B005396GeneralReviewEvidence } from
  "./b005396GeneralPreparation.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const WEB_HTTP_SHOP_ID = "evkhihBFFNn5hukMS9s36H";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BLOCKED_INVENTORIES = new Set([
  "8f9f607b-fa9b-4057-8a52-f6d16411b122", // B005795 existing Shops product
  "c9ee4ea7-070f-491c-bd4c-c1547cb73436", // B005757 existing Shops product
  "dd273c1e-9b2a-4013-acc6-c445a481fab8", // B005659 prior test
  "5b0f3587-cbbb-4c09-ae78-595b2b3e353f", // B005413 prior test
]);
const BLOCKED_CODES = new Set(["B005795", "B005757", "B005659", "B005413"]);
export const webHttpDraftTargetAllowed = (inventoryId: string) =>
  typeof inventoryId === "string" && UUID.test(inventoryId) &&
    !BLOCKED_INVENTORIES.has(inventoryId.toLowerCase());
export function webHttpDraftRequestId(inventoryId: string) {
  if (!webHttpDraftTargetAllowed(inventoryId)) throw new WebHttpDraftJobError("INVALID_INPUT");
  return digest(`BELLO_SHOPS_WEB_HTTP_CREATE\0${WEB_HTTP_SHOP_ID}\0${inventoryId.toLowerCase()}`);
}
export const B005396_WEB_HTTP_REQUEST_ID = webHttpDraftRequestId(B005396_INVENTORY_ID);

export type WebHttpReviewEvidence = B005396GeneralReviewEvidence | {
  sourceInventoryCode: string;
  sourcePriceYen: number;
  sourceQuantity: number;
  sourceShippingMethod: "KAZAI" | "SAGAWA";
  selectedQuantity: number;
  selectedCategoryId: string;
  selectedCategoryPath: string;
  categoryEvidence: "ADMIN_SELECTED_MASTER";
  shopsShipping: MercariManualListingPack["shipping"];
  imageCount: number;
  imageEvidence: "SAVED_REFERENCES_ONLY";
  shippingReviewRequired: true;
  status: "REVIEW_REQUIRED_NO_SEND";
};

/** Compare two independent BELLO reads before displaying a general HTTP review. */
export function inspectGeneralWebHttpPreparation(source: PrivateCreatePreparation,
  pack: MercariManualListingPack): WebHttpReviewEvidence | null {
  if (source.schemaVersion !== 1 || source.kind !== "BELLO_PRIVATE_CREATE_PREPARATION" ||
      BLOCKED_CODES.has(source.inventoryCode.toUpperCase()) ||
      !webHttpDraftTargetAllowed(source.inventoryId) ||
      source.shopId !== WEB_HTTP_SHOP_ID || pack.shopId !== source.shopId ||
      pack.inventoryId.toLowerCase() !== source.inventoryId.toLowerCase() ||
      pack.draftId !== source.draftId || pack.draftUpdatedAt !== source.draftUpdatedAt ||
      pack.title !== source.title || pack.description !== source.description ||
      pack.condition !== source.condition ||
      JSON.stringify(pack.imageRefs) !== JSON.stringify(source.imageRefs) ||
      pack.quantity < 1 || pack.quantity > source.quantity ||
      pack.status !== "PREPARED_NO_SEND" ||
      !pack.categoryId || !pack.categoryPath.startsWith("家具・インテリア > ") ||
      pack.managementCode !==
        `BELLO_${source.inventoryId.replace(/-/g, "").toUpperCase()}`)
    return null;
  return { sourceInventoryCode: source.inventoryCode,
    sourcePriceYen: source.priceYen, sourceQuantity: source.quantity,
    sourceShippingMethod: source.shippingMethod,
    selectedQuantity: pack.quantity, selectedCategoryId: pack.categoryId,
    selectedCategoryPath: pack.categoryPath,
    categoryEvidence: "ADMIN_SELECTED_MASTER",
    shopsShipping: pack.shipping, imageCount: pack.imageRefs.length,
    imageEvidence: "SAVED_REFERENCES_ONLY", shippingReviewRequired: true,
    status: "REVIEW_REQUIRED_NO_SEND" };
}

export type WebHttpDraftJob = {
  requestId: string;
  inventoryId: string;
  shopId: string;
  managementCode: string;
  snapshotFingerprint: string;
  snapshotJson: string;
  status: "AWAITING_HTTP_AUTH_AND_CREATE_CONTRACT";
  requestedBy: string;
  recordedAt: string;
};

export type WebHttpDraftJobRepository = {
  getJob: (requestId: string) => Promise<WebHttpDraftJob | null>;
  createJob: (job: WebHttpDraftJob) => Promise<void>;
};

export class WebHttpDraftJobError extends Error {
  readonly code: "INVALID_INPUT" | "JOB_CONFLICT" | "STORAGE_UNAVAILABLE";
  constructor(code: WebHttpDraftJobError["code"]) {
    super(code);
    this.code = code;
  }
}

/** Freeze one reviewed BELLO snapshot for a future server HTTP connector. No Shops call. */
export function buildWebHttpDraftJob(pack: MercariManualListingPack,
  evidence: WebHttpReviewEvidence, requestedBy: string,
  recordedAt = new Date().toISOString()): WebHttpDraftJob {
  if (!pack || pack.kind !== "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK" ||
      pack.schemaVersion !== 1 || pack.status !== "PREPARED_NO_SEND" ||
      !webHttpDraftTargetAllowed(pack.inventoryId) ||
      pack.shopId !== WEB_HTTP_SHOP_ID ||
      !UUID.test(pack.draftId) ||
      !Number.isFinite(Date.parse(pack.draftUpdatedAt)) ||
      pack.managementCode !==
        `BELLO_${pack.inventoryId.replace(/-/g, "").toUpperCase()}` ||
      !Number.isSafeInteger(pack.priceYen) || pack.priceYen < 300 ||
      pack.priceYen > 9_999_999 ||
      !Number.isSafeInteger(pack.quantity) || pack.quantity < 1 ||
      !pack.title?.trim() || !pack.description?.trim() ||
      !pack.categoryId || !pack.categoryPath?.startsWith("家具・インテリア > ") ||
      !Array.isArray(pack.imageRefs) || pack.imageRefs.length < 1 ||
      pack.imageRefs.length > 20 ||
      pack.shipping?.method !== "METHOD_TYPE_UNDECIDED" ||
      pack.shipping.payer !== "PAYER_TYPE_SELLER" ||
      pack.shipping.origin !== "jp11" ||
      pack.shipping.duration !== "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" ||
      !evidence || evidence.status !== "REVIEW_REQUIRED_NO_SEND" ||
      BLOCKED_CODES.has(evidence.sourceInventoryCode?.toUpperCase()) ||
      !/^[A-Za-z0-9_-]{1,40}$/.test(evidence.sourceInventoryCode) ||
      !Number.isSafeInteger(evidence.sourceQuantity) ||
      evidence.selectedQuantity !== pack.quantity ||
      evidence.selectedCategoryId !== pack.categoryId ||
      evidence.selectedCategoryPath !== pack.categoryPath ||
      evidence.sourceQuantity < pack.quantity ||
      !["KAZAI", "SAGAWA"].includes(evidence.sourceShippingMethod) ||
      evidence.imageEvidence !== "SAVED_REFERENCES_ONLY" ||
      evidence.shopsShipping !== pack.shipping &&
        JSON.stringify(evidence.shopsShipping) !== JSON.stringify(pack.shipping) ||
      evidence.imageCount !== pack.imageRefs.length ||
      evidence.shippingReviewRequired !== true ||
      pack.inventoryId.toLowerCase() === B005396_INVENTORY_ID &&
        (evidence.sourceInventoryCode !== "B005396" ||
          pack.priceYen !== B005396_REVIEW_PRICE_YEN || pack.quantity !== 1) ||
      typeof requestedBy !== "string" || !requestedBy.trim() ||
      !Number.isFinite(Date.parse(recordedAt)))
    throw new WebHttpDraftJobError("INVALID_INPUT");
  const snapshotJson = JSON.stringify({ schemaVersion: 1,
    transport: "BELLO_SERVER_HTTP", shippingReviewed: true, pack, evidence });
  return { requestId: webHttpDraftRequestId(pack.inventoryId),
    inventoryId: pack.inventoryId, shopId: pack.shopId,
    managementCode: pack.managementCode,
    snapshotFingerprint: digest(snapshotJson), snapshotJson,
    status: "AWAITING_HTTP_AUTH_AND_CREATE_CONTRACT",
    requestedBy, recordedAt };
}

function sameJob(left: WebHttpDraftJob, right: WebHttpDraftJob) {
  return left.requestId === right.requestId &&
    left.inventoryId === right.inventoryId && left.shopId === right.shopId &&
    left.managementCode === right.managementCode &&
    left.snapshotFingerprint === right.snapshotFingerprint &&
    left.snapshotJson === right.snapshotJson && left.status === right.status &&
    left.requestedBy === right.requestedBy;
}

/** A conditional create makes repeated clicks converge on the same frozen request. */
export async function reserveWebHttpDraftJob(pack: MercariManualListingPack,
  evidence: WebHttpReviewEvidence, requestedBy: string,
  repo: WebHttpDraftJobRepository) {
  const proposed = buildWebHttpDraftJob(pack, evidence, requestedBy);
  let existing: WebHttpDraftJob | null;
  try { existing = await repo.getJob(proposed.requestId); }
  catch { throw new WebHttpDraftJobError("STORAGE_UNAVAILABLE"); }
  if (!existing) {
    try { await repo.createJob(proposed); existing = proposed; }
    catch {
      try { existing = await repo.getJob(proposed.requestId); }
      catch { throw new WebHttpDraftJobError("STORAGE_UNAVAILABLE"); }
      if (!existing) throw new WebHttpDraftJobError("STORAGE_UNAVAILABLE");
    }
  }
  if (!sameJob(existing, proposed)) throw new WebHttpDraftJobError("JOB_CONFLICT");
  return { requestId: existing.requestId, status: existing.status,
    recordedAt: existing.recordedAt };
}
