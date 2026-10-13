import "server-only";
import { randomUUID } from "node:crypto";
import { openMercariWebHttpCookieReadOnly } from "./webHttpReadOnlyClient.ts";
import { buildObservedProductVisibilityRequest, buildObservedProductValidationRequest,
  observedProductContentFingerprint, observedProductValidationSucceeded } from "./webHttpObservedProductContract.ts";
import { reserveWebHttpProductStopStart, webHttpSendPermitFresh,
  type WebHttpSendAttempt } from "./webHttpSendReservation.ts";
import type { WebHttpProductStopPorts } from "./webHttpProductStop.ts";
import type { PublishPreview, PublishResult } from "./webHttpProductPublish.ts";
import { WEB_HTTP_SHOP_ID } from "./webHttpDraftJob.ts";

type Ports = Omit<WebHttpProductStopPorts, "repository"> & {
  repository: WebHttpProductStopPorts["repository"] & {
    verifyProductStop: (requestId: string, attemptId: string, shopId: string, productId: string,
      fingerprint: string, now: string, desiredStatus?: "STATUS_OPENED" | "STATUS_UNOPENED") => Promise<void>;
  };
  canReopen: (inventoryId: string, quantity: number) => Promise<boolean>;
};
const result = (status: PublishResult["status"], preview: PublishPreview | null = null,
  productId: string | null = null, nextEligibleAtMs: number | null = null): PublishResult =>
  ({ status, preview, productId, nextEligibleAtMs });

