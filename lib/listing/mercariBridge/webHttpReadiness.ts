import "server-only";

import { B005396_INVENTORY_ID } from "./b005396GeneralPreparation.ts";
import { initialWebHttpExecutionState, transitionWebHttpExecution,
  type WebHttpSendChecks } from "./webHttpExecutionGate.ts";
import type { WebHttpDraftJob } from "./webHttpDraftJob.ts";
import { readObservedB005396Draft,
  type AuthenticatedDraftReadTransport } from "./webHttpObservedDraftRead.ts";
import { checkWebHttpSession, type WebHttpSessionStore } from
  "./webHttpSessionLifecycle.ts";

export type WebHttpTargetPreflight = {
  requestId: string;
  snapshotFingerprint: string;
  observedAtMs: number;
  checks: Omit<WebHttpSendChecks, "auth">;
};
export type WebHttpTargetPreflightResult = WebHttpTargetPreflight | {
  status: "AUTH_REQUIRED" | "ADDITIONAL_AUTH_REQUIRED" | "UNKNOWN";
};

export type WebHttpReadinessPorts = {
  sessionStore: WebHttpSessionStore;
  /** Both adapters must come from the same trusted server-side auth context. */
  transportForSession: (opaqueMaterial: string) =>
    AuthenticatedDraftReadTransport | null;
  readTargetPreflight: (job: WebHttpDraftJob,
    transport: AuthenticatedDraftReadTransport) =>
    Promise<WebHttpTargetPreflightResult | null>;
};

export type WebHttpReadiness = {
  status: "READY_FOR_RESERVATION" | "BLOCKED_EXISTING_DRAFT" |
    "WAIT_INTERVAL" | "PREFLIGHT_UNVERIFIED" | "AUTH_REQUIRED" |
    "ADDITIONAL_AUTH_REQUIRED" | "AUTH_UNVERIFIED" |
    "STORAGE_UNAVAILABLE" | "INVALID_INPUT";
  allowHttpWrite: false;
  reauthenticationRequired: boolean;
};

const result = (status: WebHttpReadiness["status"]): WebHttpReadiness => ({
  status, allowHttpWrite: false,
  reauthenticationRequired: status === "AUTH_REQUIRED" ||
    status === "ADDITIONAL_AUTH_REQUIRED",
});
const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Read-only bridge. READY means a later atomic reservation may be attempted. */
export async function checkWebHttpReadiness(job: WebHttpDraftJob,
  knownDraftJob: WebHttpDraftJob, ownerSub: string,
  ports: WebHttpReadinessPorts, clock: () => number = Date.now):
  Promise<WebHttpReadiness> {
  const initial = initialWebHttpExecutionState(job);
  if (!initial || !initialWebHttpExecutionState(knownDraftJob) ||
      knownDraftJob.inventoryId.toLowerCase() !== B005396_INVENTORY_ID ||
      job.shopId !== knownDraftJob.shopId ||
      !ports || typeof ports.transportForSession !== "function" ||
      typeof ports.readTargetPreflight !== "function" ||
      !ports.sessionStore || !validTime(clock())) return result("INVALID_INPUT");

  let transport: AuthenticatedDraftReadTransport | null = null;
  const session = await checkWebHttpSession(job.shopId, ownerSub,
    ports.sessionStore, async material => {
      try {
        transport = ports.transportForSession(material);
        const read = await readObservedB005396Draft(knownDraftJob, transport);
        if (read.ok) return "VALID";
        if (read.code === "AUTH_REQUIRED_NO_SEND") return "EXPIRED";
        if (read.code === "ADDITIONAL_AUTH_REQUIRED_NO_SEND")
          return "ADDITIONAL_AUTH";
      } catch { /* Unverified access must stop without exposing auth material. */ }
      transport = null;
      return "UNKNOWN";
    }, clock);
  if (session.status !== "READY_FOR_READONLY_PREFLIGHT")
    return result(session.status);
  if (!transport) return result("AUTH_UNVERIFIED");

  // The known item already has two Shops drafts. Never request another target
  // scan that could incorrectly claim absence and authorize a third create.
  if (job.inventoryId.toLowerCase() === B005396_INVENTORY_ID)
    return result("BLOCKED_EXISTING_DRAFT");

  let preflight: WebHttpTargetPreflightResult | null;
  try { preflight = await ports.readTargetPreflight(job, transport); }
  catch { return result("PREFLIGHT_UNVERIFIED"); }
  if (preflight && "status" in preflight)
    return result(preflight.status === "AUTH_REQUIRED" ||
      preflight.status === "ADDITIONAL_AUTH_REQUIRED" ?
        preflight.status : "PREFLIGHT_UNVERIFIED");
  const evidence = preflight;
  const nowMs = clock();
  if (!validTime(nowMs) || !evidence ||
      evidence.requestId !== job.requestId ||
      evidence.snapshotFingerprint !== job.snapshotFingerprint ||
      !validTime(evidence.observedAtMs) ||
      evidence.observedAtMs > nowMs || nowMs - evidence.observedAtMs > 30_000 ||
      !evidence.checks ||
      typeof evidence.checks.existingBinding !== "boolean" ||
      typeof evidence.checks.writeContractVerified !== "boolean" ||
      !["ABSENT", "FOUND"].includes(evidence.checks.remoteDuplicate) ||
      evidence.checks.globalSendHistoryKnown !== true ||
      evidence.checks.lastGlobalSendAtMs !== null &&
        !validTime(evidence.checks.lastGlobalSendAtMs))
    return result("PREFLIGHT_UNVERIFIED");

  const checked = transitionWebHttpExecution(initial, { type: "CHECK", nowMs,
    checks: { ...evidence.checks, auth: "VALID" } });
  if (checked.phase === "BLOCKED_EXISTING_LINK")
    return result("BLOCKED_EXISTING_DRAFT");
  if (checked.phase === "WAIT_INTERVAL") return result("WAIT_INTERVAL");
  return result(checked.phase === "READY" ? "READY_FOR_RESERVATION" :
    "PREFLIGHT_UNVERIFIED");
}
