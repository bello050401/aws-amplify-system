import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { MercariManualListingPack } from "../../../app/actions/mercariManualListingPack";
import type { WebHttpDraftJob } from "./webHttpDraftJob.ts";
import { initialWebHttpExecutionState } from "./webHttpExecutionGate.ts";
import { openMercariWebHttpCookieReadOnly } from "./webHttpReadOnlyClient.ts";
import { buildObservedCreateProductRequest, buildObservedProductValidationRequest,
  observedProductValidationSucceeded, parseObservedCreateProductAck,
  type ObservedProductRead } from "./webHttpObservedProductContract.ts";
import { reserveWebHttpSendStart, webHttpSendPermitFresh, webHttpStageRequestId,
  type WebHttpSendAttempt, type WebHttpSendReservationRepository } from "./webHttpSendReservation.ts";
import type { WebHttpProductBinding } from "./webHttpProductStop.ts";
import { CREATE_PRODUCT_QUERY } from "./webHttpObservedProductQueries.ts";

type Request = NonNullable<ReturnType<typeof buildObservedCreateProductRequest>>;
export type PublishPreview = { digest: string; title: string; priceYen: number;
  quantity: number; imageCount: number; draftId: string };
export type PublishResult = { status: "READY_FOR_CONFIRMATION" | "PUBLISHED" |
  "AUTH_REQUIRED" | "SOURCE_CHANGED" | "DRAFT_UNVERIFIED" | "CONFIRMATION_CHANGED" |
  "WAIT_INTERVAL" | "STORAGE_UNAVAILABLE" | "RESULT_UNKNOWN_NO_RESEND" |
  "VALIDATION_FAILED" | "EXISTING_PRODUCT";
  preview: PublishPreview | null; productId: string | null; nextEligibleAtMs: number | null };
export type ProductPublishPorts = {
  session: { cookieHeader: string; expiresAtMs: number | null };
  getJob: (requestId: string) => Promise<WebHttpDraftJob | null>;
  /** Rebuild from current inventory, EC draft, category and existing channel records. */
  sourceUnchanged: (job: WebHttpDraftJob) => Promise<boolean>;
  /** Immutable verified link only; receipt recovery must not depend on today's images. */
  readDraftId: (job: WebHttpDraftJob) => Promise<string | null>;
  readVerifiedDraft: (job: WebHttpDraftJob) => Promise<{ id: string; assetIds: string[] } | null>;
  readBinding: (inventoryId: string) => Promise<WebHttpProductBinding | null>;
  saveBinding: (binding: WebHttpProductBinding, requestId: string, verifiedAt: string,
    remoteStatus: "STATUS_OPENED" | "STATUS_UNOPENED") => Promise<void>;
  repository: WebHttpSendReservationRepository & {
    claimProductStart: (id: string, attemptId: string, requestJson: string, now: string) => Promise<void>;
    acknowledgeProduct: (id: string, attemptId: string, productId: string, now: string) => Promise<void>;
  };
  fetchPort?: typeof fetch;
};
const result = (status: PublishResult["status"], preview: PublishPreview | null = null,
  productId: string | null = null, nextEligibleAtMs: number | null = null): PublishResult =>
  ({ status, preview, productId, nextEligibleAtMs });
const digest = (request: Request) => createHash("sha256")
  .update(JSON.stringify(request.variables.input)).digest("hex");

function matchesPack(request: Request, job: WebHttpDraftJob, assetIds: string[]) {
  const pack: MercariManualListingPack = JSON.parse(job.snapshotJson).pack;
  const input = request.variables.input;
  // Only the BELLO condition mapping established by the observed draft is enabled.
  return pack.condition === "NO_NOTABLE_DAMAGE" && input.condition === "CONDITION_CLEAN" &&
    input.name === pack.title && input.description === pack.description &&
    input.price === pack.priceYen && input.variants[0]?.quantity === pack.quantity &&
    input.variants[0]?.skuCode === job.managementCode &&
    input.variants[0]?.name === "" && input.variants[0]?.janCode === "" &&
    JSON.stringify(input.assetIds) === JSON.stringify(assetIds) &&
    assetIds.length === pack.imageRefs.length &&
    JSON.stringify(input.categoryIds) === JSON.stringify([pack.categoryId]) &&
    JSON.stringify(input.brandIds) === JSON.stringify(pack.brandId ? [pack.brandId] : []) &&
    input.shippingMethodType === pack.shipping.method &&
    input.shippingPayerType === pack.shipping.payer &&
    input.shippingFromStateId === pack.shipping.origin &&
    input.shippingDurationType === pack.shipping.duration;
}

