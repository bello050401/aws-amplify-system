import { createHash } from "node:crypto";
import type { MercariManualListingPack } from "@/app/actions/mercariManualListingPack";
import { B005396_INVENTORY_ID, B005396_REVIEW_PRICE_YEN,
  type B005396GeneralReviewEvidence } from
  "./b005396GeneralPreparation.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

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
  evidence: B005396GeneralReviewEvidence, requestedBy: string,
  recordedAt = new Date().toISOString()): WebHttpDraftJob {
  if (!pack || pack.kind !== "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK" ||
      pack.status !== "PREPARED_NO_SEND" ||
      pack.inventoryId.toLowerCase() !== B005396_INVENTORY_ID ||
      pack.priceYen !== B005396_REVIEW_PRICE_YEN || pack.quantity !== 1 ||
      !pack.shopId || !pack.managementCode || !pack.draftId ||
      !evidence || evidence.status !== "REVIEW_REQUIRED_NO_SEND" ||
      evidence.sourceInventoryCode !== "B005396" ||
      evidence.selectedQuantity !== pack.quantity ||
      evidence.selectedCategoryId !== pack.categoryId ||
      evidence.selectedCategoryPath !== pack.categoryPath ||
      evidence.sourceQuantity < pack.quantity ||
      evidence.imageEvidence !== "SAVED_REFERENCES_ONLY" ||
      evidence.shopsShipping !== pack.shipping &&
        JSON.stringify(evidence.shopsShipping) !== JSON.stringify(pack.shipping) ||
      evidence.imageCount !== pack.imageRefs.length ||
      evidence.shippingReviewRequired !== true ||
      typeof requestedBy !== "string" || !requestedBy.trim() ||
      !Number.isFinite(Date.parse(recordedAt)))
    throw new WebHttpDraftJobError("INVALID_INPUT");
  const snapshotJson = JSON.stringify({ schemaVersion: 1,
    transport: "BELLO_SERVER_HTTP", shippingReviewed: true, pack, evidence });
  return { requestId: digest(`BELLO_SHOPS_WEB_HTTP_CREATE\0${pack.shopId}\0${pack.inventoryId}`),
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
  evidence: B005396GeneralReviewEvidence, requestedBy: string,
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
  return { requestId: existing.requestId, status: existing.status };
}
