import "server-only";

import type { WebHttpDraftJob } from "./webHttpDraftJob.ts";
import { initialWebHttpExecutionState } from "./webHttpExecutionGate.ts";
import type { ObservedDraftAssetProof,
  ObservedDraftTargetProof } from "./webHttpObservedDraftWrite.ts";
import { webHttpStageRequestId,
  type WebHttpSendAttempt } from "./webHttpSendReservation.ts";

type Repository = {
  /** Must be a strongly consistent read of the durable attempt table. */
  getAttempt(requestId: string): Promise<WebHttpSendAttempt | null>;
};
export type VerifiedCreatedDraftReadback = (draftId: string) => Promise<{
  status: "VERIFIED" | "AUTH_REQUIRED" | "UNKNOWN";
  shopId: string | null;
  draftId: string | null;
  skuCode: string | null;
  name: string | null;
  description: string | null;
}>;
export type VerifiedUpdatedDraftReadback = (draftId: string) => Promise<{
  status: "VERIFIED" | "AUTH_REQUIRED" | "UNKNOWN";
  shopId: string | null; draftId: string | null;
  skuCode: string | null; name: string | null;
  description: string | null; price: number | null;
  quantity: number | null; categoryId: string | null;
  conditionId: string | null; imageAssetIds: string[] | null;
  shippingMethodId: string | null; shippingPayerId: string | null;
  shippingDurationId: string | null; shippingFromStateId: string | null;
}>;
export type VerifiedUpdatedDraftProof = {
  status: "VERIFIED_PRIVATE_DRAFT_CONTENT";
  inventoryId: string; shopId: string; draftId: string;
  snapshotFingerprint: string;
};
const REMOTE_ID = /^[A-Za-z0-9]{1,64}$/;

function sameJob(attempt: WebHttpSendAttempt | null,
  job: WebHttpDraftJob, requestId: string): boolean {
  return Boolean(attempt && attempt.requestId === requestId &&
    attempt.inventoryId === job.inventoryId &&
    attempt.shopId === job.shopId &&
    attempt.snapshotFingerprint === job.snapshotFingerprint &&
    attempt.requestedBy === job.requestedBy);
}

/** A response held only in process memory is never enough for a later step. */
export async function readAcknowledgedImageAssetProof(
  job: WebHttpDraftJob, preparedJpegSha256: string,
  repository: Repository): Promise<ObservedDraftAssetProof | null> {
  if (!initialWebHttpExecutionState(job) || !repository ||
      typeof repository.getAttempt !== "function") return null;
  const requestId = webHttpStageRequestId(job,
    { kind: "IMAGE_UPLOAD", preparedJpegSha256 });
  if (!requestId) return null;
  let attempt: WebHttpSendAttempt | null;
  try { attempt = await repository.getAttempt(requestId); }
  catch { return null; }
  if (!sameJob(attempt, job, requestId) ||
      attempt?.status !== "IMAGE_ACKNOWLEDGED" ||
      attempt.preparedJpegSha256 !== preparedJpegSha256 ||
      typeof attempt.remoteAssetId !== "string" ||
      !REMOTE_ID.test(attempt.remoteAssetId)) return null;
  return { status: "VERIFIED_SAME_IMAGE_BYTES",
    shopId: job.shopId, inventoryId: job.inventoryId,
    snapshotFingerprint: job.snapshotFingerprint,
    remoteAssetId: attempt.remoteAssetId, imageRefCount: 1 };
}

/** Both the durable create acknowledgement and a fresh authenticated read are
 * required before the next stage may address a remote draft.
 */
