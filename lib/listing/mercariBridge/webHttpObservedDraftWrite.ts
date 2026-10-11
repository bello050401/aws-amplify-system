import "server-only";

import { B005396_INVENTORY_ID } from "./b005396GeneralPreparation.ts";
import { initialWebHttpExecutionState } from "./webHttpExecutionGate.ts";
import type { WebHttpDraftJob } from "./webHttpDraftJob.ts";
import { reconcileReservedWebHttpDraft,
  type WebHttpDraftReadback } from "./webHttpDraftSaveReconciliation.ts";
import { webHttpSendPermitFresh, type WebHttpSendAttempt,
  type WebHttpSendReservationResult,
  type WebHttpShopSendSlot } from "./webHttpSendReservation.ts";

const GRAPHQL_URL = "https://mercari-shops.com/graphql";
const SHOP_QUERY = "query OwnShops { ownShops { id } }";
const CREATE_QUERY = `mutation CreateProductDraft($input: CreateProductDraftInput!, $idempotencyKeySeed: Float!) {
  createProductDraft(createProductDraftInput: $input,
    idempotencyKeySeed: $idempotencyKeySeed) { id }
}`;
const UPDATE_QUERY = `mutation UpdateProductDraft($input: UpdateProductDraftInput!) {
  updateProductDraft(updateProductDraftInput: $input) { id }
}`;
const DRAFT_ID = /^[A-Za-z0-9]{1,64}$/;

type RecordValue = Record<string, unknown>;
type TargetDraftProof = { status: "VERIFIED_SAME_JOB_DRAFT";
  shopId: string; inventoryId: string; snapshotFingerprint: string;
  draftId: string };
type Mutation = { kind: "CREATE"; input: RecordValue;
  idempotencyKeySeed: number } | { kind: "UPDATE"; input: RecordValue;
    targetDraftProof: TargetDraftProof };
type AssetProof = { status: "VERIFIED_SAME_IMAGE_BYTES";
  shopId: string; inventoryId: string; snapshotFingerprint: string;
  remoteAssetId: string; imageRefCount: 1 };
type MappingProof = { status: "OBSERVED_INPUT_MAPPING_VERIFIED";
  snapshotFingerprint: string };
type Repository = {
  getAttempt: (requestId: string) => Promise<WebHttpSendAttempt | null>;
  getSlot: (shopId: string) => Promise<WebHttpShopSendSlot | null>;
  /** Conditional, durable transition. An unknown outcome must never send. */
  claimMutationStart: (requestId: string, attemptId: string,
    nowIso: string) => Promise<void>;
};
type DuplicatePreflight = (job: WebHttpDraftJob,
  targetDraftId: string | null) => Promise<
  "ABSENT_COMPLETE" | "FOUND" | "AUTH_REQUIRED" | "UNKNOWN" |
  { status: "TARGET_ONLY_COMPLETE"; draftId: string }>;
export type ObservedDraftWritePorts = {
  /** No production adapter is registered; this is a server-only secret. */
  cookieHeader: string;
  cookieExpiresAtMs: number | null;
  fetchPort: typeof fetch;
  repository: Repository;
  /** Fresh BELLO InventoryItem read by UUID; sku is the current source code. */
  readCurrentInventory: (inventoryId: string) => Promise<{
    id: string; sku: string } | null>;
  hasExistingBinding: (job: WebHttpDraftJob) => Promise<boolean | null>;
  /** Must use the same authenticated session and exhaust all pages. */
  duplicatePreflight: DuplicatePreflight;
  /** Read-only recovery; absence never permits another create. */
  readback: WebHttpDraftReadback;
};
export type ObservedDraftWriteResult = {
  status: "INVALID_JOB_NO_SEND" | "RESERVATION_UNVERIFIED_NO_SEND" |
    "INVENTORY_MISMATCH_NO_SEND" |
    "ASSET_UNVERIFIED_NO_SEND" | "MAPPING_UNVERIFIED_NO_SEND" |
    "AUTH_REQUIRED_NO_SEND" | "SHOP_UNVERIFIED_NO_SEND" |
    "DUPLICATE_OR_READ_UNVERIFIED_NO_SEND" |
    "CREATE_ACKNOWLEDGED_NEEDS_UPDATE" |
    "UPDATE_ACKNOWLEDGED_NEEDS_READBACK" |
    "AUTH_REQUIRED_NO_RESEND" | "RESULT_UNKNOWN_NO_RESEND";
  draftId: string | null;
  readbackStatus: string | null;
  allowRetry: false;
  listingConfirmed: false;
};