function productMatches(product: ObservedProductRead, request: Request) {
  const input = request.variables.input;
  const content = Object.fromEntries(Object.entries(input).filter(([key]) =>
    !["productDraftId", "shopId", "status", "variants"].includes(key)));
  const variant = product.variants[0], expected = input.variants[0];
  return product.shopId === input.shopId && product.status === input.status &&
    JSON.stringify(product.fields) === JSON.stringify(content) && !!variant &&
    variant.name === expected.name && variant.quantity === expected.quantity &&
    variant.skuCode === expected.skuCode && variant.janCode === expected.janCode;
}

/** Prepare a concrete review, or execute that exact reviewed draft once. All
 * requests run on the server; the browser never receives the Shops session.
 * A timeout or missing receipt is not permission to create another product.
 */
export async function publishPreparedWebHttpProduct(requestId: string, requestedBy: string,
  confirmedDigest: string | null, ports: ProductPublishPorts, clock = Date.now): Promise<PublishResult> {
  try {
    const job = await ports.getJob(requestId);
    if (!job || job.requestId !== requestId || job.requestedBy !== requestedBy ||
        !initialWebHttpExecutionState(job)) return result("SOURCE_CHANGED");
    const binding = await ports.readBinding(job.inventoryId);
    if (binding) return result("EXISTING_PRODUCT", null, binding.remoteProductId);
    const fresh = (margin = 0) => Number.isSafeInteger(ports.session.expiresAtMs) &&
      ports.session.expiresAtMs! > clock() + margin;
    if (!fresh(40_000)) return result("AUTH_REQUIRED");
    const opened = await openMercariWebHttpCookieReadOnly(ports.session,
      { fetchPort: ports.fetchPort, clock });
    if (!opened.client || !(await opened.client.verifyTargetShop()).shopMatched)
      return result("AUTH_REQUIRED");
    const client = opened.client;
    const draftId = await ports.readDraftId(job);
    if (!draftId) return result("DRAFT_UNVERIFIED");
    const stage = { kind: "PRODUCT_CREATE", draftId } as const;
    const stageId = webHttpStageRequestId(job, stage)!;
    let attempt = await ports.repository.getAttempt(stageId);
    const saved: Request | null = attempt?.productCreateRequestJson ? JSON.parse(attempt.productCreateRequestJson) : null;
    if (attempt && !saved) return result("RESULT_UNKNOWN_NO_RESEND");
    if (saved && (saved.operationName !== "CreateProduct" || saved.query !== CREATE_PRODUCT_QUERY ||
        saved.variables.input.productDraftId !== draftId ||
        !matchesPack(saved, job, saved.variables.input.assetIds))) return result("RESULT_UNKNOWN_NO_RESEND");
    // Reconcile a durable receipt before all new-send checks. A later inventory
    // edit, sale or image removal must never orphan an already-created product.
    let request = saved;
    const verify = async (receipt: WebHttpSendAttempt): Promise<PublishResult> => {
      if (receipt.status !== "PRODUCT_ACKNOWLEDGED" || !receipt.remoteProductId ||
          receipt.requestId !== stageId || receipt.inventoryId !== job.inventoryId ||
          receipt.snapshotFingerprint !== job.snapshotFingerprint || receipt.requestedBy !== requestedBy)
        return result("RESULT_UNKNOWN_NO_RESEND");
      const read = await client.readProduct(receipt.remoteProductId);
      if (!read.product || read.product.shopId !== job.shopId ||
          read.product.variants[0]?.skuCode !== job.managementCode)
        return result(read.status === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : "RESULT_UNKNOWN_NO_RESEND");
      await ports.saveBinding({ inventoryId: job.inventoryId, shopId: job.shopId,
        managementCode: job.managementCode, remoteProductId: read.product.id },
      stageId, new Date(clock()).toISOString(), read.product.status);
      // A changed remote item is still linked for recovery, but does not count
      // as successful publication of the reviewed price, stock and images.
      return result(request && productMatches(read.product, request) ? "PUBLISHED" : "EXISTING_PRODUCT", null, read.product.id);
    };
    if (attempt) return await verify(attempt);
    if (!await ports.sourceUnchanged(job)) return result("SOURCE_CHANGED");
    const link = await ports.readVerifiedDraft(job);
    if (!link || link.id !== draftId) return result("DRAFT_UNVERIFIED");
    request = buildObservedCreateProductRequest(await client.readDraftBody(draftId), draftId, Math.random());
    if (!request || !matchesPack(request, job, link.assetIds)) return result("DRAFT_UNVERIFIED");
    const preview: PublishPreview = { digest: digest(request), title: request.variables.input.name,
      priceYen: request.variables.input.price, quantity: request.variables.input.variants[0].quantity,
      imageCount: link.assetIds.length, draftId };
    if (confirmedDigest === null) return result("READY_FOR_CONFIRMATION", preview);
    if (confirmedDigest !== preview.digest) return result("CONFIRMATION_CHANGED", preview);
    const post = async (body: unknown, timeout = 10_000) => {
      if (!fresh(timeout)) return null;
      try {
        const response = await (ports.fetchPort ?? fetch)("https://mercari-shops.com/graphql", {
          method: "POST", redirect: "manual", credentials: "omit", cache: "no-store",
          signal: AbortSignal.timeout(timeout), headers: { Accept: "application/json",
            "Content-Type": "application/json", Origin: "https://mercari-shops.com",
            Cookie: ports.session.cookieHeader }, body: JSON.stringify(body),
        });
        return response.status === 200 && !response.redirected ? await response.json() : null;
      } catch { return null; }
    };
    if (!observedProductValidationSucceeded(await post(buildObservedProductValidationRequest(
      preview.title, request.variables.input.description)))) return result("VALIDATION_FAILED");
    if (!fresh(40_000)) return result("AUTH_REQUIRED");
    const reservation = await reserveWebHttpSendStart(job, { auth: "VALID",
      userReauthenticatedByHuman: true, writeContractVerified: true,
      remoteDuplicate: "ABSENT", existingBinding: false }, randomUUID(), ports.repository, clock, stage);
    if (!reservation.ok) return result(reservation.code === "WAIT_INTERVAL" ? "WAIT_INTERVAL" :
      "RESULT_UNKNOWN_NO_RESEND", null, null, reservation.nextEligibleAtMs ?? null);
    const current = buildObservedCreateProductRequest(await client.readDraftBody(link.id), link.id,
      request.variables.idempotencyKeySeed);
    if (!current || digest(current) !== preview.digest || !await ports.sourceUnchanged(job) ||
        await ports.readBinding(job.inventoryId)) return result("SOURCE_CHANGED");
    if (!webHttpSendPermitFresh(reservation, clock()) || !fresh(10_000)) return result("AUTH_REQUIRED");
    await ports.repository.claimProductStart(stageId, reservation.attemptId, JSON.stringify(request), new Date(clock()).toISOString());
    // A claimed request remains uncertain even if the final check prevents sending.
    if (!await ports.sourceUnchanged(job) || await ports.readBinding(job.inventoryId) ||
        !webHttpSendPermitFresh(reservation, clock()) || !fresh(10_000))
      return result("RESULT_UNKNOWN_NO_RESEND");
    const productId = parseObservedCreateProductAck(await post(request,
      Math.min(10_000, reservation.sendBeforeMs - clock())));
    if (!productId) return result("RESULT_UNKNOWN_NO_RESEND");
    await ports.repository.acknowledgeProduct(stageId, reservation.attemptId,
      productId, new Date(clock()).toISOString());
    attempt = await ports.repository.getAttempt(stageId);
    return attempt ? await verify(attempt) : result("RESULT_UNKNOWN_NO_RESEND");
  } catch { return result("STORAGE_UNAVAILABLE"); }
}
