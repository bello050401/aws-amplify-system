import "server-only";

import type { WebHttpDraftJob } from "./webHttpDraftJob.ts";
import { initialWebHttpExecutionState } from "./webHttpExecutionGate.ts";
import { buildObservedImageAssetRequest,
  parseObservedImageAssetResponse,
  type PreparedObservedJpeg } from "./webHttpObservedImageAsset.ts";
import type { ObservedDraftAssetProof } from "./webHttpObservedDraftWrite.ts";
import { webHttpSendPermitFresh, webHttpStageRequestId,
  WEB_HTTP_SEND_DEADLINE_MS,
  type WebHttpSendAttempt, type WebHttpSendReservationResult,
  type WebHttpShopSendSlot } from "./webHttpSendReservation.ts";

const GRAPHQL_URL = "https://mercari-shops.com/graphql";
type AuthCheck = { status: "VALID" | "AUTH_REQUIRED" | "UNKNOWN";
  shopId: string | null; verifiedAtMs: number | null };
type Repository = {
  getAttempt(requestId: string): Promise<WebHttpSendAttempt | null>;
  getSlot(shopId: string): Promise<WebHttpShopSendSlot | null>;
  claimMutationStart(requestId: string, attemptId: string,
    nowIso: string): Promise<void>;
  acknowledgeImageAsset(requestId: string, attemptId: string,
    remoteAssetId: string, preparedJpegSha256: string,
    nowIso: string): Promise<void>;
};
export type ObservedImageSourceProof = {
  snapshotFingerprint: string;
  inventoryId: string;
  storageKey: string;
  originalSha256: string;
  preparedJpegSha256: string;
};
export type ObservedImageUploadPorts = {
  cookieHeader: string;
  cookieExpiresAtMs: number | null;
  fetchPort: typeof fetch;
  repository: Repository;
  /** Both checks are read-only and use current BELLO / Shops data. */
  verifyCurrentJob: (job: WebHttpDraftJob) => Promise<boolean>;
  verifyAuthFresh: () => Promise<AuthCheck>;
};
export type ObservedImageUploadResult = {
  status: "INVALID_INPUT_NO_SEND" | "SOURCE_UNVERIFIED_NO_SEND" |
    "RESERVATION_UNVERIFIED_NO_SEND" | "INVENTORY_UNVERIFIED_NO_SEND" |
    "AUTH_REQUIRED_NO_SEND" | "AUTH_UNVERIFIED_NO_SEND" |
    "AUTH_REQUIRED_NO_RESEND" | "RESULT_UNKNOWN_NO_RESEND" |
    "ASSET_ACKNOWLEDGED";
  assetProof: ObservedDraftAssetProof | null;
  allowRetry: false;
};
const result = (status: ObservedImageUploadResult["status"],
  assetProof: ObservedDraftAssetProof | null = null): ObservedImageUploadResult =>
  ({ status, assetProof, allowRetry: false });
const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0;

function frozenImageKey(job: WebHttpDraftJob): string | null {
  try {
    const snapshot: unknown = JSON.parse(job.snapshotJson);
    if (!snapshot || typeof snapshot !== "object" ||
        !("pack" in snapshot) || !snapshot.pack ||
        typeof snapshot.pack !== "object" ||
        !("imageRefs" in snapshot.pack) ||
        !Array.isArray(snapshot.pack.imageRefs) ||
        snapshot.pack.imageRefs.length !== 1) return null;
    const image = snapshot.pack.imageRefs[0];
    return image && typeof image.storageKey === "string" ?
      image.storageKey : null;
  } catch { return null; }
}