const result = (status: ObservedDraftWriteResult["status"],
  draftId: string | null = null,
  readbackStatus: string | null = null): ObservedDraftWriteResult => ({
  status, draftId, readbackStatus, allowRetry: false,
  listingConfirmed: false,
});
const object = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sameKeys = (value: RecordValue, keys: readonly string[]) =>
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(nonempty);
const validClock = (value: number) => Number.isSafeInteger(value) && value >= 0;

function frozenSourceCode(job: WebHttpDraftJob): string | null {
  try {
    const snapshot: unknown = JSON.parse(job.snapshotJson);
    if (!object(snapshot) || !object(snapshot.evidence) ||
        typeof snapshot.evidence.sourceInventoryCode !== "string" ||
        !/^[A-Za-z0-9_-]{1,40}$/.test(snapshot.evidence.sourceInventoryCode))
      return null;
    return snapshot.evidence.sourceInventoryCode;
  } catch { return null; }
}

function validPayload(job: WebHttpDraftJob, mutation: Mutation,
  assetId: string): boolean {
  if (!mutation || mutation.kind !== "CREATE" &&
      mutation.kind !== "UPDATE") return false;
  let pack: RecordValue;
  try {
    const snapshot: unknown = JSON.parse(job.snapshotJson);
    if (!object(snapshot) || !object(snapshot.pack)) return false;
    pack = snapshot.pack;
  } catch { return false; }
  if (!Array.isArray(pack.imageRefs) || pack.imageRefs.length !== 1)
    return false;
  if (!object(mutation?.input)) return false;
  const input = mutation.input;
  const variants = input.variants;
  if (!Array.isArray(variants) || variants.length !== 1 ||
      !object(variants[0])) return false;
  const variant = variants[0];
  if (input.name !== pack.title || input.description !== pack.description ||
      variant.quantity !== pack.quantity ||
      variant.skuCode !== job.managementCode ||
      typeof variant.name !== "string" ||
      typeof variant.janCode !== "string" ||
      typeof input.shippingPayerType !== "string" ||
      typeof input.countryRestrictionTemplateId !== "string" ||
      typeof input.channelListingScope !== "string" ||
      typeof input.isRefurbished !== "boolean" ||
      input.brandIds !== null || variant.maxQuantityPerOrder !== null)
    return false;
  const common = ["name", "description", "price", "assetIds", "categoryIds",
    "brandIds", "condition", "shippingFromStateId",
    "shippingDurationType", "shippingMethodType", "shippingPayerType",
    "countryRestrictionTemplateId", "isRefurbished",
    "channelListingScope", "variants"];
  if (mutation.kind === "CREATE") {
    return sameKeys(input, [...common, "shopId"]) &&
      input.shopId === job.shopId &&
      ["price", "assetIds", "categoryIds", "condition",
        "shippingFromStateId", "shippingDurationType",
        "shippingMethodType"].every(key => input[key] === null) &&
      sameKeys(variant, ["name", "quantity", "skuCode", "janCode",
        "catalogSkuId", "maxQuantityPerOrder"]) &&
      variant.catalogSkuId === null &&
      Number.isFinite(mutation.idempotencyKeySeed);
  }
  return sameKeys(input, [...common, "id"]) &&
    typeof input.id === "string" && DRAFT_ID.test(input.id) &&
    input.price === pack.priceYen &&
    Array.isArray(input.assetIds) && input.assetIds.length === 1 &&
    input.assetIds[0] === assetId &&
    stringArray(input.categoryIds) &&
    typeof pack.categoryId === "string" &&
    input.categoryIds.includes(pack.categoryId) &&
    ["condition", "shippingFromStateId", "shippingDurationType",
      "shippingMethodType"].every(key => typeof input[key] === "string") &&
    sameKeys(variant, ["name", "quantity", "skuCode", "janCode",
      "catalogSkuId", "attributes", "maxQuantityPerOrder"]) &&
    typeof variant.catalogSkuId === "string" &&
    Array.isArray(variant.attributes);
}

