"use server";

import { getCurrentInventoryUserEmail, getInventoryRole } from
  "@/lib/amplify/requireInventoryUser";
import { prepareB005396GeneralPreparationAction } from
  "@/app/actions/mercariB005396GeneralPreparation";
import type { MercariManualListingPack } from
  "@/app/actions/mercariManualListingPack";
import { B005396_WEB_HTTP_REQUEST_ID, B005396_WEB_HTTP_SHOP_ID,
  reserveWebHttpDraftJob, WebHttpDraftJobError } from
  "@/lib/listing/mercariBridge/webHttpDraftJob";
import { B005396_INVENTORY_ID } from
  "@/lib/listing/mercariBridge/b005396GeneralPreparation";
import { webHttpDraftJobRepository } from
  "@/lib/listing/mercariBridge/webHttpDraftJobRepository";

const canonical = (value: unknown): unknown => Array.isArray(value) ?
  value.map(canonical) : value !== null && typeof value === "object" ?
    Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right)).map(([key, child]) => [key, canonical(child)])) : value;

/** Freeze the current BELLO snapshot in the Web database; never contact Shops. */
export async function reserveB005396WebHttpDraftJobAction(
  reviewedPack: MercariManualListingPack, shippingReviewed: boolean,
): Promise<{ ok: true; requestId: string; status: "AWAITING_HTTP_AUTH_AND_CREATE_CONTRACT" } |
  { ok: false; code: "FORBIDDEN" | "INVALID_INPUT" | "PACK_CHANGED" |
    "JOB_CONFLICT" | "STORAGE_UNAVAILABLE" }> {
  if (await getInventoryRole() !== "ADMIN") return { ok: false, code: "FORBIDDEN" };
  if (shippingReviewed !== true || !reviewedPack ||
      reviewedPack.kind !== "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK")
    return { ok: false, code: "INVALID_INPUT" };
  try {
    const principal = await getCurrentInventoryUserEmail();
    if (!principal) return { ok: false, code: "FORBIDDEN" };
    const current = await prepareB005396GeneralPreparationAction({
      quantity: reviewedPack.quantity, categoryId: reviewedPack.categoryId,
      brandId: reviewedPack.brandId,
    });
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

/** Display the persisted Web request state; this performs no Shops read. */
export async function getB005396WebHttpDraftJobStatusAction(): Promise<
  { ok: true; status: "NOT_PREPARED"; requestId: null; recordedAt: null } |
  { ok: true; status: "AWAITING_HTTP_AUTH_AND_CREATE_CONTRACT";
    requestId: string; recordedAt: string } |
  { ok: false; code: "FORBIDDEN" | "STORAGE_UNAVAILABLE" }
> {
  if (await getInventoryRole() !== "ADMIN") return { ok: false, code: "FORBIDDEN" };
  try {
    const job = await webHttpDraftJobRepository.getJob(B005396_WEB_HTTP_REQUEST_ID);
    if (!job) return { ok: true, status: "NOT_PREPARED",
      requestId: null, recordedAt: null };
    if (job.requestId !== B005396_WEB_HTTP_REQUEST_ID ||
        job.inventoryId.toLowerCase() !== B005396_INVENTORY_ID ||
        job.shopId !== B005396_WEB_HTTP_SHOP_ID ||
        job.status !== "AWAITING_HTTP_AUTH_AND_CREATE_CONTRACT" ||
        !/^[a-f0-9]{64}$/.test(job.snapshotFingerprint) ||
        !Number.isFinite(Date.parse(job.recordedAt)))
      return { ok: false, code: "STORAGE_UNAVAILABLE" };
    return { ok: true, status: job.status, requestId: job.requestId,
      recordedAt: job.recordedAt };
  } catch { return { ok: false, code: "STORAGE_UNAVAILABLE" }; }
}
