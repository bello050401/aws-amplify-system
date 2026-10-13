import "server-only";

import type { WebHttpDraftJob } from "./webHttpDraftJob.ts";
import { initialWebHttpExecutionState } from "./webHttpExecutionGate.ts";
import { readAcknowledgedDraftTargetProof,
  readAcknowledgedUpdatedDraftProof,
  type VerifiedUpdatedDraftReadback } from
  "./webHttpAcknowledgedProofs.ts";
import type { WebHttpSendAttempt } from "./webHttpSendReservation.ts";

export type WebHttpPrivateDraftLink = {
  inventoryId: string; shopId: string; remoteDraftId: string;
  requestId: string; snapshotFingerprint: string;
  status: "PRIVATE_DRAFT_VERIFIED"; verifiedAt: string;
};
type Attempts = { getAttempt(requestId: string): Promise<WebHttpSendAttempt | null> };
export type PrivateDraftLinkRepository = {
  /** Must reject an existing inventoryId, even if another request races. */
  createIfAbsent(link: WebHttpPrivateDraftLink): Promise<void>;
  get(inventoryId: string): Promise<WebHttpPrivateDraftLink | null>;
};
export type PrivateDraftLinkResult =
  { status: "RECORDED" | "ALREADY_RECORDED";
    link: WebHttpPrivateDraftLink; listingConfirmed: false } |
  { status: "UNVERIFIED" | "CONFLICT" | "STORAGE_UNKNOWN";
    link: null; listingConfirmed: false };

/** Save only a fully read-back private draft. Failure does not authorize a
 * second Shops write; the same durable ACK can be reconciled again locally.
 */
export async function recordVerifiedPrivateDraftLink(
  job: WebHttpDraftJob, draftId: string, preparedJpegSha256: string,
  attempts: Attempts, readback: VerifiedUpdatedDraftReadback,
  links: PrivateDraftLinkRepository,
  nowIso = new Date().toISOString()): Promise<PrivateDraftLinkResult> {
  const fail = (status: "UNVERIFIED" | "CONFLICT" | "STORAGE_UNKNOWN") =>
    ({ status, link: null, listingConfirmed: false } as const);
  if (!initialWebHttpExecutionState(job) ||
      !Number.isFinite(Date.parse(nowIso)) ||
      typeof links?.createIfAbsent !== "function" ||
      typeof links?.get !== "function") return fail("UNVERIFIED");
  const created = await readAcknowledgedDraftTargetProof(job, attempts,
    async id => {
      const remote = await readback(id);
      return { status: remote.status, shopId: remote.shopId,
        draftId: remote.draftId, skuCode: remote.skuCode,
        name: remote.name, description: remote.description };
    });
  if (!created || created.draftId !== draftId) return fail("UNVERIFIED");
  const proof = await readAcknowledgedUpdatedDraftProof(job, draftId,
    preparedJpegSha256, attempts, readback);
  if (!proof) return fail("UNVERIFIED");
  const link: WebHttpPrivateDraftLink = {
    inventoryId: proof.inventoryId, shopId: proof.shopId,
    remoteDraftId: proof.draftId, requestId: job.requestId,
    snapshotFingerprint: proof.snapshotFingerprint,
    status: "PRIVATE_DRAFT_VERIFIED", verifiedAt: nowIso,
  };
  const same = (existing: WebHttpPrivateDraftLink | null) => Boolean(existing &&
    existing.inventoryId === link.inventoryId &&
    existing.shopId === link.shopId &&
    existing.remoteDraftId === link.remoteDraftId &&
    existing.requestId === link.requestId &&
    existing.snapshotFingerprint === link.snapshotFingerprint &&
    existing.status === "PRIVATE_DRAFT_VERIFIED");
  let existing: WebHttpPrivateDraftLink | null;
  try { existing = await links.get(job.inventoryId); }
  catch { return fail("STORAGE_UNKNOWN"); }
  if (existing) return same(existing) ?
    { status: "ALREADY_RECORDED", link: existing, listingConfirmed: false } :
    fail("CONFLICT");
  try {
    await links.createIfAbsent(link);
    return { status: "RECORDED", link, listingConfirmed: false };
  } catch {
    // A conditional-create race or lost response is not a second draft.
    try { existing = await links.get(job.inventoryId); }
    catch { return fail("STORAGE_UNKNOWN"); }
    return same(existing) ?
      { status: "ALREADY_RECORDED", link: existing!, listingConfirmed: false } :
      existing ? fail("CONFLICT") : fail("STORAGE_UNKNOWN");
  }
}