function validStoredClaim(job: WebHttpDraftJob,
  reservation: WebHttpSendReservationResult,
  attempt: WebHttpSendAttempt | null,
  slot: WebHttpShopSendSlot | null, now: number): boolean {
  if (!reservation.ok || !validClock(reservation.sendBeforeMs) ||
      reservation.sendBeforeMs > 8_640_000_000_000_000 ||
      !webHttpSendPermitFresh(reservation, now) ||
      !attempt || !slot) return false;
  return attempt.status === "RESERVED_NO_SEND" &&
    attempt.requestId === job.requestId &&
    attempt.inventoryId === job.inventoryId &&
    attempt.shopId === job.shopId &&
    attempt.snapshotFingerprint === job.snapshotFingerprint &&
    attempt.attemptId === reservation.attemptId &&
    attempt.slotRevision === reservation.slotRevision &&
    attempt.reservedAt === reservation.reservedAt &&
    attempt.sendBeforeAt === new Date(reservation.sendBeforeMs).toISOString() &&
    slot.shopId === job.shopId && slot.requestId === job.requestId &&
    slot.attemptId === reservation.attemptId &&
    slot.revision === reservation.slotRevision &&
    slot.lastStartedAt === reservation.reservedAt &&
    slot.sendBeforeAt === attempt.sendBeforeAt &&
    validClock(Date.parse(slot.nextEligibleAt)) &&
    Date.parse(slot.nextEligibleAt) - reservation.sendBeforeMs >= 30_000;
}

/** One fixed-destination JSON request. Never follows a redirect or retries. */
async function postGraphql(ports: ObservedDraftWritePorts, clock: () => number,
  operationName: string, query: string, variables?: RecordValue,
  sendBeforeMs?: number):
  Promise<{ status: number; data: RecordValue | null } | null> {
  const now = clock();
  if (!validClock(now) || sendBeforeMs !== undefined && now >= sendBeforeMs ||
      ports.cookieExpiresAtMs !== null &&
      ports.cookieExpiresAtMs <= now) return { status: 401, data: null };
  try {
    const response = await ports.fetchPort(GRAPHQL_URL, {
      method: "POST", redirect: "manual", cache: "no-store",
      credentials: "omit", signal: AbortSignal.timeout(10_000),
      headers: { "Content-Type": "application/json", Accept: "application/json",
        Origin: "https://mercari-shops.com", Cookie: ports.cookieHeader },
      body: JSON.stringify({ operationName, query,
        ...(variables ? { variables } : {}) }),
    });
    if (response.redirected || response.status >= 300 &&
        response.status < 400) return null;
    if (response.status === 401 || response.status === 403)
      return { status: response.status, data: null };
    const body: unknown = await response.json();
    if (!object(body)) return { status: response.status, data: null };
    if (Array.isArray(body.errors) && body.errors.some(error =>
        object(error) && object(error.extensions) &&
        typeof error.extensions.code === "string" &&
        ["UNAUTHENTICATED", "FORBIDDEN"].includes(
          error.extensions.code)))
      return { status: 401, data: null };
    if ("errors" in body || !object(body.data))
      return { status: response.status, data: null };
    return { status: response.status, data: body.data };
  } catch { return null; }
}

/**
 * Prepared but intentionally unwired to routes/actions. An asset verifier,
 * input mapper and duplicate reader do not yet exist in production.
 */
