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
