import "server-only";

import { randomUUID } from "node:crypto";
import { WEB_HTTP_SHOP_ID } from "./webHttpDraftJob.ts";
import { openMercariWebHttpCookieReadOnly, type WebHttpReadOnlyClient } from
  "./webHttpReadOnlyClient.ts";
import { buildObservedStopProductRequestFromRead, buildObservedProductValidationRequest,
  observedProductContentFingerprint, observedProductValidationSucceeded } from
  "./webHttpObservedProductContract.ts";
import { reserveWebHttpProductStopStart, webHttpSendPermitFresh,
  type WebHttpSendAttempt, type WebHttpSendReservationRepository } from
  "./webHttpSendReservation.ts";

export type WebHttpProductBinding = {
  inventoryId: string; shopId: string; remoteProductId: string; managementCode: string;
};
export type WebHttpProductStopPorts = {
  /** Trusted server-side secret store. Never supply credentials via a browser action. */
  session: { cookieHeader: string; expiresAtMs: number | null };
  readBinding: (inventoryId: string) => Promise<WebHttpProductBinding | null>;
  repository: WebHttpSendReservationRepository & {
    getPendingProductStop: (shopId: string, productId: string) => Promise<string | null>;
    claimMutationStart: (requestId: string, attemptId: string, nowIso: string) => Promise<void>;
    cancelUnclaimedProductStop: (attempt: WebHttpSendAttempt) => Promise<void>;
    verifyProductStop: (requestId: string, attemptId: string, shopId: string, productId: string,
      fingerprint: string, nowIso: string) => Promise<void>;
  };
  fetchPort?: typeof fetch;
};
type StopStatus = "INVALID_INPUT" | "BINDING_UNVERIFIED" | "AUTH_REQUIRED" |
  "READ_UNVERIFIED" | "TARGET_CHANGED" | "VALIDATION_FAILED" |
  "WAIT_INTERVAL" | "STORAGE_UNAVAILABLE" | "RESERVATION_BLOCKED" |
  "RESULT_UNKNOWN_NO_RESEND" | "STOP_VERIFIED" | "ALREADY_STOPPED";
export type WebHttpProductStopResult = {
  status: StopStatus; requestId: string | null; productId: string | null;
  stopConfirmed: boolean; allowAutomaticResend: false; nextEligibleAtMs: number | null;
};
const result = (status: StopStatus, requestId: string | null = null,
  productId: string | null = null, nextEligibleAtMs: number | null = null):
  WebHttpProductStopResult => ({ status, requestId, productId,
    stopConfirmed: status === "STOP_VERIFIED" || status === "ALREADY_STOPPED",
    allowAutomaticResend: false, nextEligibleAtMs });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validTime = (now: number) => Number.isSafeInteger(now) && now >= 0;
const sessionFresh = (ports: WebHttpProductStopPorts, now: number, margin = 0) =>
  validTime(now) && ports.session.expiresAtMs !== null &&
  Number.isSafeInteger(ports.session.expiresAtMs) && ports.session.expiresAtMs > now + margin;
const sameBinding = (a: WebHttpProductBinding | null, b: WebHttpProductBinding) =>
  !!a && a.inventoryId === b.inventoryId && a.shopId === b.shopId &&
  a.remoteProductId === b.remoteProductId && a.managementCode === b.managementCode;

async function bindingFor(inventoryId: string, ports: WebHttpProductStopPorts) {
  try {
    const link = await ports.readBinding(inventoryId);
    return link && link.inventoryId === inventoryId && link.shopId === WEB_HTTP_SHOP_ID &&
      /^[A-Za-z0-9]{1,64}$/.test(link.remoteProductId) &&
      typeof link.managementCode === "string" && link.managementCode.trim() ? link : null;
  } catch { return null; }
}

async function open(ports: WebHttpProductStopPorts, clock: () => number) {
  const auth = await openMercariWebHttpCookieReadOnly(ports.session,
    { fetchPort: ports.fetchPort, clock });
  if (!auth.client) return { client: null, authRequired: auth.status === "AUTH_REQUIRED" };
  const shop = await auth.client.verifyTargetShop();
  return { client: shop.shopMatched ? auth.client : null,
    authRequired: shop.status === "AUTH_REQUIRED" };
}

