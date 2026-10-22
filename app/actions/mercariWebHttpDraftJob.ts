"use server";

import { getCurrentInventoryUserEmail, getInventoryRole } from
  "@/lib/amplify/requireInventoryUser";
import { getInventoryDetail, listCategories } from "@/lib/inventory/queries";
import { isEcListingEligible } from "@/lib/listing/ecEligibility";
import { getMercariPrivateCreatePreparationAction } from
  "@/app/actions/mercariPrivateCreatePreparation";
import { prepareMercariManualListingPackAction,
  type MercariManualListingPack } from
  "@/app/actions/mercariManualListingPack";
import { B005396_INVENTORY_ID } from
  "@/lib/listing/mercariBridge/b005396GeneralPreparation";
import { inspectGeneralWebHttpPreparation,
  reserveWebHttpDraftJob, webHttpDraftRequestId, webHttpDraftTargetAllowed,
  WebHttpDraftJobError, type WebHttpReviewEvidence } from
  "@/lib/listing/mercariBridge/webHttpDraftJob";
import { initialWebHttpExecutionState } from
  "@/lib/listing/mercariBridge/webHttpExecutionGate";
import { webHttpDraftJobRepository } from
  "@/lib/listing/mercariBridge/webHttpDraftJobRepository";
import { webHttpPrivateDraftLinkRepository } from
  "@/lib/listing/mercariBridge/webHttpPrivateDraftLinkRepository";

const canonical = (value: unknown): unknown => Array.isArray(value) ?
  value.map(canonical) : value !== null && typeof value === "object" ?
    Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right)).map(([key, child]) => [key, canonical(child)])) : value;

import type { ShopsDeliveryMethod } from "@/lib/listing/mercariBridge/listingShipping";
type Selection = { priceYen: number; quantity: number; categoryId: string;
  brandId: string | null; shippingMethod?: ShopsDeliveryMethod; descriptionSuffix?: string };
type PreparationResult = { ok: true; pack: MercariManualListingPack;
  evidence: WebHttpReviewEvidence } |
  { ok: false; code: "FORBIDDEN" | "BLOCKED_TARGET" | "PREPARATION_UNAVAILABLE" };

/** Two BELLO reads establish the review pack; neither makes a Shops request. */
export async function prepareMercariWebHttpDraftJobAction(inventoryId: string,
  selected: Selection): Promise<PreparationResult> {
  if (await getInventoryRole() !== "ADMIN") return { ok: false, code: "FORBIDDEN" };
  if (!webHttpDraftTargetAllowed(inventoryId) ||
      inventoryId.toLowerCase() === B005396_INVENTORY_ID)
    return { ok: false, code: "BLOCKED_TARGET" };
  try {
    const inventory = await getInventoryDetail(inventoryId);
    if (!inventory || inventory.id.toLowerCase() !== inventoryId.toLowerCase() ||
        inventory.sku.toUpperCase() === "B005396" ||
        inventory.saleEndDate !== null || inventory.quantity < 1 ||
        inventory.market !== null &&
          (!inventory.market.trim() || /メルカリ|mercari/i.test(inventory.market)))
      return { ok: false, code: "BLOCKED_TARGET" };
    const category = (await listCategories(inventory.categoryId)).find(
      entry => entry.id === inventory.categoryId)?.name ?? null;
    if (!category || !isEcListingEligible(category) ||
        category.normalize("NFKC").trim() === "売り切れ")
      return { ok: false, code: "BLOCKED_TARGET" };
    const source = await getMercariPrivateCreatePreparationAction(inventoryId);
    if (!source.ok) return { ok: false, code: "PREPARATION_UNAVAILABLE" };
    const current = await prepareMercariManualListingPackAction(inventoryId, selected);
    if (!current.ok) return { ok: false, code: "PREPARATION_UNAVAILABLE" };
    const evidence = inspectGeneralWebHttpPreparation(source.preparation, current.pack);
    return evidence ? { ok: true, pack: current.pack, evidence } :
      { ok: false, code: "PREPARATION_UNAVAILABLE" };
  } catch { return { ok: false, code: "PREPARATION_UNAVAILABLE" }; }
}

type ReserveResult = { ok: true; requestId: string;
  status: "AWAITING_HTTP_AUTH_AND_CREATE_CONTRACT"; recordedAt: string } |
  { ok: false; code: "FORBIDDEN" | "BLOCKED_TARGET" | "INVALID_INPUT" |
    "PACK_CHANGED" | "JOB_CONFLICT" | "STORAGE_UNAVAILABLE" };