function validClaim(job: WebHttpDraftJob, stageRequestId: string,
  reservation: WebHttpSendReservationResult,
  attempt: WebHttpSendAttempt | null,
  slot: WebHttpShopSendSlot | null, now: number): boolean {
  if (!reservation.ok || reservation.requestId !== stageRequestId ||
      !webHttpSendPermitFresh(reservation, now) || !attempt || !slot)
    return false;
  const sendBeforeAt = new Date(reservation.sendBeforeMs).toISOString();
  return attempt.status === "RESERVED_NO_SEND" &&
    attempt.requestId === stageRequestId &&
    attempt.inventoryId === job.inventoryId &&
    attempt.shopId === job.shopId &&
    attempt.snapshotFingerprint === job.snapshotFingerprint &&
    attempt.attemptId === reservation.attemptId &&
    attempt.slotRevision === reservation.slotRevision &&
    attempt.reservedAt === reservation.reservedAt &&
    attempt.sendBeforeAt === sendBeforeAt &&
    slot.shopId === job.shopId && slot.requestId === stageRequestId &&
    slot.attemptId === reservation.attemptId &&
    slot.revision === reservation.slotRevision &&
    slot.lastStartedAt === reservation.reservedAt &&
    slot.sendBeforeAt === sendBeforeAt &&
    validTime(Date.parse(slot.nextEligibleAt)) &&
    Date.parse(slot.nextEligibleAt) - reservation.sendBeforeMs >= 30_000;
}

/** Unwired, one-shot server HTTPS sender for the owner's observed multipart.
 * Once claimed, any network or persistence ambiguity requires readback.
 */
