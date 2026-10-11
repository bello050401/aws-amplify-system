import "server-only";

import { randomUUID } from "node:crypto";
import { B005396_INVENTORY_ID } from "./b005396GeneralPreparation.ts";
import { initialWebHttpExecutionState } from "./webHttpExecutionGate.ts";
import type { WebHttpDraftJob, WebHttpDraftJobRepository } from
  "./webHttpDraftJob.ts";
import type { WebHttpDraftReadback } from
  "./webHttpDraftSaveReconciliation.ts";
import { reconcileReservedWebHttpDraft } from
  "./webHttpDraftSaveReconciliation.ts";
import { mapObservedDraftInput,
  type ObservedDraftImageProof,
  type ObservedDraftInputMapperPorts,
  type ObservedDraftSelectedProof } from
  "./webHttpObservedDraftInputMapper.ts";
import { executeObservedDraftWriteOnce,
  type ObservedDraftTargetProof,
  type ObservedDraftWritePorts,
  type ObservedDraftWriteResult } from
  "./webHttpObservedDraftWrite.ts";
import { reserveWebHttpSendStart,
  type WebHttpSendReservationRepository } from
  "./webHttpSendReservation.ts";

type SourcePorts = Omit<ObservedDraftInputMapperPorts,
  "readRemoteDuplicate">;
type SendRepository = WebHttpSendReservationRepository &
  ObservedDraftWritePorts["repository"];
export type StoredDraftTargetProof = ObservedDraftTargetProof & {
  requestId: string;
};
export type StoredDraftUpdateContractProof = {
  status: "VERIFIED_OBSERVED_UPDATE_CONTRACT";
  requestId: string; snapshotFingerprint: string;
  targetDraftId: string;
};
export type VerifiedDraftUpdateSession = {
  status: "VERIFIED_RECENT_HUMAN_AUTH";
  requestId: string; shopId: string; snapshotFingerprint: string;
  verifiedAtMs: number; cookieHeader: string; cookieExpiresAtMs: number;
  /** These three adapters must use this one authenticated session. */
  fetchPort: typeof fetch;
  duplicatePreflight: ObservedDraftInputMapperPorts["readRemoteDuplicate"];
  reverifyAuth: ObservedDraftWritePorts["verifyAuthFresh"];
  readback: WebHttpDraftReadback;
};
export type StoredDraftUpdatePorts = {
  jobRepository: Pick<WebHttpDraftJobRepository, "getJob">;
  source: SourcePorts;
  sendRepository: SendRepository;
  readVerifiedTarget: (job: WebHttpDraftJob) =>
    Promise<StoredDraftTargetProof | null>;
  readVerifiedImage: (job: WebHttpDraftJob) =>
    Promise<ObservedDraftImageProof | null>;
  readVerifiedSelection: (job: WebHttpDraftJob) =>
    Promise<ObservedDraftSelectedProof | null>;
  readVerifiedContract: (job: WebHttpDraftJob) =>
    Promise<StoredDraftUpdateContractProof | null>;
  openVerifiedSession: (job: WebHttpDraftJob) =>
    Promise<VerifiedDraftUpdateSession | null>;
};
type Status = "INVALID_REQUEST_NO_SEND" | "JOB_UNAVAILABLE_NO_SEND" |
  "EVIDENCE_MISSING_NO_SEND" | "AUTH_UNVERIFIED_NO_SEND" |
  "SOURCE_OR_TARGET_UNVERIFIED_NO_SEND" |
  "RESERVATION_BLOCKED_NO_SEND" | "WRITE_ATTEMPT_FINISHED";
export type StoredDraftUpdateResult = {
  status: Status;
  detail: string | null;
  writeResult: ObservedDraftWriteResult | null;
  allowCreate: false; allowPublish: false;
  listingConfirmed: false;
};
const result = (status: Status, detail: string | null = null,
  writeResult: ObservedDraftWriteResult | null = null):
  StoredDraftUpdateResult => ({ status, detail, writeResult,
    allowCreate: false, allowPublish: false, listingConfirmed: false });
const REQUEST_ID = /^[a-f0-9]{64}$/;
const validClock = (value: number) =>
  Number.isSafeInteger(value) && value >= 0;

/**
 * Unwired server-only connection from a persisted BELLO preparation job to
 * the existing one-attempt writer. It can only update a proved existing draft.
 * No production image, target, contract, or auth proof reader is registered.
 */
