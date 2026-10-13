import "server-only";

import { randomUUID } from "node:crypto";
import { B005396_INVENTORY_ID } from "./b005396GeneralPreparation.ts";
import { initialWebHttpExecutionState } from "./webHttpExecutionGate.ts";
import type { WebHttpDraftJob, WebHttpDraftJobRepository } from
  "./webHttpDraftJob.ts";
import { reconcileReservedWebHttpDraft } from
  "./webHttpDraftSaveReconciliation.ts";
import { mapObservedDraftInput,
  type ObservedDraftImageProof, type ObservedDraftInputMapperPorts,
  type ObservedDraftSeedProof, type ObservedDraftSelectedProof } from
  "./webHttpObservedDraftInputMapper.ts";
import { executeObservedDraftWriteOnce,
  type ObservedDraftWritePorts,
  type ObservedDraftWriteResult } from "./webHttpObservedDraftWrite.ts";
import { reserveWebHttpSendStart,
  type WebHttpSendReservationRepository } from
  "./webHttpSendReservation.ts";
import type { VerifiedDraftUpdateSession } from
  "./webHttpStoredDraftUpdate.ts";

type SourcePorts = Omit<ObservedDraftInputMapperPorts,
  "readRemoteDuplicate">;
type SendRepository = WebHttpSendReservationRepository &
  ObservedDraftWritePorts["repository"];
type CreateContractProof = {
  status: "VERIFIED_OBSERVED_CREATE_CONTRACT";
  requestId: string; snapshotFingerprint: string;
};
export type StoredDraftCreatePorts = {
  jobRepository: Pick<WebHttpDraftJobRepository, "getJob">;
  source: SourcePorts;
  sendRepository: SendRepository;
  readVerifiedImage: (job: WebHttpDraftJob) =>
    Promise<ObservedDraftImageProof | null>;
  readVerifiedSelection: (job: WebHttpDraftJob) =>
    Promise<ObservedDraftSelectedProof | null>;
  readVerifiedSeed: (job: WebHttpDraftJob) =>
    Promise<ObservedDraftSeedProof | null>;
  readVerifiedContract: (job: WebHttpDraftJob) =>
    Promise<CreateContractProof | null>;
  openVerifiedSession: (job: WebHttpDraftJob) =>
    Promise<VerifiedDraftUpdateSession | null>;
};
type Status = "INVALID_REQUEST_NO_SEND" | "JOB_UNAVAILABLE_NO_SEND" |
  "EVIDENCE_MISSING_NO_SEND" | "AUTH_UNVERIFIED_NO_SEND" |
  "SOURCE_OR_DUPLICATE_UNVERIFIED_NO_SEND" |
  "RESERVATION_BLOCKED_NO_SEND" | "WRITE_ATTEMPT_FINISHED";
export type StoredDraftCreateResult = { status: Status;
  detail: string | null; writeResult: ObservedDraftWriteResult | null;
  allowPublish: false; listingConfirmed: false };
const result = (status: Status, detail: string | null = null,
  writeResult: ObservedDraftWriteResult | null = null):
  StoredDraftCreateResult => ({ status, detail, writeResult,
    allowPublish: false, listingConfirmed: false });
const validClock = (value: number) =>
  Number.isSafeInteger(value) && value >= 0;

/** Unwired HTTPS-only one-attempt create. No guessed seed or session is
 * generated here; a real observed and independently verified source must
 * provide each proof. An unknown result is read, never resent.
 */
export async function createStoredWebHttpDraftOnce(requestId: string,
  requestedBy: string, ports: StoredDraftCreatePorts,
  clock: () => number = Date.now): Promise<StoredDraftCreateResult> {
  if (!/^[a-f0-9]{64}$/.test(requestId) || !requestedBy || !ports ||
      !ports.jobRepository || !ports.source || !ports.sendRepository ||
      typeof ports.readVerifiedImage !== "function" ||
      typeof ports.readVerifiedSelection !== "function" ||
      typeof ports.readVerifiedSeed !== "function" ||
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
  let image: ObservedDraftImageProof | null;
  let selected: ObservedDraftSelectedProof | null;
  let seed: ObservedDraftSeedProof | null;
  let contract: CreateContractProof | null;
  try { [image, selected, seed, contract] = await Promise.all([
    ports.readVerifiedImage(job), ports.readVerifiedSelection(job),
    ports.readVerifiedSeed(job), ports.readVerifiedContract(job),
  ]); }
  catch { return result("EVIDENCE_MISSING_NO_SEND"); }
  if (!image || !selected || !seed || !contract ||
      contract.status !== "VERIFIED_OBSERVED_CREATE_CONTRACT" ||
      contract.requestId !== job.requestId ||
      contract.snapshotFingerprint !== job.snapshotFingerprint ||
      seed.status !== "VERIFIED_OBSERVED_SEED_STRATEGY" ||
      seed.snapshotFingerprint !== job.snapshotFingerprint ||
      !Number.isFinite(seed.value))
    return result("EVIDENCE_MISSING_NO_SEND");
  let session: VerifiedDraftUpdateSession | null;
  try { session = await ports.openVerifiedSession(job); }
  catch { session = null; }
  const now = clock();
  if (!session || session.status !== "VERIFIED_RECENT_HUMAN_AUTH" ||
      session.requestId !== job.requestId || session.shopId !== job.shopId ||
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
  try { mapped = await mapObservedDraftInput(job, "CREATE",
    { ...ports.source, readRemoteDuplicate: session.duplicatePreflight },
    { image, selected, seed }); }
  catch { return result("SOURCE_OR_DUPLICATE_UNVERIFIED_NO_SEND"); }
  if (!mapped.ok || mapped.mutation.kind !== "CREATE")
    return result("SOURCE_OR_DUPLICATE_UNVERIFIED_NO_SEND",
      mapped.ok ? "NOT_CREATE" : mapped.code);
  let refreshed: Awaited<ReturnType<typeof session.reverifyAuth>>;
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
  const stage = { kind: "DRAFT_CREATE" } as const;
  const reservation = await reserveWebHttpSendStart(job,
    { auth: "VALID", userReauthenticatedByHuman: true,
      writeContractVerified: true, remoteDuplicate: "ABSENT",
      existingBinding: false }, randomUUID(), ports.sendRepository,
    clock, stage);
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
    const readback = await reconcileReservedWebHttpDraft(job,
      ports.sendRepository, session.readback, stage);
    write = { status: "RESULT_UNKNOWN_NO_RESEND", draftId: null,
      readbackStatus: readback.status, allowRetry: false,
      listingConfirmed: false };
  }
  return result("WRITE_ATTEMPT_FINISHED", write.status, write);
}
