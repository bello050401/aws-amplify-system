import { createHash } from "node:crypto";
import type { InventoryDetail } from "@/lib/inventory/queries";
import type { ChannelListingRecord, ListingDraftRecord } from "@/lib/listing/types";

export type ExistingProductBinding = {
  inventoryId: string;
  shopId: string;
  remoteId: string;
  source: "USER_REVIEWED_UI";
  requestedBy: string;
};

export type ExistingReadJob = {
  requestId: string;
  inventoryId: string;
  shopId: string;
  remoteId: string;
  operation: "READ_EXISTING";
  snapshotFingerprint: string;
  snapshotJson: string;
  status: "CONNECTOR_NOT_CONFIGURED";
  requestedBy: string;
};

export type ReviewedOverrides = {
  reason: string;
  title?: string;
  description?: string;
  priceYen?: number;
  quantity?: number;
};

export type ExistingReadInput = {
  inventory: Pick<InventoryDetail, "id" | "sku" | "quantity">;
  draft: ListingDraftRecord;
  channelListing: ChannelListingRecord | null;
  shopId: string;
  remoteId: string;
  requestedBy: string;
  reviewedOverrides?: ReviewedOverrides;
};

export type ReadRequestRepository = {
  getBinding: (inventoryId: string) => Promise<ExistingProductBinding | null>;
  createBinding: (binding: ExistingProductBinding) => Promise<void>;
  getJob: (requestId: string) => Promise<ExistingReadJob | null>;
  createJob: (job: ExistingReadJob) => Promise<void>;
};

