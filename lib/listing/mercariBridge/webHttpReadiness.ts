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
  let verifiedMaterial: string | null = null;
  const probe = async (material: string) => {
      try {
        if (verifiedMaterial !== null && material !== verifiedMaterial)
          return "UNKNOWN" as const;
        transport = ports.transportForSession(material);
        const read = await readObservedB005396Draft(knownDraftJob, transport);
        if (read.ok) {
          verifiedMaterial = material;
          return "VALID" as const;
        }
        if (read.code === "AUTH_REQUIRED_NO_SEND") return "EXPIRED" as const;
        if (read.code === "ADDITIONAL_AUTH_REQUIRED_NO_SEND")
          return "ADDITIONAL_AUTH" as const;
      } catch { /* Unverified access must stop without exposing auth material. */ }
      transport = null;
      return "UNKNOWN" as const;
    };
  const session = await checkWebHttpSession(job.shopId, ownerSub,
    ports.sessionStore, probe, clock);
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

  // The target read may outlast the saved session. Check its known expiry and
  // read access again with the same opaque session before evaluating READY.
  let finalExpiresAt: string | null | undefined;
  const finalSession = await checkWebHttpSession(job.shopId, ownerSub,
    { read: async () => {
      const row = await ports.sessionStore.read();
      finalExpiresAt = row?.expiresAt;
      return row;
    }, write: ports.sessionStore.write }, probe, clock);
  if (finalSession.status !== "READY_FOR_READONLY_PREFLIGHT")
    return result(finalSession.status);
  const finalNowMs = clock();
  if (!validTime(finalNowMs) || finalExpiresAt === undefined)
    return result("PREFLIGHT_UNVERIFIED");
  if (finalExpiresAt !== null && Date.parse(finalExpiresAt) <= finalNowMs)
    return result("AUTH_REQUIRED");
  if (evidence.observedAtMs > finalNowMs ||
      finalNowMs - evidence.observedAtMs > 30_000)
    return result("PREFLIGHT_UNVERIFIED");

  const checked = transitionWebHttpExecution(initial, { type: "CHECK",
    nowMs: finalNowMs,
    checks: { ...evidence.checks, auth: "VALID" } });
  if (checked.phase === "BLOCKED_EXISTING_LINK")
    return result("BLOCKED_EXISTING_DRAFT");
  if (checked.phase === "WAIT_INTERVAL") return result("WAIT_INTERVAL");
  return result(checked.phase === "READY" ? "READY_FOR_RESERVATION" :
    "PREFLIGHT_UNVERIFIED");
}
