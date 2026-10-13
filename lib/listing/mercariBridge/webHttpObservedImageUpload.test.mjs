import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildWebHttpDraftJob } from "./webHttpDraftJob.ts";
import { executeObservedImageUploadOnce } from
  "./webHttpObservedImageUpload.ts";
import { reserveWebHttpSendStart } from "./webHttpSendReservation.ts";

const inventoryId = "1fa6d72b-306f-4af8-bfc8-a4bd4435eb33";
const shipping = { method: "METHOD_TYPE_UNDECIDED",
  payer: "PAYER_TYPE_SELLER", origin: "jp11",
  duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" };
const pack = { schemaVersion: 1,
  kind: "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK",
  shopId: "evkhihBFFNn5hukMS9s36H", inventoryId,
  draftId: "0d76fb56-41f8-4dd3-ae18-a660a5e97ae1",
  draftUpdatedAt: "2026-10-08T01:02:03.000Z", title: "Fixture sofa",
  description: "Fixture description", condition: "NO_NOTABLE_DAMAGE",
  imageRefs: [{ source: "INVENTORY", storageKey: "inventory/front.jpg",
    sortOrder: 0, photoAssetId: null }], priceYen: 46900, quantity: 1,
  categoryId: "furniture_sofa", categoryPath: "家具・インテリア > ソファ",
  brandId: null, brandName: null,
  managementCode: `BELLO_${inventoryId.replaceAll("-", "").toUpperCase()}`,
  shipping, status: "PREPARED_NO_SEND" };
const evidence = { sourceInventoryCode: "B009001", sourcePriceYen: 45000,
  sourceQuantity: 1, sourceShippingMethod: "SAGAWA", selectedQuantity: 1,
  selectedCategoryId: pack.categoryId, selectedCategoryPath: pack.categoryPath,
  categoryEvidence: "ADMIN_SELECTED_MASTER", shopsShipping: shipping,
  imageCount: 1, imageEvidence: "SAVED_REFERENCES_ONLY",
  shippingReviewRequired: true, status: "REVIEW_REQUIRED_NO_SEND" };
const job = buildWebHttpDraftJob(pack, evidence, "admin@example.com");
const bytes = Uint8Array.from([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]);
const sha = createHash("sha256").update(bytes).digest("hex");
const prepared = { originalSha256: "a".repeat(64),
  preparedJpegSha256: sha, preparedJpegBytes: bytes };
const proof = { snapshotFingerprint: job.snapshotFingerprint,
  inventoryId, storageKey: "inventory/front.jpg",
  originalSha256: prepared.originalSha256,
  preparedJpegSha256: prepared.preparedJpegSha256 };
const stage = { kind: "IMAGE_UPLOAD", preparedJpegSha256: sha };
const attemptId = "fef2b7ee-cf21-429f-99bf-9439eafab3af";
const now = 100_000;

async function setup(responseBody, responseStatus = 200) {
  let slot = null;
  const attempts = new Map();
  let sends = 0;
  const repo = {
    getSlot: async () => slot,
    getAttempt: async key => attempts.get(key) ?? null,
    transactReserve: async (_previous, next, attempt) => {
      if (slot || attempts.has(attempt.requestId)) throw Error("duplicate");
      slot = next;
      attempts.set(attempt.requestId, attempt);
    },
    claimMutationStart: async (key, id) => {
      const attempt = attempts.get(key);
      if (attempt?.status !== "RESERVED_NO_SEND" ||
          attempt.attemptId !== id) throw Error("already claimed");
      attempt.status = "SEND_CLAIMED_RESULT_UNKNOWN";
    },
    acknowledgeImageAsset: async (key, id, remoteAssetId, digest) => {
      const attempt = attempts.get(key);
      if (attempt?.status !== "SEND_CLAIMED_RESULT_UNKNOWN" ||
          attempt.attemptId !== id) throw Error("not claimed");
      attempt.status = "IMAGE_ACKNOWLEDGED";
      attempt.remoteAssetId = remoteAssetId;
      attempt.preparedJpegSha256 = digest;
    },
  };
  const reservation = await reserveWebHttpSendStart(job, {
    auth: "VALID", userReauthenticatedByHuman: true,
    writeContractVerified: true, remoteDuplicate: "ABSENT",
    existingBinding: false,
  }, attemptId, repo, () => now, stage);
  assert.equal(reservation.ok, true);
  const ports = { cookieHeader: "session=fake-test-only",
    cookieExpiresAtMs: now + 60_000, repository: repo,
    verifyCurrentJob: async () => true,
    verifyAuthFresh: async () => ({ status: "VALID",
      shopId: job.shopId, verifiedAtMs: now }),
    fetchPort: async (url, init) => {
      sends++;
      assert.equal(url, "https://mercari-shops.com/graphql");
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "manual");
      assert.equal(init.headers["Content-Type"], undefined);
      assert.ok(init.body instanceof FormData);
      return new Response(JSON.stringify(responseBody),
        { status: responseStatus });
    },
  };
  return { repo, ports, reservation, attempts, sends: () => sends };
}

