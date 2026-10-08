import type { WebHttpDraftJob } from "./webHttpDraftJob.ts";
import { initialWebHttpExecutionState, transitionWebHttpExecution,
  type WebHttpSendChecks } from "./webHttpExecutionGate.ts";

export type WebHttpShopSendSlot = {
  shopId: string;
  revision: number;
  lastStartedAt: string;
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
  requestedBy: string;
  status: "RESERVED_NO_SEND";
};
export type WebHttpSendReservationRepository = {
  getSlot: (shopId: string) => Promise<WebHttpShopSendSlot | null>;
  createSlot: (slot: WebHttpShopSendSlot) => Promise<void>;
  updateSlot: (previous: WebHttpShopSendSlot,
    next: WebHttpShopSendSlot) => Promise<void>;
  getAttempt: (requestId: string) => Promise<WebHttpSendAttempt | null>;
  createAttempt: (attempt: WebHttpSendAttempt) => Promise<void>;
};
export type WebHttpReservationPreflight = Pick<WebHttpSendChecks,
  "auth" | "writeContractVerified" | "remoteDuplicate" | "existingBinding"> & {
  /** Must come from a trusted, human-completed reauthentication check. */
  userReauthenticatedByHuman: boolean;
};

export type WebHttpSendReservationResult =
  { ok: true; status: "RESERVED_NO_SEND"; requestId: string;
    attemptId: string; slotRevision: number; reservedAt: string } |
  { ok: false; code: "INVALID_JOB" | "AUTH_REQUIRED" |
    "BLOCKED_EXISTING_LINK" | "PRECHECK_NOT_READY" | "WAIT_INTERVAL" |
    "ALREADY_CLAIMED_NO_SEND" | "STORAGE_UNAVAILABLE" |
    "RESERVATION_UNCONFIRMED_NO_SEND" | "ATTEMPT_UNCONFIRMED_NO_SEND";
    nextEligibleAtMs?: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0;
function validSlot(slot: WebHttpShopSendSlot, job: WebHttpDraftJob) {
  const startedAt = Date.parse(slot.lastStartedAt);
  return slot.shopId === job.shopId &&
    Number.isSafeInteger(slot.revision) && slot.revision >= 1 &&
    slot.revision < 2_147_483_647 &&
    validTime(startedAt) && UUID.test(slot.attemptId) &&
    /^[a-f0-9]{64}$/.test(slot.requestId) &&
    typeof slot.requestedBy === "string" && Boolean(slot.requestedBy);
}

/**
 * Both conditional writes must be confirmed before any caller may send.
 * A failed or ambiguous phase returns no-send and is never retried here.
 */
export async function reserveWebHttpSendStart(job: WebHttpDraftJob,
  preflight: WebHttpReservationPreflight, attemptId: string,
  repo: WebHttpSendReservationRepository,
  nowMs = Date.now()): Promise<WebHttpSendReservationResult> {
  const initial = initialWebHttpExecutionState(job);
  if (!initial || !UUID.test(attemptId) || !validTime(nowMs) ||
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
    priorAttempt = await repo.getAttempt(job.requestId);
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
  if (candidate.phase === "WAIT_INTERVAL")
    return { ok: false, code: "WAIT_INTERVAL",
      nextEligibleAtMs: candidate.nextEligibleAtMs ?? undefined };
  if (candidate.phase !== "IN_FLIGHT")
    return { ok: false, code: candidate.phase === "AUTH_REQUIRED" ?
      "AUTH_REQUIRED" : candidate.phase === "BLOCKED_EXISTING_LINK" ?
        "BLOCKED_EXISTING_LINK" : "PRECHECK_NOT_READY" };
  const reservedAt = new Date(nowMs).toISOString();
  const next: WebHttpShopSendSlot = { shopId: job.shopId,
    revision: previous ? previous.revision + 1 : 1,
    lastStartedAt: reservedAt, requestId: job.requestId, attemptId,
    requestedBy: job.requestedBy };
  try {
    if (previous) await repo.updateSlot(previous, next);
    else await repo.createSlot(next);
  } catch { return { ok: false, code: "RESERVATION_UNCONFIRMED_NO_SEND" }; }
  const attempt: WebHttpSendAttempt = { requestId: job.requestId,
    inventoryId: job.inventoryId, shopId: job.shopId,
    snapshotFingerprint: job.snapshotFingerprint, attemptId,
    slotRevision: next.revision, reservedAt,
    requestedBy: job.requestedBy, status: "RESERVED_NO_SEND" };
  try { await repo.createAttempt(attempt); }
  catch { return { ok: false, code: "ATTEMPT_UNCONFIRMED_NO_SEND" }; }
  return { ok: true, status: "RESERVED_NO_SEND",
    requestId: job.requestId, attemptId,
    slotRevision: next.revision, reservedAt };
}