export async function readAcknowledgedDraftTargetProof(
  job: WebHttpDraftJob,
  repository: Repository,
  readback: VerifiedCreatedDraftReadback):
  Promise<ObservedDraftTargetProof | null> {
  if (!initialWebHttpExecutionState(job) || !repository ||
      typeof repository.getAttempt !== "function" ||
      typeof readback !== "function") return null;
  const requestId = webHttpStageRequestId(job, { kind: "DRAFT_CREATE" });
  if (!requestId) return null;
  let attempt: WebHttpSendAttempt | null;
  try { attempt = await repository.getAttempt(requestId); }
  catch { return null; }
  if (!sameJob(attempt, job, requestId) ||
      attempt?.status !== "DRAFT_ACKNOWLEDGED" ||
      attempt.draftMutationKind !== "CREATE" ||
      typeof attempt.remoteDraftId !== "string" ||
      !REMOTE_ID.test(attempt.remoteDraftId)) return null;
  let frozen: { name: string; description: string };
  try {
    const pack = JSON.parse(job.snapshotJson).pack;
    if (typeof pack?.title !== "string" ||
        typeof pack?.description !== "string") return null;
    frozen = { name: pack.title, description: pack.description };
  } catch { return null; }
  let remote: Awaited<ReturnType<VerifiedCreatedDraftReadback>>;
  try { remote = await readback(attempt.remoteDraftId); }
  catch { return null; }
  if (remote?.status !== "VERIFIED" ||
      remote.shopId !== job.shopId ||
      remote.draftId !== attempt.remoteDraftId ||
      remote.skuCode !== job.managementCode ||
      remote.name !== frozen.name ||
      remote.description !== frozen.description) return null;
  return { status: "VERIFIED_SAME_JOB_DRAFT",
    shopId: job.shopId, inventoryId: job.inventoryId,
    snapshotFingerprint: job.snapshotFingerprint,
    draftId: attempt.remoteDraftId };
}

/** An update acknowledgement is only a send result. Confirm every required
 * field in a new authenticated read before recording a private draft link.
 * This never grants publication or an ACTIVE listing status.
 */
export async function readAcknowledgedUpdatedDraftProof(
  job: WebHttpDraftJob, draftId: string, preparedJpegSha256: string | string[],
  repository: Repository, readback: VerifiedUpdatedDraftReadback):
  Promise<VerifiedUpdatedDraftProof | null> {
  const hashes = Array.isArray(preparedJpegSha256) ? preparedJpegSha256 : [preparedJpegSha256];
  if (!initialWebHttpExecutionState(job) || !REMOTE_ID.test(draftId) ||
      hashes.length < 1 || hashes.length > 20 || hashes.some(hash => !/^[a-f0-9]{64}$/.test(hash)) || !repository ||
      typeof repository.getAttempt !== "function" ||
      typeof readback !== "function") return null;
  const images = await Promise.all(hashes.map(hash => readAcknowledgedImageAssetProof(job, hash, repository)));
  if (images.some(image => !image)) return null;
  const assetIds = images.map(image => image!.remoteAssetId);
  if (new Set(assetIds).size !== assetIds.length) return null;
  const requestId = webHttpStageRequestId(job,
    { kind: "DRAFT_UPDATE", draftId });
  if (!requestId) return null;
  let attempt: WebHttpSendAttempt | null;
  try { attempt = await repository.getAttempt(requestId); }
  catch { return null; }
  if (!sameJob(attempt, job, requestId) ||
      attempt?.status !== "DRAFT_ACKNOWLEDGED" ||
      attempt.draftMutationKind !== "UPDATE" ||
      attempt.remoteDraftId !== draftId) return null;
  let pack: Record<string, unknown>;
  try { pack = JSON.parse(job.snapshotJson).pack; }
  catch { return null; }
  const shipping = pack.shipping as Record<string, unknown> | null;
  if (!shipping || typeof pack.title !== "string" ||
      typeof pack.description !== "string" ||
      typeof pack.priceYen !== "number" ||
      typeof pack.quantity !== "number" ||
      typeof pack.categoryId !== "string" ||
      pack.condition !== "NO_NOTABLE_DAMAGE" || !Array.isArray(pack.imageRefs) ||
      pack.imageRefs.length !== assetIds.length) return null;
  let remote: Awaited<ReturnType<VerifiedUpdatedDraftReadback>>;
  try { remote = await readback(draftId); }
  catch { return null; }
  if (remote?.status !== "VERIFIED" ||
      remote.shopId !== job.shopId || remote.draftId !== draftId ||
      remote.skuCode !== job.managementCode ||
      remote.name !== pack.title ||
      remote.description !== pack.description ||
      remote.price !== pack.priceYen ||
      remote.quantity !== pack.quantity ||
      remote.categoryId !== pack.categoryId ||
      remote.conditionId !== "CONDITION_CLEAN" ||
      !Array.isArray(remote.imageAssetIds) ||
      JSON.stringify(remote.imageAssetIds) !== JSON.stringify(assetIds) ||
      remote.shippingMethodId !== shipping.method ||
      remote.shippingPayerId !== shipping.payer ||
      remote.shippingDurationId !== shipping.duration ||
      remote.shippingFromStateId !== shipping.origin) return null;
  return { status: "VERIFIED_PRIVATE_DRAFT_CONTENT",
    inventoryId: job.inventoryId, shopId: job.shopId, draftId,
    snapshotFingerprint: job.snapshotFingerprint };
}
