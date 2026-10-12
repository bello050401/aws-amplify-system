import { createHash } from "node:crypto";
import type { WebHttpDraftJob } from "./webHttpDraftJob.ts";
import { initialWebHttpExecutionState, transitionWebHttpExecution,
  WEB_HTTP_MIN_SEND_INTERVAL_MS, type WebHttpSendChecks } from
  "./webHttpExecutionGate.ts";

// A later sender must begin its HTTP call before sendBeforeAt. The extra second
// between that deadline and lease end is a scheduling margin. The next product
// can reserve only 30 seconds after lease end, not 30 seconds after reservation.
export const WEB_HTTP_SEND_LEASE_MS = 5_000;
export const WEB_HTTP_SEND_DEADLINE_MS = 4_000;

/** Each observed write gets one durable attempt, even within the same job.
 * A stage key is a reservation identity, not proof that a remote write is safe.
 */
export type WebHttpObservedSendStage =
  { kind: "IMAGE_UPLOAD"; preparedJpegSha256: string } |
  { kind: "DRAFT_CREATE" } |
  { kind: "DRAFT_UPDATE"; draftId: string };

export function webHttpStageRequestId(job: WebHttpDraftJob,
  stage: WebHttpObservedSendStage): string | null {
  if (!initialWebHttpExecutionState(job) || !stage) return null;
  let discriminator: string;
  if (stage.kind === "IMAGE_UPLOAD" &&
      /^[a-f0-9]{64}$/.test(stage.preparedJpegSha256))
    discriminator = `IMAGE_UPLOAD\0${stage.preparedJpegSha256}`;
  else if (stage.kind === "DRAFT_CREATE")
    discriminator = "DRAFT_CREATE";
  else if (stage.kind === "DRAFT_UPDATE" &&
      /^[A-Za-z0-9]{1,64}$/.test(stage.draftId))
    discriminator = `DRAFT_UPDATE\0${stage.draftId}`;
  else return null;
  return createHash("sha256")
    .update(`BELLO_SHOPS_HTTP_STAGE\0${job.requestId}\0${discriminator}`)
    .digest("hex");
}

export type WebHttpShopSendSlot = {
  shopId: string;
  revision: number;
  lastStartedAt: string;
  sendBeforeAt: string;
  nextEligibleAt: string;
  requestId: string;
  attemptId: string;
  requestedBy: string;
};
export type WebHttpSendAttempt = {
  requestId: string;
  inventoryId: string;
  shopId: string;
  snapshotFingerprint: string;
  attemptId: string;
  slotRevision: number;
  reservedAt: string;
  sendBeforeAt: string;
  requestedBy: string;
  status: "RESERVED_NO_SEND" | "SEND_CLAIMED_RESULT_UNKNOWN" |
    "IMAGE_ACKNOWLEDGED";
  remoteAssetId?: string;
  preparedJpegSha256?: string;
};
export type WebHttpSendReservationRepository = {
  /** Both reads must be strongly consistent; the transaction remains authoritative. */
  getSlot: (shopId: string) => Promise<WebHttpShopSendSlot | null>;
  getAttempt: (requestId: string) => Promise<WebHttpSendAttempt | null>;
  /** One DynamoDB transaction: conditional shop update + conditional attempt put. */
  transactReserve: (previous: WebHttpShopSendSlot | null,
    next: WebHttpShopSendSlot, attempt: WebHttpSendAttempt,
    nowIso: string) => Promise<void>;
};
export type WebHttpReservationPreflight = Pick<WebHttpSendChecks,
  "auth" | "writeContractVerified" | "remoteDuplicate" | "existingBinding"> & {
  /** Must come from a trusted, human-completed reauthentication check. */
  userReauthenticatedByHuman: boolean;
};