test("one HTTPS upload persists its asset before exposing proof", async () => {
  const ctx = await setup({ data: { createImageAsset: {
    id: "asset_123", contentType: "image/jpeg" } } });
  const first = await executeObservedImageUploadOnce(job, ctx.reservation,
    prepared, proof, ctx.ports, () => now);
  assert.equal(first.status, "ASSET_ACKNOWLEDGED");
  assert.equal(first.assetProof.remoteAssetId, "asset_123");
  assert.equal(ctx.attempts.get(ctx.reservation.requestId).status,
    "IMAGE_ACKNOWLEDGED");
  assert.equal(ctx.sends(), 1);
  const second = await executeObservedImageUploadOnce(job, ctx.reservation,
    prepared, proof, ctx.ports, () => now);
  assert.equal(second.status, "RESERVATION_UNVERIFIED_NO_SEND");
  assert.equal(ctx.sends(), 1);
});

test("wrong source and expired auth do not send", async () => {
  const ctx = await setup({});
  const wrong = await executeObservedImageUploadOnce(job, ctx.reservation,
    prepared, { ...proof, storageKey: "other.jpg" }, ctx.ports,
    () => now);
  assert.equal(wrong.status, "SOURCE_UNVERIFIED_NO_SEND");
  ctx.ports.verifyAuthFresh = async () => ({ status: "AUTH_REQUIRED",
    shopId: null, verifiedAtMs: null });
  const expired = await executeObservedImageUploadOnce(job, ctx.reservation,
    prepared, proof, ctx.ports, () => now);
  assert.equal(expired.status, "AUTH_REQUIRED_NO_SEND");
  assert.equal(ctx.sends(), 0);
});

test("image removed after the claim stops the upload without a resend", async () => {
  const ctx = await setup({ data: { createImageAsset: {
    id: "asset_123", contentType: "image/jpeg" } } });
  let currentReads = 0;
  ctx.ports.verifyCurrentJob = async () => ++currentReads === 1;
  const first = await executeObservedImageUploadOnce(job, ctx.reservation,
    prepared, proof, ctx.ports, () => now);
  assert.equal(first.status, "RESULT_UNKNOWN_NO_RESEND");
  assert.equal(currentReads, 2);
  assert.equal(ctx.sends(), 0);
  assert.equal(ctx.attempts.get(ctx.reservation.requestId).status,
    "SEND_CLAIMED_RESULT_UNKNOWN");
  const second = await executeObservedImageUploadOnce(job, ctx.reservation,
    prepared, proof, ctx.ports, () => now);
  assert.equal(second.status, "INVENTORY_UNVERIFIED_NO_SEND");
  assert.equal(ctx.sends(), 0);
});

test("GraphQL auth failure after claim never resends", async () => {
  const ctx = await setup({ errors: [{ extensions: {
    code: "UNAUTHENTICATED" } }] });
  const first = await executeObservedImageUploadOnce(job, ctx.reservation,
    prepared, proof, ctx.ports, () => now);
  assert.equal(first.status, "AUTH_REQUIRED_NO_RESEND");
  assert.equal(first.assetProof, null);
  assert.equal(ctx.attempts.get(ctx.reservation.requestId).status,
    "SEND_CLAIMED_RESULT_UNKNOWN");
  assert.equal((await executeObservedImageUploadOnce(job, ctx.reservation,
    prepared, proof, ctx.ports, () => now)).status,
  "RESERVATION_UNVERIFIED_NO_SEND");
  assert.equal(ctx.sends(), 1);
});

test("malformed acknowledgement stays unknown and is never replayed", async () => {
  const ctx = await setup({ data: { createImageAsset: {
    id: "bad/id", contentType: "image/jpeg" } } });
  assert.equal((await executeObservedImageUploadOnce(job, ctx.reservation,
    prepared, proof, ctx.ports, () => now)).status,
  "RESULT_UNKNOWN_NO_RESEND");
  assert.equal(ctx.sends(), 1);
});

test("a lost acknowledgement response cannot become a second upload", async () => {
  const ctx = await setup({ data: { createImageAsset: {
    id: "asset_456", contentType: "image/jpeg" } } });
  const persist = ctx.repo.acknowledgeImageAsset;
  ctx.repo.acknowledgeImageAsset = async (...args) => {
    await persist(...args);
    throw Error("database response lost after commit");
  };
  const first = await executeObservedImageUploadOnce(job, ctx.reservation,
    prepared, proof, ctx.ports, () => now);
  assert.equal(first.status, "RESULT_UNKNOWN_NO_RESEND");
  assert.equal(first.assetProof, null);
  assert.equal((await executeObservedImageUploadOnce(job, ctx.reservation,
    prepared, proof, ctx.ports, () => now)).status,
  "RESERVATION_UNVERIFIED_NO_SEND");
  assert.equal(ctx.sends(), 1);
});