export async function executeObservedImageUploadOnce(job: WebHttpDraftJob,
  reservation: WebHttpSendReservationResult,
  prepared: PreparedObservedJpeg, sourceProof: ObservedImageSourceProof,
  ports: ObservedImageUploadPorts,
  clock: () => number = Date.now): Promise<ObservedImageUploadResult> {
  if (!initialWebHttpExecutionState(job) || !ports ||
      typeof ports.fetchPort !== "function" ||
      typeof ports.verifyCurrentJob !== "function" ||
      typeof ports.verifyAuthFresh !== "function" ||
      typeof ports.repository?.claimMutationStart !== "function" ||
      typeof ports.repository?.acknowledgeImageAsset !== "function" ||
      typeof ports.cookieHeader !== "string" ||
      ports.cookieHeader.length < 1 || ports.cookieHeader.length > 32_768 ||
      /[\r\n\0]/.test(ports.cookieHeader) ||
      ports.cookieExpiresAtMs === null ||
      !validTime(ports.cookieExpiresAtMs))
    return result("INVALID_INPUT_NO_SEND");
  if (!sourceProof || !prepared ||
      sourceProof.inventoryId !== job.inventoryId ||
      sourceProof.snapshotFingerprint !== job.snapshotFingerprint ||
      sourceProof.storageKey !== frozenImageKey(job) ||
      !/^[a-f0-9]{64}$/.test(sourceProof.originalSha256) ||
      prepared.originalSha256 !== sourceProof.originalSha256 ||
      prepared.preparedJpegSha256 !== sourceProof.preparedJpegSha256)
    return result("SOURCE_UNVERIFIED_NO_SEND");
  let body: FormData;
  try {
    body = buildObservedImageAssetRequest(prepared.preparedJpegBytes,
      sourceProof.preparedJpegSha256).body;
  } catch { return result("SOURCE_UNVERIFIED_NO_SEND"); }
  const stageRequestId = webHttpStageRequestId(job, {
    kind: "IMAGE_UPLOAD", preparedJpegSha256: sourceProof.preparedJpegSha256,
  });
  if (!stageRequestId || !reservation.ok ||
      reservation.requestId !== stageRequestId)
    return result("RESERVATION_UNVERIFIED_NO_SEND");
  let current = false;
  try { current = await ports.verifyCurrentJob(job); }
  catch { /* no send */ }
  if (!current) return result("INVENTORY_UNVERIFIED_NO_SEND");
  let auth: AuthCheck;
  try { auth = await ports.verifyAuthFresh(); }
  catch { return result("AUTH_UNVERIFIED_NO_SEND"); }
  let now = clock();
  if (auth.status === "AUTH_REQUIRED") return result("AUTH_REQUIRED_NO_SEND");
  if (auth.status !== "VALID" || auth.shopId !== job.shopId ||
      !validTime(now) || !validTime(auth.verifiedAtMs ?? -1) ||
      (auth.verifiedAtMs ?? -1) > now ||
      now - (auth.verifiedAtMs ?? -1) > 30_000 ||
      ports.cookieExpiresAtMs <= now + WEB_HTTP_SEND_DEADLINE_MS + 10_000)
    return result("AUTH_UNVERIFIED_NO_SEND");
  let attempt: WebHttpSendAttempt | null;
  let slot: WebHttpShopSendSlot | null;
  try {
    attempt = await ports.repository.getAttempt(stageRequestId);
    slot = await ports.repository.getSlot(job.shopId);
  } catch { return result("RESERVATION_UNVERIFIED_NO_SEND"); }
  now = clock();
  if (!validTime(now) || !validClaim(job, stageRequestId,
    reservation, attempt, slot, now))
    return result("RESERVATION_UNVERIFIED_NO_SEND");
  try {
    await ports.repository.claimMutationStart(stageRequestId,
      reservation.attemptId, new Date(now).toISOString());
  } catch { return result("RESERVATION_UNVERIFIED_NO_SEND"); }
  // No retry after this point, including an expired permit before fetch.
  try { auth = await ports.verifyAuthFresh(); }
  catch { return result("RESULT_UNKNOWN_NO_RESEND"); }
  // Stock or the saved image can change while the authenticated check runs.
  // After the durable claim, an unverified source must stop without a resend.
  try { current = await ports.verifyCurrentJob(job); }
  catch { current = false; }
  if (!current) return result("RESULT_UNKNOWN_NO_RESEND");
  now = clock();
  if (auth.status !== "VALID" || auth.shopId !== job.shopId ||
      !validTime(now) || !validTime(auth.verifiedAtMs ?? -1) ||
      (auth.verifiedAtMs ?? -1) > now ||
      now - (auth.verifiedAtMs ?? -1) > 30_000 ||
      ports.cookieExpiresAtMs <= now ||
      !webHttpSendPermitFresh(reservation, now))
    return result(auth.status === "AUTH_REQUIRED" ?
      "AUTH_REQUIRED_NO_RESEND" : "RESULT_UNKNOWN_NO_RESEND");
  let response: Response;
  try {
    response = await ports.fetchPort(GRAPHQL_URL, {
      method: "POST", redirect: "manual", cache: "no-store",
      credentials: "omit", signal: AbortSignal.timeout(10_000),
      headers: { Accept: "application/json",
        Origin: "https://mercari-shops.com", Cookie: ports.cookieHeader },
      body,
    });
  } catch { return result("RESULT_UNKNOWN_NO_RESEND"); }
  if (response.status === 401 || response.status === 403)
    return result("AUTH_REQUIRED_NO_RESEND");
  if (response.redirected || response.status !== 200)
    return result("RESULT_UNKNOWN_NO_RESEND");
  let payload: unknown;
  try { payload = await response.json(); }
  catch { return result("RESULT_UNKNOWN_NO_RESEND"); }
  if (payload && typeof payload === "object" &&
      "errors" in payload && Array.isArray(payload.errors) &&
      payload.errors.some(error => error && typeof error === "object" &&
        "extensions" in error && error.extensions &&
        typeof error.extensions === "object" &&
        "code" in error.extensions &&
        ["UNAUTHENTICATED", "FORBIDDEN"].includes(
          String(error.extensions.code))))
    return result("AUTH_REQUIRED_NO_RESEND");
  const asset = parseObservedImageAssetResponse(response.status, payload);
  if (!asset) return result("RESULT_UNKNOWN_NO_RESEND");
  try {
    await ports.repository.acknowledgeImageAsset(stageRequestId,
      reservation.attemptId, asset.remoteAssetId,
      sourceProof.preparedJpegSha256, new Date(clock()).toISOString());
  } catch { return result("RESULT_UNKNOWN_NO_RESEND"); }
  return result("ASSET_ACKNOWLEDGED", {
    status: "VERIFIED_SAME_IMAGE_BYTES", shopId: job.shopId,
    inventoryId: job.inventoryId,
    snapshotFingerprint: job.snapshotFingerprint,
    remoteAssetId: asset.remoteAssetId, imageRefCount: 1,
  });
}