export class ReadRequestError extends Error {
  readonly code: "INVALID_INPUT" | "BINDING_CONFLICT" | "JOB_CONFLICT" | "STORAGE_UNAVAILABLE";
  constructor(code: "INVALID_INPUT" | "BINDING_CONFLICT" | "JOB_CONFLICT" | "STORAGE_UNAVAILABLE",
    message: string) { super(message); this.code = code; }
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const validRemoteIdentifier = (value: string) => /^[A-Za-z0-9_-]{8,100}$/.test(value);
const validInventoryCode = (value: string) => /^[A-Za-z0-9_-]{1,100}$/.test(value);
const validMoney = (value: number) => Number.isSafeInteger(value) && value >= 0;
const validQuantity = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Preserve the exact BELLO values reviewed at request time. No product write or upload is implied. */
export function buildExistingReadJob(input: ExistingReadInput): ExistingReadJob {
  const { inventory, draft, channelListing, reviewedOverrides } = input;
  if (!inventory.id || !validInventoryCode(inventory.sku) || draft.inventoryId !== inventory.id ||
      !draft.id || !draft.updatedAt || !validRemoteIdentifier(input.shopId) ||
      !validRemoteIdentifier(input.remoteId) || !input.requestedBy ||
      !validQuantity(inventory.quantity) || !Array.isArray(draft.images) || draft.images.length > 50 ||
      draft.images.some((image) => !image || typeof image.storageKey !== "string" || !image.storageKey ||
        !Number.isSafeInteger(image.sortOrder)) ||
      (channelListing !== null && (channelListing.inventoryId !== inventory.id ||
        channelListing.listingDraftId !== draft.id || channelListing.channel !== "MERCARI_SHOPS"))) {
    throw new ReadRequestError("INVALID_INPUT", "照合対象の保存済みデータと既存商品IDを確認できません。");
  }
  if (reviewedOverrides) {
    if (typeof reviewedOverrides !== "object" || Array.isArray(reviewedOverrides) ||
        Object.keys(reviewedOverrides).some((key) =>
          !["reason", "title", "description", "priceYen", "quantity"].includes(key))) {
      throw new ReadRequestError("INVALID_INPUT", "確認済みの検証値が不正です。");
    }
    const { reason, title, description, priceYen, quantity } = reviewedOverrides;
    if (typeof reason !== "string" || !reason.trim() || reason.length > 500 ||
        (title !== undefined && (typeof title !== "string" || !title.trim() || title.length > 255)) ||
        (description !== undefined && (typeof description !== "string" || description.length > 10000)) ||
        (priceYen !== undefined && !validMoney(priceYen)) ||
        (quantity !== undefined && !validQuantity(quantity))) {
      throw new ReadRequestError("INVALID_INPUT", "確認済みの検証値が不正です。");
    }
  }

  const expected = {
    inventoryCode: inventory.sku,
    title: reviewedOverrides?.title ?? channelListing?.overrideTitle ?? draft.title,
    description: reviewedOverrides?.description ?? channelListing?.overrideDescription ?? draft.description ?? "",
    priceYen: reviewedOverrides?.priceYen ?? channelListing?.overridePrice ?? draft.price,
    quantity: reviewedOverrides?.quantity ?? inventory.quantity,
  };
  if (!expected.title?.trim() || expected.title.length > 255 ||
      expected.description.length > 10000 ||
      (expected.priceYen !== null && !validMoney(expected.priceYen))) {
    throw new ReadRequestError("INVALID_INPUT", "照合対象の下書きを確認できません。");
  }
  const snapshotJson = JSON.stringify({
    version: 1,
    operation: "READ_EXISTING",
    shopId: input.shopId,
    remoteId: input.remoteId,
    inventoryId: inventory.id,
    draftId: draft.id,
    draftUpdatedAt: draft.updatedAt,
    channelListingId: channelListing?.id ?? null,
    channelListingUpdatedAt: channelListing?.updatedAt ?? null,
    expected,
    draftValues: { title: draft.title, description: draft.description, priceYen: draft.price,
      condition: draft.condition, shippingMethod: draft.shippingMethod },
    channelValues: channelListing ? { title: channelListing.overrideTitle,
      description: channelListing.overrideDescription, priceYen: channelListing.overridePrice,
      categoryMapping: channelListing.categoryMapping } : null,
    imageRefs: draft.images.map(({ storageKey, sortOrder, source, photoAssetId }) =>
      ({ storageKey, sortOrder, source: source ?? "INVENTORY", photoAssetId: photoAssetId ?? null })),
    reviewedOverrides: reviewedOverrides ? {
      reason: reviewedOverrides.reason,
      title: reviewedOverrides.title ?? null,
      description: reviewedOverrides.description ?? null,
      priceYen: reviewedOverrides.priceYen ?? null,
      quantity: reviewedOverrides.quantity ?? null,
    } : null,
  });
  const snapshotFingerprint = digest(snapshotJson);
  return {
    requestId: digest(`READ_EXISTING\0${inventory.id}\0${input.shopId}\0${input.remoteId}\0${snapshotFingerprint}`),
    inventoryId: inventory.id,
    shopId: input.shopId,
    remoteId: input.remoteId,
    operation: "READ_EXISTING",
    snapshotFingerprint,
    snapshotJson,
    status: "CONNECTOR_NOT_CONFIGURED",
    requestedBy: input.requestedBy,
  };
}

const sameBinding = (left: ExistingProductBinding, right: ExistingProductBinding) =>
  left.inventoryId === right.inventoryId && left.shopId === right.shopId && left.remoteId === right.remoteId &&
  left.source === "USER_REVIEWED_UI" && left.requestedBy === right.requestedBy;
const sameJob = (left: ExistingReadJob, right: ExistingReadJob) =>
  left.requestId === right.requestId && left.inventoryId === right.inventoryId && left.shopId === right.shopId &&
  left.remoteId === right.remoteId && left.operation === "READ_EXISTING" &&
  left.snapshotFingerprint === right.snapshotFingerprint && left.snapshotJson === right.snapshotJson &&
  left.status === "CONNECTOR_NOT_CONFIGURED" && left.requestedBy === right.requestedBy;

/** Conditional creates in the repository make retries and simultaneous clicks converge on one read request. */
export async function reserveExistingReadRequest(input: ExistingReadInput, repo: ReadRequestRepository):
  Promise<{ ok: false; code: "CONNECTOR_NOT_CONFIGURED"; requestId: string }> {
  const job = buildExistingReadJob(input);
  const proposedBinding: ExistingProductBinding = { inventoryId: job.inventoryId,
    shopId: job.shopId, remoteId: job.remoteId, source: "USER_REVIEWED_UI", requestedBy: job.requestedBy };
  let binding: ExistingProductBinding | null;
  try { binding = await repo.getBinding(job.inventoryId); }
  catch { throw new ReadRequestError("STORAGE_UNAVAILABLE", "既存商品の紐付けを確認できません。"); }
  if (!binding) {
    try { await repo.createBinding(proposedBinding); binding = proposedBinding; }
    catch {
      try { binding = await repo.getBinding(job.inventoryId); }
      catch { throw new ReadRequestError("STORAGE_UNAVAILABLE", "既存商品の紐付けを確認できません。"); }
      if (!binding) throw new ReadRequestError("STORAGE_UNAVAILABLE", "既存商品の紐付けを保存できません。");
    }
  }
  if (!sameBinding(binding, proposedBinding))
    throw new ReadRequestError("BINDING_CONFLICT", "この在庫には別の既存商品が紐付いています。");

  let existing: ExistingReadJob | null;
  try { existing = await repo.getJob(job.requestId); }
  catch { throw new ReadRequestError("STORAGE_UNAVAILABLE", "読取依頼を確認できません。"); }
  if (!existing) {
    try { await repo.createJob(job); existing = job; }
    catch {
      try { existing = await repo.getJob(job.requestId); }
      catch { throw new ReadRequestError("STORAGE_UNAVAILABLE", "読取依頼を確認できません。"); }
      if (!existing) throw new ReadRequestError("STORAGE_UNAVAILABLE", "読取依頼を保存できません。");
    }
  }
  if (!sameJob(existing, job)) throw new ReadRequestError("JOB_CONFLICT", "同じ依頼IDに異なる内容が保存されています。");
  return { ok: false, code: "CONNECTOR_NOT_CONFIGURED", requestId: job.requestId };
}
