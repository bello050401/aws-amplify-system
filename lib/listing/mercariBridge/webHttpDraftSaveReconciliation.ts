import "server-only";

import { initialWebHttpExecutionState } from "./webHttpExecutionGate.ts";
import type { WebHttpDraftJob } from "./webHttpDraftJob.ts";
import type { WebHttpSendAttempt,
  WebHttpSendReservationRepository,
  WebHttpObservedSendStage } from "./webHttpSendReservation.ts";
import { webHttpStageRequestId } from "./webHttpSendReservation.ts";

export type WebHttpDraftCandidate = {
  id: string;
  shopId: string;
  name: string;
  description: string;
  price: number;
  quantity: number;
  skuCode: string;
  thumbnailCount: number;
};
export type WebHttpDraftReadback = {
  /** Both calls must use the same authenticated server-side session. */
  verifyTargetShop: () => Promise<{
    status: "VERIFIED" | "AUTH_REQUIRED" | "UNKNOWN";
    shopMatched: boolean;
  }>;
  /** A future adapter must exhaust observed productDrafts pagination. */
  listDraftCandidates: (shopId: string) => Promise<{
    status: "OK" | "AUTH_REQUIRED" | "UNKNOWN";
    complete: boolean;
    candidates: WebHttpDraftCandidate[];
  }>;
};
export type WebHttpDraftReconciliation = {
  status: "INVALID_JOB" | "ATTEMPT_UNKNOWN_NO_RESEND" |
    "AUTH_REQUIRED_NO_RESEND" | "SHOP_UNVERIFIED_NO_RESEND" |
    "READ_UNVERIFIED_NO_RESEND" | "MATCHING_DRAFT_OBSERVED_NO_RESEND" |
    "MULTIPLE_DRAFTS_NO_RESEND" | "NO_MATCH_NO_RESEND";
  /** A matching row is not proof that this attempt created it. */
  observedDraftId: string | null;
  allowCreate: false;
  allowUpdate: false;
  allowPublish: false;
};

const result = (status: WebHttpDraftReconciliation["status"],
  observedDraftId: string | null = null): WebHttpDraftReconciliation => ({
  status, observedDraftId, allowCreate: false, allowUpdate: false,
  allowPublish: false,
});
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sameAttempt = (attempt: WebHttpSendAttempt, job: WebHttpDraftJob,
  requestId: string) =>
  (attempt.status === "RESERVED_NO_SEND" ||
    attempt.status === "SEND_CLAIMED_RESULT_UNKNOWN" ||
    attempt.status === "DRAFT_ACKNOWLEDGED") &&
  attempt.requestId === requestId &&
  attempt.inventoryId === job.inventoryId &&
  attempt.shopId === job.shopId &&
  attempt.snapshotFingerprint === job.snapshotFingerprint;

/**
 * Read-only follow-up after an attempt may have reached Shops. No result,
 * including absence, authorizes a repeat create or a draft update.
 */
export async function reconcileReservedWebHttpDraft(
  job: WebHttpDraftJob,
  repository: Pick<WebHttpSendReservationRepository, "getAttempt">,
  readback: WebHttpDraftReadback,
  stage?: Extract<WebHttpObservedSendStage,
    { kind: "DRAFT_CREATE" | "DRAFT_UPDATE" }>,
): Promise<WebHttpDraftReconciliation> {
  const requestId = stage ? webHttpStageRequestId(job, stage) : job.requestId;
  if (!initialWebHttpExecutionState(job) ||
      !requestId ||
      !repository || typeof repository.getAttempt !== "function" ||
      !readback || typeof readback.verifyTargetShop !== "function" ||
      typeof readback.listDraftCandidates !== "function")
    return result("INVALID_JOB");
  let attempt: WebHttpSendAttempt | null;
  try { attempt = await repository.getAttempt(requestId); }
  catch { return result("ATTEMPT_UNKNOWN_NO_RESEND"); }
  if (!attempt || !sameAttempt(attempt, job, requestId))
    return result("ATTEMPT_UNKNOWN_NO_RESEND");
  let shop: Awaited<ReturnType<WebHttpDraftReadback["verifyTargetShop"]>>;
  try { shop = await readback.verifyTargetShop(); }
  catch { return result("SHOP_UNVERIFIED_NO_RESEND"); }
  if (shop.status === "AUTH_REQUIRED")
    return result("AUTH_REQUIRED_NO_RESEND");
  if (shop.status !== "VERIFIED" || shop.shopMatched !== true)
    return result("SHOP_UNVERIFIED_NO_RESEND");
  let page: Awaited<ReturnType<WebHttpDraftReadback["listDraftCandidates"]>>;
  try { page = await readback.listDraftCandidates(job.shopId); }
  catch { return result("READ_UNVERIFIED_NO_RESEND"); }
  if (page?.status === "AUTH_REQUIRED")
    return result("AUTH_REQUIRED_NO_RESEND");
  if (page?.status !== "OK" || page.complete !== true ||
      !Array.isArray(page.candidates))
    return result("READ_UNVERIFIED_NO_RESEND");
  let pack: Record<string, unknown>;
  try {
    const snapshot: unknown = JSON.parse(job.snapshotJson);
    if (!object(snapshot) || !object(snapshot.pack)) throw Error("snapshot");
    pack = snapshot.pack;
  } catch { return result("INVALID_JOB"); }
  const sameSku = page.candidates.filter(candidate =>
    object(candidate) && candidate.shopId === job.shopId &&
    candidate.skuCode === job.managementCode);
  if (sameSku.length > 1) return result("MULTIPLE_DRAFTS_NO_RESEND");
  if (sameSku.length === 0) return result("NO_MATCH_NO_RESEND");
  const candidate = sameSku[0];
  if (typeof candidate.id !== "string" ||
      !/^[A-Za-z0-9]{1,64}$/.test(candidate.id))
    return result("READ_UNVERIFIED_NO_RESEND");
  // The observed CreateProductDraft readback has price 0 and no thumbnail;
  // UpdateProductDraft fills those fields later. This is observation only:
  // even a unique match does not prove this attempt created the draft.
  const expectedInitialCreate = stage?.kind === "DRAFT_CREATE" &&
    candidate.price === 0 && candidate.thumbnailCount === 0;
  const expectedCompletedDraft = candidate.price === pack.priceYen &&
    candidate.thumbnailCount ===
      (Array.isArray(pack.imageRefs) ? pack.imageRefs.length : -1);
  if (candidate.name !== pack.title ||
      candidate.description !== pack.description ||
      candidate.quantity !== pack.quantity ||
      !expectedInitialCreate && !expectedCompletedDraft)
    return result("NO_MATCH_NO_RESEND");
  return result("MATCHING_DRAFT_OBSERVED_NO_RESEND", candidate.id);
}