export async function updateStoredWebHttpDraftOnce(requestId: string,
  requestedBy: string, ports: StoredDraftUpdatePorts,
  clock: () => number = Date.now): Promise<StoredDraftUpdateResult> {
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId) ||
      typeof requestedBy !== "string" || !requestedBy || !ports ||
      !ports.jobRepository || !ports.source || !ports.sendRepository ||
      typeof ports.readVerifiedTarget !== "function" ||
      typeof ports.readVerifiedImage !== "function" ||
      typeof ports.readVerifiedSelection !== "function" ||
      typeof ports.readVerifiedContract !== "function" ||
      typeof ports.openVerifiedSession !== "function" ||
      !validClock(clock())) return result("INVALID_REQUEST_NO_SEND");
  let job: WebHttpDraftJob | null;
  try { job = await ports.jobRepository.getJob(requestId); }
  catch { return result("JOB_UNAVAILABLE_NO_SEND"); }
  if (!job || job.requestId !== requestId ||
      job.requestedBy !== requestedBy ||
      !initialWebHttpExecutionState(job) ||
      job.inventoryId.toLowerCase() === B005396_INVENTORY_ID)
    return result("JOB_UNAVAILABLE_NO_SEND");
  let target: StoredDraftTargetProof | null;
  let image: ObservedDraftImageProof | null;
  let selected: ObservedDraftSelectedProof | null;
  let contract: StoredDraftUpdateContractProof | null;
  try {
    [target, image, selected, contract] = await Promise.all([
      ports.readVerifiedTarget(job), ports.readVerifiedImage(job),
      ports.readVerifiedSelection(job), ports.readVerifiedContract(job),
    ]);
  } catch { return result("EVIDENCE_MISSING_NO_SEND"); }
  if (!target || target.status !== "VERIFIED_SAME_JOB_DRAFT" ||
      target.requestId !== job.requestId ||
      target.shopId !== job.shopId ||
      target.inventoryId !== job.inventoryId ||
      target.snapshotFingerprint !== job.snapshotFingerprint ||
      typeof target.draftId !== "string" ||
      !/^[A-Za-z0-9]{1,64}$/.test(target.draftId) ||
      !image || !selected || !contract ||
      contract.status !== "VERIFIED_OBSERVED_UPDATE_CONTRACT" ||
      contract.requestId !== job.requestId ||
      contract.snapshotFingerprint !== job.snapshotFingerprint ||
      contract.targetDraftId !== target.draftId)
    return result("EVIDENCE_MISSING_NO_SEND");
  let session: VerifiedDraftUpdateSession | null;
  try { session = await ports.openVerifiedSession(job); }
  catch { session = null; }
  const now = clock();
  if (!session || session.status !== "VERIFIED_RECENT_HUMAN_AUTH" ||
      session.requestId !== job.requestId ||
      session.shopId !== job.shopId ||
      session.snapshotFingerprint !== job.snapshotFingerprint ||
      !validClock(now) || !validClock(session.verifiedAtMs) ||
      session.verifiedAtMs > now || now - session.verifiedAtMs > 30_000 ||
      !validClock(session.cookieExpiresAtMs) ||
      session.cookieExpiresAtMs <= now + 4_000 ||
      typeof session.cookieHeader !== "string" ||
      !session.cookieHeader || session.cookieHeader.length > 32_768 ||
      /[\r\n\0]/.test(session.cookieHeader) ||
      typeof session.fetchPort !== "function" ||
      typeof session.duplicatePreflight !== "function" ||
      typeof session.reverifyAuth !== "function" ||
      !session.readback ||
      typeof session.readback.verifyTargetShop !== "function" ||
      typeof session.readback.listDraftCandidates !== "function")
    return result("AUTH_UNVERIFIED_NO_SEND");
  let mapped: Awaited<ReturnType<typeof mapObservedDraftInput>>;
  try {
    mapped = await mapObservedDraftInput(job, "UPDATE",
      { ...ports.source,
        readRemoteDuplicate: session.duplicatePreflight },
      { targetDraft: target, image, selected });
  } catch { return result("SOURCE_OR_TARGET_UNVERIFIED_NO_SEND"); }
  if (!mapped.ok || mapped.mutation.kind !== "UPDATE")
    return result("SOURCE_OR_TARGET_UNVERIFIED_NO_SEND",
      mapped.ok ? "NOT_UPDATE" : mapped.code);
  // The full remote scan may outlive the initial 30-second auth proof.
  let refreshed: Awaited<ReturnType<VerifiedDraftUpdateSession["reverifyAuth"]>>;
  try { refreshed = await session.reverifyAuth(); }
  catch { return result("AUTH_UNVERIFIED_NO_SEND"); }
  const reserveNow = clock();
  if (refreshed?.status !== "VALID" ||
      typeof refreshed.verifiedAtMs !== "number" ||
      !validClock(refreshed.verifiedAtMs) ||
      !validClock(reserveNow) ||
      refreshed.verifiedAtMs > reserveNow ||
      reserveNow - refreshed.verifiedAtMs > 30_000 ||
      session.cookieExpiresAtMs <= reserveNow + 4_000)
    return result("AUTH_UNVERIFIED_NO_SEND");
  const reservation = await reserveWebHttpSendStart(job, {
    auth: "VALID", userReauthenticatedByHuman: true,
    writeContractVerified: true,
    // The mapper's complete scan already found this target and no other match.
    remoteDuplicate: "ABSENT", existingBinding: false,
  }, randomUUID(), ports.sendRepository, clock);
  if (!reservation.ok)
    return result("RESERVATION_BLOCKED_NO_SEND", reservation.code);
  let write: ObservedDraftWriteResult;
  try { write = await executeObservedDraftWriteOnce(job, reservation,
    mapped.mutation, mapped.assetProof, mapped.mappingProof, {
      cookieHeader: session.cookieHeader,
      cookieExpiresAtMs: session.cookieExpiresAtMs,
      fetchPort: session.fetchPort,
      repository: ports.sendRepository,
      readCurrentInventory: ports.source.readInventory,
      hasExistingBinding: async current => {
        const [binding, channel] = await Promise.all([
          ports.source.hasExistingBinding(current),
          ports.source.hasExistingChannelListing(current),
        ]);
        return binding === false && channel === false ? false : true;
      },
      duplicatePreflight: session.duplicatePreflight,
      verifyAuthFresh: session.reverifyAuth,
      readback: session.readback,
    }, clock); }
  catch {
    // A reservation may already have been claimed. Read back, but never resend.
    const readback = await reconcileReservedWebHttpDraft(job,
      ports.sendRepository, session.readback);
    write = { status: "RESULT_UNKNOWN_NO_RESEND", draftId: null,
      readbackStatus: readback.status, allowRetry: false,
      listingConfirmed: false };
  }
  return result("WRITE_ATTEMPT_FINISHED", write.status, write);
}