export type WebHttpSendReservationResult =
  { ok: true; status: "RESERVED_NO_SEND"; requestId: string;
    attemptId: string; slotRevision: number; reservedAt: string;
    sendBeforeMs: number } |
  { ok: false; code: "INVALID_JOB" | "AUTH_REQUIRED" |
    "BLOCKED_EXISTING_LINK" | "PRECHECK_NOT_READY" | "WAIT_INTERVAL" |
    "ALREADY_CLAIMED_NO_SEND" | "STORAGE_UNAVAILABLE" |
    "RESERVATION_UNCONFIRMED_NO_SEND" | "RESERVATION_EXPIRED_NO_SEND";
    nextEligibleAtMs?: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0;
function validSlot(slot: WebHttpShopSendSlot, job: WebHttpDraftJob) {
  const startedAt = Date.parse(slot.lastStartedAt);
  const sendBefore = Date.parse(slot.sendBeforeAt);
  const nextEligible = Date.parse(slot.nextEligibleAt);
  return slot.shopId === job.shopId &&
    Number.isSafeInteger(slot.revision) && slot.revision >= 1 &&
    slot.revision < 2_147_483_647 &&
    validTime(startedAt) && validTime(sendBefore) &&
    validTime(nextEligible) && sendBefore > startedAt &&
    nextEligible - sendBefore >= WEB_HTTP_MIN_SEND_INTERVAL_MS &&
    UUID.test(slot.attemptId) && /^[a-f0-9]{64}$/.test(slot.requestId) &&
    typeof slot.requestedBy === "string" && Boolean(slot.requestedBy);
}

/** A sender must check this immediately before beginning its HTTP call. */
export function webHttpSendPermitFresh(result: WebHttpSendReservationResult,
  nowMs: number): boolean {
  return result.ok === true && validTime(nowMs) &&
    nowMs >= Date.parse(result.reservedAt) && nowMs < result.sendBeforeMs;
}

/** No Shops request is made here. Unknown transaction outcomes never return success. */
export async function reserveWebHttpSendStart(job: WebHttpDraftJob,
  preflight: WebHttpReservationPreflight, attemptId: string,
  repo: WebHttpSendReservationRepository,
  clock: () => number = Date.now,
  // Existing callers keep the original one-send key. A staged sender must
  // separately prove the image bytes or draft target before using this key.
  stage?: WebHttpObservedSendStage): Promise<WebHttpSendReservationResult> {
  const nowMs = clock();
  const initial = initialWebHttpExecutionState(job);
  const requestId = stage ? webHttpStageRequestId(job, stage) : job.requestId;
  if (!initial || !UUID.test(attemptId) || !validTime(nowMs) ||
      !requestId ||
      !preflight || typeof preflight.existingBinding !== "boolean" ||
      typeof preflight.writeContractVerified !== "boolean")
    return { ok: false, code: "INVALID_JOB" };
  if (preflight.existingBinding || preflight.remoteDuplicate === "FOUND")
    return { ok: false, code: "BLOCKED_EXISTING_LINK" };
  if (preflight.auth !== "VALID" ||
      preflight.userReauthenticatedByHuman !== true)
    return { ok: false, code: "AUTH_REQUIRED" };
  let priorAttempt: WebHttpSendAttempt | null;
  let previous: WebHttpShopSendSlot | null;
  try {
    priorAttempt = await repo.getAttempt(requestId);
    if (priorAttempt) return { ok: false, code: "ALREADY_CLAIMED_NO_SEND" };
    previous = await repo.getSlot(job.shopId);
  } catch { return { ok: false, code: "STORAGE_UNAVAILABLE" }; }
  if (previous && !validSlot(previous, job))
    return { ok: false, code: "STORAGE_UNAVAILABLE" };
  const priorMs = previous ? Date.parse(previous.lastStartedAt) : null;
  const checks: WebHttpSendChecks = {
    auth: preflight.auth,
    writeContractVerified: preflight.writeContractVerified,
    remoteDuplicate: preflight.remoteDuplicate,
    existingBinding: preflight.existingBinding,
    globalSendHistoryKnown: true, lastGlobalSendAtMs: priorMs,
  };
  const candidate = transitionWebHttpExecution(initial, {
    type: "BEGIN", nowMs, checks, attemptId });
  const nextEligibleAtMs = previous ? Date.parse(previous.nextEligibleAt) : null;
  if (nextEligibleAtMs !== null && nowMs < nextEligibleAtMs)
    return { ok: false, code: "WAIT_INTERVAL", nextEligibleAtMs };
  if (candidate.phase === "WAIT_INTERVAL")
    return { ok: false, code: "WAIT_INTERVAL",
      nextEligibleAtMs: candidate.nextEligibleAtMs ?? undefined };
  if (candidate.phase !== "IN_FLIGHT")
    return { ok: false, code: candidate.phase === "AUTH_REQUIRED" ?
      "AUTH_REQUIRED" : candidate.phase === "BLOCKED_EXISTING_LINK" ?
        "BLOCKED_EXISTING_LINK" : "PRECHECK_NOT_READY" };
  const sendBeforeMs = nowMs + WEB_HTTP_SEND_DEADLINE_MS;
  const nextEligibleMs = nowMs + WEB_HTTP_SEND_LEASE_MS +
    WEB_HTTP_MIN_SEND_INTERVAL_MS;
  if (!validTime(sendBeforeMs) || !validTime(nextEligibleMs))
    return { ok: false, code: "PRECHECK_NOT_READY" };
  const reservedAt = new Date(nowMs).toISOString();
  const sendBeforeAt = new Date(sendBeforeMs).toISOString();
  const next: WebHttpShopSendSlot = { shopId: job.shopId,
    revision: previous ? previous.revision + 1 : 1,
    lastStartedAt: reservedAt, sendBeforeAt,
    nextEligibleAt: new Date(nextEligibleMs).toISOString(),
    requestId, attemptId, requestedBy: job.requestedBy };
  const attempt: WebHttpSendAttempt = { requestId,
    inventoryId: job.inventoryId, shopId: job.shopId,
    snapshotFingerprint: job.snapshotFingerprint, attemptId,
    slotRevision: next.revision, reservedAt, sendBeforeAt,
    requestedBy: job.requestedBy, status: "RESERVED_NO_SEND" };
  try { await repo.transactReserve(previous, next, attempt, reservedAt); }
  catch { return { ok: false, code: "RESERVATION_UNCONFIRMED_NO_SEND" }; }
  // A transaction may commit while its response is delayed. An expired A must not
  // return sendable after B has acquired the next shop slot.
  const returnedAtMs = clock();
  if (!validTime(returnedAtMs) || returnedAtMs >= sendBeforeMs)
    return { ok: false, code: "RESERVATION_EXPIRED_NO_SEND" };
  return { ok: true, status: "RESERVED_NO_SEND",
    requestId, attemptId, slotRevision: next.revision,
    reservedAt, sendBeforeMs };
}