/** Fixed observed origin, no redirects, no retries and no raw response in results. */
async function post(ports: WebHttpProductStopPorts, payload: unknown,
  clock: () => number, deadline?: number) {
  const now = clock();
  if (!sessionFresh(ports, now) || deadline !== undefined && now >= deadline)
    return { body: null, authRequired: true };
  try {
    const response = await (ports.fetchPort ?? fetch)("https://mercari-shops.com/graphql", {
      method: "POST", redirect: "manual", credentials: "omit", cache: "no-store",
      signal: AbortSignal.timeout(Math.min(10_000,
        deadline === undefined ? 10_000 : Math.max(1, deadline - now))),
      headers: { "Content-Type": "application/json", Accept: "application/json",
        Origin: "https://mercari-shops.com", Cookie: ports.session.cookieHeader },
      body: JSON.stringify(payload),
    });
    if (response.status === 401 || response.status === 403)
      return { body: null, authRequired: true };
    if (response.status !== 200 || response.redirected)
      return { body: null, authRequired: false };
    const body = await response.json();
    if (!sessionFresh(ports, clock()) || clock() < now)
      return { body: null, authRequired: true };
    const authRequired = Array.isArray(body?.errors) && body.errors.some(
      (error: { extensions?: { code?: string } }) =>
        ["UNAUTHENTICATED", "FORBIDDEN"].includes(error?.extensions?.code ?? ""));
    return { body: authRequired ? null : body, authRequired };
  } catch { return { body: null, authRequired: false }; }
}

async function reconcile(attempt: WebHttpSendAttempt, binding: WebHttpProductBinding,
  client: WebHttpReadOnlyClient, ports: WebHttpProductStopPorts, clock: () => number) {
  const unknown = (status: StopStatus = "RESULT_UNKNOWN_NO_RESEND") =>
    result(status, attempt.requestId, binding.remoteProductId);
  if (!["SEND_CLAIMED_RESULT_UNKNOWN", "PRODUCT_STOP_VERIFIED"].includes(attempt.status))
    return unknown();
  const read = await client.readProduct(binding.remoteProductId);
  if (read.status === "AUTH_REQUIRED") return unknown("AUTH_REQUIRED");
  const product = read.product;
  if (!product || product.status !== "STATUS_UNOPENED" ||
      product.variants[0]?.skuCode !== binding.managementCode ||
      observedProductContentFingerprint(product) !== attempt.productContentFingerprint ||
      !sameBinding(await bindingFor(binding.inventoryId, ports), binding)) return unknown();
  try {
    const now = clock();
    if (!validTime(now)) return unknown();
    if (attempt.status !== "PRODUCT_STOP_VERIFIED")
      await ports.repository.verifyProductStop(attempt.requestId, attempt.attemptId,
        binding.shopId, product.id, attempt.productContentFingerprint!, new Date(now).toISOString());
  } catch { return unknown("STORAGE_UNAVAILABLE"); }
  return result("STOP_VERIFIED", attempt.requestId, product.id);
}

/** Resume an uncertain stop by reading only. Keep the original request ID. */
export async function reconcileObservedWebHttpProductStop(requestId: string,
  requestedBy: string, ports: WebHttpProductStopPorts, clock: () => number = Date.now) {
  if (!/^[a-f0-9]{64}$/.test(requestId) || !requestedBy)
    return result("INVALID_INPUT");
  let attempt: WebHttpSendAttempt | null;
  try { attempt = await ports.repository.getAttempt(requestId); }
  catch { return result("STORAGE_UNAVAILABLE", requestId); }
  if (!attempt || attempt.requestId !== requestId || attempt.requestedBy !== requestedBy ||
      attempt.shopId !== WEB_HTTP_SHOP_ID || !attempt.productContentFingerprint ||
      !attempt.remoteProductId) return result("RESERVATION_BLOCKED", requestId);
  const binding = await bindingFor(attempt.inventoryId, ports);
  if (!binding || binding.remoteProductId !== attempt.remoteProductId)
    return result("BINDING_UNVERIFIED", requestId);
  if (attempt.status === "RESERVED_NO_SEND" && validTime(clock()) &&
      clock() >= Date.parse(attempt.sendBeforeAt)) {
    try { await ports.repository.cancelUnclaimedProductStop(attempt); }
    catch { return result("STORAGE_UNAVAILABLE", requestId); }
    return result("RESERVATION_BLOCKED", requestId);
  }
  const auth = await open(ports, clock);
  return auth.client ? reconcile(attempt, binding, auth.client, ports, clock) :
    result(auth.authRequired ? "AUTH_REQUIRED" : "READ_UNVERIFIED", requestId);
}

/** Server-only stop executor. It never creates, publishes or reopens a product.
 * The HTTP contract is observed; real sending is not enabled in a route yet.
 */