/** Freeze the current BELLO snapshot in the Web database; never contact Shops. */
export async function reserveMercariWebHttpDraftJobAction(
  reviewedPack: MercariManualListingPack, shippingReviewed: boolean,
): Promise<ReserveResult> {
  if (await getInventoryRole() !== "ADMIN") return { ok: false, code: "FORBIDDEN" };
  if (shippingReviewed !== true || !reviewedPack ||
      reviewedPack.kind !== "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK")
    return { ok: false, code: "INVALID_INPUT" };
  if (!webHttpDraftTargetAllowed(reviewedPack.inventoryId) ||
      reviewedPack.inventoryId.toLowerCase() === B005396_INVENTORY_ID)
    return { ok: false, code: "BLOCKED_TARGET" };
  try {
    const principal = await getCurrentInventoryUserEmail();
    if (!principal) return { ok: false, code: "FORBIDDEN" };
    const current = await prepareMercariWebHttpDraftJobAction(
      reviewedPack.inventoryId, { priceYen: reviewedPack.priceYen,
        quantity: reviewedPack.quantity, categoryId: reviewedPack.categoryId,
        brandId: reviewedPack.brandId, shippingMethod:reviewedPack.shipping.method, descriptionSuffix:reviewedPack.descriptionSuffix });
    if (!current.ok || JSON.stringify(canonical(current.pack)) !==
        JSON.stringify(canonical(reviewedPack)))
      return { ok: false, code: "PACK_CHANGED" };
    const job = await reserveWebHttpDraftJob(current.pack, current.evidence,
      principal, webHttpDraftJobRepository);
    return { ok: true, ...job };
  } catch (error) {
    if (error instanceof WebHttpDraftJobError)
      return { ok: false, code: error.code };
    return { ok: false, code: "STORAGE_UNAVAILABLE" };
  }
}

/** Read only BELLO's persisted request; no Shops result is inferred. */
export async function getMercariWebHttpDraftJobStatusAction(inventoryId: string): Promise<
  { ok: true; status: "NOT_PREPARED"; requestId: null;
    recordedAt: null; remoteDraftId: null } |
  { ok: true; status: "AWAITING_HTTP_AUTH_AND_CREATE_CONTRACT";
    requestId: string; recordedAt: string; remoteDraftId: null } |
  { ok: true; status: "PRIVATE_DRAFT_VERIFIED";
    requestId: string; recordedAt: string; remoteDraftId: string } |
  { ok: false; code: "FORBIDDEN" | "BLOCKED_TARGET" | "STORAGE_UNAVAILABLE" }
> {
  if (await getInventoryRole() !== "ADMIN") return { ok: false, code: "FORBIDDEN" };
  if (!webHttpDraftTargetAllowed(inventoryId) ||
      inventoryId.toLowerCase() === B005396_INVENTORY_ID)
    return { ok: false, code: "BLOCKED_TARGET" };
  try {
    const requestId = webHttpDraftRequestId(inventoryId);
    const job = await webHttpDraftJobRepository.getJob(requestId);
    if (!job) return { ok: true, status: "NOT_PREPARED",
      requestId: null, recordedAt: null, remoteDraftId: null };
    if (!initialWebHttpExecutionState(job) ||
        job.requestId !== requestId ||
        job.inventoryId.toLowerCase() !== inventoryId.toLowerCase() ||
        !Number.isFinite(Date.parse(job.recordedAt)))
      return { ok: false, code: "STORAGE_UNAVAILABLE" };
    const link = await webHttpPrivateDraftLinkRepository.get(inventoryId);
    if (link && (link.inventoryId !== job.inventoryId ||
        link.shopId !== job.shopId ||
        link.requestId !== job.requestId ||
        link.snapshotFingerprint !== job.snapshotFingerprint ||
        link.status !== "PRIVATE_DRAFT_VERIFIED" ||
        !/^[A-Za-z0-9]{1,64}$/.test(link.remoteDraftId)))
      return { ok: false, code: "STORAGE_UNAVAILABLE" };
    return link ? { ok: true, status: "PRIVATE_DRAFT_VERIFIED",
      requestId: job.requestId, recordedAt: job.recordedAt,
      remoteDraftId: link.remoteDraftId } :
      { ok: true, status: job.status, requestId: job.requestId,
        recordedAt: job.recordedAt, remoteDraftId: null };
  } catch { return { ok: false, code: "STORAGE_UNAVAILABLE" }; }
}