export async function executeObservedDraftWriteOnce(
  job: WebHttpDraftJob, reservation: WebHttpSendReservationResult,
  mutation: Mutation, assetProof: AssetProof | null,
  mappingProof: MappingProof | null, ports: ObservedDraftWritePorts,
  clock: () => number = Date.now,
): Promise<ObservedDraftWriteResult> {
  if (!initialWebHttpExecutionState(job) ||
      job.inventoryId.toLowerCase() === B005396_INVENTORY_ID)
    return result("INVALID_JOB_NO_SEND");
  if (!mutation || mutation.kind !== "CREATE" &&
      mutation.kind !== "UPDATE")
    return result("MAPPING_UNVERIFIED_NO_SEND");
  if (!ports || !ports.repository ||
      typeof ports.repository.claimMutationStart !== "function" ||
      typeof ports.fetchPort !== "function" ||
      typeof ports.readCurrentInventory !== "function" ||
      typeof ports.hasExistingBinding !== "function" ||
      typeof ports.duplicatePreflight !== "function" || !ports.readback ||
      typeof ports.cookieHeader !== "string" ||
      ports.cookieHeader.length < 1 || ports.cookieHeader.length > 32_768 ||
      /[\r\n\0]/.test(ports.cookieHeader) ||
      ports.cookieExpiresAtMs === null ||
      !validClock(ports.cookieExpiresAtMs))
    return result("AUTH_REQUIRED_NO_SEND");
  const now = clock();
  if (!validClock(now)) return result("RESERVATION_UNVERIFIED_NO_SEND");
  let attempt: WebHttpSendAttempt | null;
  let slot: WebHttpShopSendSlot | null;
  try {
    attempt = await ports.repository.getAttempt(job.requestId);
    slot = await ports.repository.getSlot(job.shopId);
  } catch { return result("RESERVATION_UNVERIFIED_NO_SEND"); }
  if (!validStoredClaim(job, reservation, attempt, slot, now))
    return result("RESERVATION_UNVERIFIED_NO_SEND");
  let inventory: { id: string; sku: string } | null;
  try { inventory = await ports.readCurrentInventory(job.inventoryId); }
  catch { inventory = null; }
  const frozenCode = frozenSourceCode(job);
  if (!inventory || typeof inventory.id !== "string" ||
      inventory.id.toLowerCase() !== job.inventoryId.toLowerCase() ||
      typeof inventory.sku !== "string" || !frozenCode ||
      inventory.sku !== frozenCode || inventory.sku === "B005396" ||
      job.managementCode !==
        `BELLO_${inventory.id.replace(/-/g, "").toUpperCase()}`)
    return result("INVENTORY_MISMATCH_NO_SEND");
  if (!assetProof || assetProof.status !== "VERIFIED_SAME_IMAGE_BYTES" ||
      assetProof.shopId !== job.shopId ||
      assetProof.inventoryId !== job.inventoryId ||
      assetProof.snapshotFingerprint !== job.snapshotFingerprint ||
      assetProof.imageRefCount !== 1 ||
      typeof assetProof.remoteAssetId !== "string" ||
      !DRAFT_ID.test(assetProof.remoteAssetId))
    return result("ASSET_UNVERIFIED_NO_SEND");
  if (!mappingProof ||
      mappingProof.status !== "OBSERVED_INPUT_MAPPING_VERIFIED" ||
      mappingProof.snapshotFingerprint !== job.snapshotFingerprint ||
      !validPayload(job, mutation, assetProof.remoteAssetId))
    return result("MAPPING_UNVERIFIED_NO_SEND");
  if (mutation.kind === "UPDATE" &&
      (!mutation.targetDraftProof ||
        mutation.targetDraftProof.status !== "VERIFIED_SAME_JOB_DRAFT" ||
        mutation.targetDraftProof.shopId !== job.shopId ||
        mutation.targetDraftProof.inventoryId !== job.inventoryId ||
        mutation.targetDraftProof.snapshotFingerprint !==
          job.snapshotFingerprint ||
        mutation.targetDraftProof.draftId !== mutation.input.id))
    return result("MAPPING_UNVERIFIED_NO_SEND");
  let existing: boolean | null;
  try { existing = await ports.hasExistingBinding(job); }
  catch { existing = null; }
  if (existing !== false)
    return result("DUPLICATE_OR_READ_UNVERIFIED_NO_SEND");
  const shop = await postGraphql(ports, clock, "OwnShops", SHOP_QUERY);
  if (shop?.status === 401 || shop?.status === 403)
    return result("AUTH_REQUIRED_NO_SEND");
  if (shop?.status !== 200 || !Array.isArray(shop.data?.ownShops) ||
      !shop.data.ownShops.some(value =>
        object(value) && value.id === job.shopId))
    return result("SHOP_UNVERIFIED_NO_SEND");
  let duplicate: Awaited<ReturnType<DuplicatePreflight>>;
  try { duplicate = await ports.duplicatePreflight(job,
    mutation.kind === "UPDATE" ? mutation.input.id as string : null); }
  catch { duplicate = "UNKNOWN"; }
  if (duplicate === "AUTH_REQUIRED") return result("AUTH_REQUIRED_NO_SEND");
  if (mutation.kind === "CREATE" && duplicate !== "ABSENT_COMPLETE" ||
      mutation.kind === "UPDATE" &&
        (!object(duplicate) ||
          duplicate.status !== "TARGET_ONLY_COMPLETE" ||
          duplicate.draftId !== mutation.input.id))
    return result("DUPLICATE_OR_READ_UNVERIFIED_NO_SEND");
  try {
    attempt = await ports.repository.getAttempt(job.requestId);
    slot = await ports.repository.getSlot(job.shopId);
  } catch { return result("RESERVATION_UNVERIFIED_NO_SEND"); }
  if (!validStoredClaim(job, reservation, attempt, slot, clock()) ||
      ports.cookieExpiresAtMs !== null &&
        ports.cookieExpiresAtMs <= clock())
    return result("RESERVATION_UNVERIFIED_NO_SEND");
  if (!reservation.ok) return result("RESERVATION_UNVERIFIED_NO_SEND");
  const claimedAt = clock();
  if (!webHttpSendPermitFresh(reservation, claimedAt))
    return result("RESERVATION_UNVERIFIED_NO_SEND");
  try {
    await ports.repository.claimMutationStart(job.requestId,
      reservation.attemptId, new Date(claimedAt).toISOString());
  } catch { return result("RESERVATION_UNVERIFIED_NO_SEND"); }
  if (!webHttpSendPermitFresh(reservation, clock())) {
    const readback = await reconcileReservedWebHttpDraft(job,
      ports.repository, ports.readback);
    return result("RESULT_UNKNOWN_NO_RESEND", null, readback.status);
  }
  const operationName = mutation.kind === "CREATE" ?
    "CreateProductDraft" : "UpdateProductDraft";
  const query = mutation.kind === "CREATE" ? CREATE_QUERY : UPDATE_QUERY;
  const variables = mutation.kind === "CREATE" ?
    { input: mutation.input,
      idempotencyKeySeed: mutation.idempotencyKeySeed } :
    { input: mutation.input };
  const sent = await postGraphql(ports, clock, operationName, query,
    variables, reservation.sendBeforeMs);
  if (sent?.status === 401 || sent?.status === 403)
    return result("AUTH_REQUIRED_NO_RESEND");
  const responseKey = mutation.kind === "CREATE" ?
    "createProductDraft" : "updateProductDraft";
  const item = sent?.data?.[responseKey];
  if (sent?.status === 200 && object(item) &&
      typeof item.id === "string" && DRAFT_ID.test(item.id) &&
      (mutation.kind === "CREATE" || item.id === mutation.input.id))
    return result(mutation.kind === "CREATE" ?
      "CREATE_ACKNOWLEDGED_NEEDS_UPDATE" :
      "UPDATE_ACKNOWLEDGED_NEEDS_READBACK", item.id);
  const readback = await reconcileReservedWebHttpDraft(job,
    ports.repository, ports.readback);
  return result("RESULT_UNKNOWN_NO_RESEND", null, readback.status);
}