export async function stopObservedWebHttpProductOnce(inventoryId: string,
  requestedBy: string, ports: WebHttpProductStopPorts, clock: () => number = Date.now):
  Promise<WebHttpProductStopResult> {
  if (!UUID.test(inventoryId) || typeof requestedBy !== "string" || !requestedBy.trim())
    return result("INVALID_INPUT");
  const binding = await bindingFor(inventoryId, ports);
  if (!binding) return result("BINDING_UNVERIFIED");
  try {
    const pending = await ports.repository.getPendingProductStop(binding.shopId, binding.remoteProductId);
    if (pending) return reconcileObservedWebHttpProductStop(pending, requestedBy, ports, clock);
  } catch { return result("STORAGE_UNAVAILABLE"); }
  if (!sessionFresh(ports, clock(), 40_000)) return result("AUTH_REQUIRED");
  const auth = await open(ports, clock);
  if (!auth.client) return result(auth.authRequired ? "AUTH_REQUIRED" : "READ_UNVERIFIED");
  const read = await auth.client.readProduct(binding.remoteProductId);
  if (read.status === "AUTH_REQUIRED") return result("AUTH_REQUIRED");
  const product = read.product;
  if (!product || product.variants[0]?.skuCode !== binding.managementCode)
    return result("READ_UNVERIFIED");
  if (!sameBinding(await bindingFor(inventoryId, ports), binding))
    return result("BINDING_UNVERIFIED");
  if (product.status === "STATUS_UNOPENED")
    return result("ALREADY_STOPPED", null, product.id);
  const fingerprint = observedProductContentFingerprint(product);
  const payload = buildObservedStopProductRequestFromRead(product, Math.random());
  const validation = buildObservedProductValidationRequest(product.fields.name, product.fields.description);
  if (!payload || !validation) return result("READ_UNVERIFIED");
  const checked = await post(ports, validation, clock);
  if (checked.authRequired) return result("AUTH_REQUIRED");
  if (!observedProductValidationSucceeded(checked.body)) return result("VALIDATION_FAILED");
  if (!sessionFresh(ports, clock(), 40_000)) return result("AUTH_REQUIRED");
  const reservation = await reserveWebHttpProductStopStart({
    ...binding, requestedBy, productSnapshotId: product.snapshotId,
    productContentFingerprint: fingerprint,
  }, randomUUID(), ports.repository, clock);
  if (!reservation.ok) return result(reservation.code === "WAIT_INTERVAL" ?
    "WAIT_INTERVAL" : "RESERVATION_BLOCKED", null, product.id,
    reservation.nextEligibleAtMs ?? null);
  const requestId = reservation.requestId;
  const noSend = (status: StopStatus) => result(status, requestId, product.id);
  const current = await auth.client.readProduct(product.id);
  if (current.status === "AUTH_REQUIRED") return noSend("AUTH_REQUIRED");
  if (!current.product || current.product.status !== "STATUS_OPENED" ||
      current.product.snapshotId !== product.snapshotId ||
      current.product.variants[0]?.stockSnapshotId !== product.variants[0]?.stockSnapshotId ||
      observedProductContentFingerprint(current.product) !== fingerprint ||
      !sameBinding(await bindingFor(inventoryId, ports), binding)) return noSend("TARGET_CHANGED");
  let attempt: WebHttpSendAttempt | null;
  try {
    attempt = await ports.repository.getAttempt(requestId);
    const slot = await ports.repository.getSlot(binding.shopId);
    if (!attempt || attempt.status !== "RESERVED_NO_SEND" ||
        attempt.attemptId !== reservation.attemptId || attempt.requestedBy !== requestedBy ||
        attempt.inventoryId !== inventoryId || attempt.shopId !== binding.shopId ||
        attempt.remoteProductId !== product.id || attempt.productContentFingerprint !== fingerprint ||
        attempt.productSnapshotId !== product.snapshotId ||
        slot?.attemptId !== attempt.attemptId || slot.requestId !== requestId ||
        slot.revision !== reservation.slotRevision ||
        !webHttpSendPermitFresh(reservation, clock()) || !sessionFresh(ports, clock(), 10_000))
      return noSend("RESERVATION_BLOCKED");
    await ports.repository.claimMutationStart(requestId, attempt.attemptId,
      new Date(clock()).toISOString());
  } catch { return noSend("RESERVATION_BLOCKED"); }
  // The durable claim cannot be retried. Recheck the binding and deadline after
  // storage, then do exactly one HTTP update with the observed snapshots.
  if (webHttpSendPermitFresh(reservation, clock()) && sessionFresh(ports, clock(), 10_000) &&
      sameBinding(await bindingFor(inventoryId, ports), binding)) {
    await post(ports, payload, clock, reservation.sendBeforeMs);
  }
  return reconcile({ ...attempt, status: "SEND_CLAIMED_RESULT_UNKNOWN" },
    binding, auth.client, ports, clock);
}