/** Relist the exact linked product; this function has no CreateProduct path. */
export async function reopenObservedWebHttpProduct(inventoryId: string, requestedBy: string,
  confirmedDigest: string | null, ports: Ports, clock = Date.now): Promise<PublishResult> {
  try {
    if (!/^[a-f0-9-]{36}$/i.test(inventoryId) || !requestedBy) return result("SOURCE_CHANGED");
    const binding = await ports.readBinding(inventoryId);
    if (!binding || binding.inventoryId !== inventoryId || binding.shopId !== WEB_HTTP_SHOP_ID)
      return result("SOURCE_CHANGED");
    const fresh = () => ports.session.expiresAtMs !== null && ports.session.expiresAtMs > clock() + 40_000;
    if (!fresh()) return result("AUTH_REQUIRED");
    const opened = await openMercariWebHttpCookieReadOnly(ports.session, { fetchPort: ports.fetchPort, clock });
    if (!opened.client || !(await opened.client.verifyTargetShop()).shopMatched) return result("AUTH_REQUIRED");
    const client = opened.client;
    const sameBinding = async () => {
      const current = await ports.readBinding(inventoryId);
      return current?.remoteProductId === binding.remoteProductId && current.shopId === binding.shopId &&
        current.managementCode === binding.managementCode && current.inventoryId === inventoryId;
    };
    const verify = async (attempt: WebHttpSendAttempt): Promise<PublishResult> => {
      if (attempt.desiredProductStatus !== "STATUS_OPENED" || attempt.inventoryId !== inventoryId ||
          attempt.remoteProductId !== binding.remoteProductId || attempt.requestedBy !== requestedBy ||
          !["SEND_CLAIMED_RESULT_UNKNOWN", "PRODUCT_REOPEN_VERIFIED"].includes(attempt.status))
        return result("RESULT_UNKNOWN_NO_RESEND");
      const read = await client.readProduct(binding.remoteProductId);
      if (!read.product || read.product.status !== "STATUS_OPENED" ||
          read.product.variants[0]?.skuCode !== binding.managementCode || !await sameBinding() ||
          observedProductContentFingerprint(read.product) !== attempt.productContentFingerprint)
        return result("RESULT_UNKNOWN_NO_RESEND");
      if (attempt.status !== "PRODUCT_REOPEN_VERIFIED") await ports.repository.verifyProductStop(
        attempt.requestId, attempt.attemptId, binding.shopId, binding.remoteProductId,
        attempt.productContentFingerprint!, new Date(clock()).toISOString(), "STATUS_OPENED");
      return result("PUBLISHED", null, binding.remoteProductId);
    };
    const pending = await ports.repository.getPendingProductStop(binding.shopId, binding.remoteProductId);
    if (pending) {
      const attempt = await ports.repository.getAttempt(pending);
      if (attempt?.desiredProductStatus === "STATUS_OPENED" && attempt.status === "RESERVED_NO_SEND" &&
          clock() >= Date.parse(attempt.sendBeforeAt)) {
        await ports.repository.cancelUnclaimedProductStop(attempt);
        return result("CONFIRMATION_CHANGED");
      }
      return attempt ? await verify(attempt) : result("RESULT_UNKNOWN_NO_RESEND");
    }
    const read = await client.readProduct(binding.remoteProductId), product = read.product;
    if (!product || product.variants[0]?.skuCode !== binding.managementCode || !await sameBinding())
      return result("DRAFT_UNVERIFIED");
    if (product.status === "STATUS_OPENED") return result("EXISTING_PRODUCT", null, product.id);
    const quantity = product.variants[0].quantity;
    if (quantity < 1 || !await ports.canReopen(inventoryId, quantity)) return result("SOURCE_CHANGED");
    const fingerprint = observedProductContentFingerprint(product);
    const preview: PublishPreview = { digest: fingerprint, title: product.fields.name,
      priceYen: product.fields.price, quantity, imageCount: product.fields.assetIds.length, draftId: product.id };
    if (confirmedDigest === null) return result("READY_FOR_CONFIRMATION", preview);
    if (confirmedDigest !== fingerprint) return result("CONFIRMATION_CHANGED", preview);
    const post = async (body: unknown) => {
      const response = await (ports.fetchPort ?? fetch)("https://mercari-shops.com/graphql", {
        method: "POST", redirect: "manual", credentials: "omit", cache: "no-store",
        signal: AbortSignal.timeout(10_000), headers: { "Content-Type": "application/json",
          Accept: "application/json", Origin: "https://mercari-shops.com", Cookie: ports.session.cookieHeader },
        body: JSON.stringify(body) });
      return response.status === 200 && !response.redirected ? response.json() : null;
    };
    if (!observedProductValidationSucceeded(await post(buildObservedProductValidationRequest(
      product.fields.name, product.fields.description)))) return result("VALIDATION_FAILED");
    if (!fresh()) return result("AUTH_REQUIRED");
    const reservation = await reserveWebHttpProductStopStart({ ...binding, requestedBy,
      productSnapshotId: product.snapshotId, productContentFingerprint: fingerprint,
      desiredProductStatus: "STATUS_OPENED" }, randomUUID(), ports.repository, clock);
    if (!reservation.ok) return result(reservation.code === "WAIT_INTERVAL" ? "WAIT_INTERVAL" :
      "RESULT_UNKNOWN_NO_RESEND", null, null, reservation.nextEligibleAtMs ?? null);
    const current = (await client.readProduct(product.id)).product;
    if (!current || current.status !== "STATUS_UNOPENED" || current.snapshotId !== product.snapshotId ||
        current.variants[0].stockSnapshotId !== product.variants[0].stockSnapshotId ||
        observedProductContentFingerprint(current) !== fingerprint || !await sameBinding() ||
        !await ports.canReopen(inventoryId, quantity)) return result("SOURCE_CHANGED");
    if (!fresh() || !webHttpSendPermitFresh(reservation, clock())) return result("AUTH_REQUIRED");
    await ports.repository.claimMutationStart(reservation.requestId, reservation.attemptId, new Date(clock()).toISOString());
    if (fresh() && await sameBinding() && await ports.canReopen(inventoryId, quantity) && webHttpSendPermitFresh(reservation, clock())) {
      try { await post(buildObservedProductVisibilityRequest(current, "STATUS_OPENED", Math.random())); }
      catch { /* Only authenticated readback can resolve an uncertain response. */ }
    }
    const attempt = await ports.repository.getAttempt(reservation.requestId);
    return attempt ? await verify(attempt) : result("RESULT_UNKNOWN_NO_RESEND");
  } catch { return result("STORAGE_UNAVAILABLE"); }
}
