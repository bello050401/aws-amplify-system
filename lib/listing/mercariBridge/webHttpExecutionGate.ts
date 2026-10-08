import { WEB_HTTP_SHOP_ID, buildWebHttpDraftJob, webHttpDraftRequestId,
  type WebHttpDraftJob } from "./webHttpDraftJob.ts";

export const WEB_HTTP_MIN_SEND_INTERVAL_MS = 30_000;
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WebHttpExecutionPhase = "PREPARED" | "AUTH_REQUIRED" |
  "WAIT_INTERVAL" | "READY" | "IN_FLIGHT" | "VERIFY_REQUIRED" |
  "BLOCKED_EXISTING_LINK";
export type WebHttpExecutionState = {
  requestId: string;
  inventoryId: string;
  snapshotFingerprint: string;
  phase: WebHttpExecutionPhase;
  attemptId: string | null;
  attemptedAtMs: number | null;
  nextEligibleAtMs: number | null;
};

export type WebHttpSendChecks = {
  auth: "VALID" | "EXPIRED" | "UNKNOWN";
  writeContractVerified: boolean;
  remoteDuplicate: "ABSENT" | "FOUND" | "UNKNOWN";
  existingBinding: boolean;
  globalSendHistoryKnown: boolean;
  lastGlobalSendAtMs: number | null;
};

type CheckEvent = { type: "CHECK"; nowMs: number; checks: WebHttpSendChecks };
type BeginEvent = { type: "BEGIN"; nowMs: number; checks: WebHttpSendChecks;
  attemptId: string };
type WebHttpExecutionEvent = CheckEvent | BeginEvent |
  { type: "AUTH_EXPIRED" } |
  { type: "USER_REAUTHENTICATED"; verifiedByUser: boolean;
    reauthenticatedAtMs: number } |
  { type: "RESULT_UNKNOWN"; attemptId: string };

const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Bind the execution gate to the immutable, no-send Web preparation job. */
export function initialWebHttpExecutionState(job: WebHttpDraftJob):
  WebHttpExecutionState | null {
  if (!job || job.status !== "AWAITING_HTTP_AUTH_AND_CREATE_CONTRACT" ||
      job.shopId !== WEB_HTTP_SHOP_ID || !job.snapshotJson ||
      !/^[a-f0-9]{64}$/.test(job.snapshotFingerprint)) return null;
  try {
    if (job.requestId !== webHttpDraftRequestId(job.inventoryId)) return null;
    const snapshot = JSON.parse(job.snapshotJson);
    if (snapshot?.schemaVersion !== 1 ||
        snapshot.transport !== "BELLO_SERVER_HTTP" ||
        snapshot.shippingReviewed !== true ||
        snapshot.pack?.status !== "PREPARED_NO_SEND" ||
        snapshot.pack?.inventoryId?.toLowerCase() !== job.inventoryId.toLowerCase() ||
        snapshot.pack?.shopId !== job.shopId ||
        snapshot.pack?.managementCode !== job.managementCode ||
        snapshot.evidence?.status !== "REVIEW_REQUIRED_NO_SEND") return null;
    const rebuilt = buildWebHttpDraftJob(snapshot.pack, snapshot.evidence,
      job.requestedBy, job.recordedAt);
    if (rebuilt.requestId !== job.requestId ||
        rebuilt.snapshotJson !== job.snapshotJson ||
        rebuilt.snapshotFingerprint !== job.snapshotFingerprint) return null;
  } catch { return null; }
  return { requestId: job.requestId, inventoryId: job.inventoryId,
    snapshotFingerprint: job.snapshotFingerprint, phase: "PREPARED",
    attemptId: null, attemptedAtMs: null, nextEligibleAtMs: null };
}

function checkedPhase(state: WebHttpExecutionState,
  event: Pick<CheckEvent, "nowMs" | "checks">):
  WebHttpExecutionState {
  const { checks, nowMs } = event;
  if (!checks ||
      typeof checks.existingBinding !== "boolean" ||
      typeof checks.writeContractVerified !== "boolean")
    return { ...state, phase: "PREPARED", nextEligibleAtMs: null };
  if (checks.existingBinding || checks.remoteDuplicate === "FOUND")
    return { ...state, phase: "BLOCKED_EXISTING_LINK", nextEligibleAtMs: null };
  if (checks.auth !== "VALID")
    return { ...state, phase: "AUTH_REQUIRED", nextEligibleAtMs: null };
  // An invalid clock or an unavailable global attempt ledger cannot authorize a send.
  if (!validTime(nowMs) || checks.globalSendHistoryKnown !== true ||
      checks.lastGlobalSendAtMs !== null &&
        (!validTime(checks.lastGlobalSendAtMs) ||
          checks.lastGlobalSendAtMs > nowMs))
    return { ...state, phase: "PREPARED", nextEligibleAtMs: null };
  if (!checks.writeContractVerified || checks.remoteDuplicate !== "ABSENT")
    return { ...state, phase: "PREPARED", nextEligibleAtMs: null };
  const nextEligibleAtMs = checks.lastGlobalSendAtMs === null ? null :
    checks.lastGlobalSendAtMs + WEB_HTTP_MIN_SEND_INTERVAL_MS;
  if (nextEligibleAtMs !== null && !validTime(nextEligibleAtMs))
    return { ...state, phase: "PREPARED", nextEligibleAtMs: null };
  if (nextEligibleAtMs !== null && nowMs < nextEligibleAtMs)
    return { ...state, phase: "WAIT_INTERVAL", nextEligibleAtMs };
  return { ...state, phase: "READY", nextEligibleAtMs: null };
}

/** Pure transition only. A future HTTP sender must persist BEGIN atomically first. */
export function transitionWebHttpExecution(state: WebHttpExecutionState,
  event: WebHttpExecutionEvent): WebHttpExecutionState {
  if (!state || !event) throw Error("Invalid Web HTTP execution transition");
  if (state.phase === "IN_FLIGHT" || state.phase === "VERIFY_REQUIRED") {
    if (state.attemptId === null)
      return { ...state, phase: "VERIFY_REQUIRED", nextEligibleAtMs: null };
  }
  // Once an attempt may have reached Shops, no event can make the same job sendable again.
  if (state.attemptId !== null) {
    if (event.type === "AUTH_EXPIRED" ||
        event.type === "RESULT_UNKNOWN" && event.attemptId === state.attemptId)
      return { ...state, phase: "VERIFY_REQUIRED", nextEligibleAtMs: null };
    return state;
  }
  if (state.phase === "BLOCKED_EXISTING_LINK") return state;
  if (event.type === "AUTH_EXPIRED")
    return { ...state, phase: "AUTH_REQUIRED", nextEligibleAtMs: null };
  if (state.phase === "AUTH_REQUIRED") {
    if (event.type !== "USER_REAUTHENTICATED" ||
        event.verifiedByUser !== true ||
        !validTime(event.reauthenticatedAtMs)) return state;
    return { ...state, phase: "PREPARED", nextEligibleAtMs: null };
  }
  if (event.type === "USER_REAUTHENTICATED") return state;
  if (event.type === "RESULT_UNKNOWN") return state;
  const checked = checkedPhase(state, event);
  if (event.type === "CHECK" || checked.phase !== "READY") return checked;
  if (!ATTEMPT_ID.test(event.attemptId))
    return { ...checked, phase: "PREPARED" };
  return { ...checked, phase: "IN_FLIGHT", attemptId: event.attemptId,
    attemptedAtMs: event.nowMs };
}
