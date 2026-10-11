import test from "node:test";
import assert from "node:assert/strict";
import { buildWebHttpDraftJob } from "./webHttpDraftJob.ts";
import { updateStoredWebHttpDraftOnce } from
  "./webHttpStoredDraftUpdate.ts";

const inventoryId = "7ad79e0c-3b49-49a2-9a4b-f379863028e1";
const shopId = "evkhihBFFNn5hukMS9s36H";
const remoteDraftId = "2JXsGZ7vdfvq7bwbM7dAw9";
const owner = "admin@example.com";
const now = 100_000;
const sha256 = "a".repeat(64);
const shipping = { method: "METHOD_TYPE_UNDECIDED",
  payer: "PAYER_TYPE_SELLER", origin: "jp11",
  duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" };
const pack = { schemaVersion: 1, kind: "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK",
  shopId, inventoryId, draftId: "5011916b-65af-4b73-89e5-00b9474a4e8a",
  draftUpdatedAt: "2026-10-08T01:02:03.000Z", title: "Fixture sofa",
  description: "Fixture description", condition: "NO_NOTABLE_DAMAGE",
  imageRefs: [{ source: "INVENTORY", storageKey: "inventory/front.jpg",
    sortOrder: 0, photoAssetId: null }], priceYen: 99999, quantity: 1,
  categoryId: "furniture_sofa", categoryPath: "家具・インテリア > ソファ",
  brandId: null, brandName: null,
  managementCode: "BELLO_7AD79E0C3B4949A29A4BF379863028E1",
  shipping, status: "PREPARED_NO_SEND" };
const evidence = { sourceInventoryCode: "B009990", sourcePriceYen: 50000,
  sourceQuantity: 1, sourceShippingMethod: "KAZAI", selectedQuantity: 1,
  selectedCategoryId: pack.categoryId, selectedCategoryPath: pack.categoryPath,
  categoryEvidence: "ADMIN_SELECTED_MASTER", shopsShipping: shipping,
  imageCount: 1, imageEvidence: "SAVED_REFERENCES_ONLY",
  shippingReviewRequired: true, status: "REVIEW_REQUIRED_NO_SEND" };
const job = buildWebHttpDraftJob(pack, evidence, owner);
const inventory = { id: inventoryId, sku: "B009990", quantity: 1,
  categoryName: "ソファ", market: null, saleEndDate: null };
const draft = { id: pack.draftId, inventoryId, title: pack.title,
  description: pack.description, price: evidence.sourcePriceYen,
  condition: pack.condition, shippingMethod: "KAZAI",
  images: pack.imageRefs, createdBy: null, updatedBy: null,
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: pack.draftUpdatedAt };
const target = { status: "VERIFIED_SAME_JOB_DRAFT",
  requestId: job.requestId, shopId, inventoryId,
  snapshotFingerprint: job.snapshotFingerprint, draftId: remoteDraftId };
const image = { status: "VERIFIED_SAME_IMAGE_BYTES", shopId,
  inventoryId, snapshotFingerprint: job.snapshotFingerprint,
  remoteAssetId: "Asset123456", imageRefCount: 1,
  sourceImageSha256: sha256 };
const selected = { status: "HUMAN_VERIFIED_SHOPS_SELECTION", shopId,
  snapshotFingerprint: job.snapshotFingerprint,
  categoryId: pack.categoryId, categoryPath: pack.categoryPath,
  belloConditionCode: pack.condition, shopsConditionEnum: "CONDITION_CLEAN",
  adminPriceYen: pack.priceYen, adminQuantity: 1,
  countryRestrictionTemplateId: "verified-country-template",
  channelListingScope: "verified-scope", variantDefaultsVerified: true };
const contract = { status: "VERIFIED_OBSERVED_UPDATE_CONTRACT",
  requestId: job.requestId, snapshotFingerprint: job.snapshotFingerprint,
  targetDraftId: remoteDraftId };

function scenario({ current = inventory, duplicate = {
  status: "TARGET_ONLY_COMPLETE", draftId: remoteDraftId },
  writeStatus = 200, sessionAvailable = true,
  targetProof = target, imageProof = image, contractProof = contract,
  previousSlot = null, duplicateDelayMs = 0,
  reverifyStatuses = ["VALID", "VALID"], staleReverify = false } = {}) {
  let slot = previousSlot;
  let attempt = null;
  let claimed = 0;
  let opened = 0;
  let readbacks = 0;
  let currentMs = now;
  let reverifyCount = 0;
  const calls = [];
  const sendRepository = {
    getSlot: async () => slot,
    getAttempt: async () => attempt,
    transactReserve: async (_prior, next, item) => {
      slot = { ...next }; attempt = { ...item };
    },
    claimMutationStart: async (requestId, attemptId) => {
      if (attempt?.requestId !== requestId ||
          attempt.attemptId !== attemptId ||
          attempt.status !== "RESERVED_NO_SEND")
        throw Error("claimed");
      claimed++;
      attempt.status = "SEND_CLAIMED_RESULT_UNKNOWN";
    },
  };
  const fetchPort = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.operationName);
    if (body.operationName === "OwnShops")
      return Response.json({ data: { ownShops: [{ id: shopId }] } });
    if (writeStatus === 302)
      return new Response(null, { status: 302,
        headers: { location: "https://example.net/redirect" } });
    return Response.json({ data: { updateProductDraft: {
      id: remoteDraftId } } });
  };
  const readback = {
    verifyTargetShop: async () => { readbacks++;
      return { status: "VERIFIED", shopMatched: true }; },
    listDraftCandidates: async () => ({ status: "OK", complete: true,
      candidates: [{ id: remoteDraftId, shopId,
        name: pack.title, description: pack.description,
        price: pack.priceYen, quantity: 1,
        skuCode: pack.managementCode, thumbnailCount: 1 }] }),
  };
  const ports = {
    jobRepository: { getJob: async () => job },
    source: { readInventory: async () => current,
      readSavedDraft: async () => draft,
      readSelectedCategory: async () => ({
        categoryId: pack.categoryId, fullPath: pack.categoryPath }),
      hasExistingBinding: async () => false,
      hasExistingChannelListing: async () => false,
      readCurrentImageSha256: async () => sha256 },
    sendRepository,
    readVerifiedTarget: async () => targetProof,
    readVerifiedImage: async () => imageProof,
    readVerifiedSelection: async () => selected,
    readVerifiedContract: async () => contractProof,
    openVerifiedSession: async () => {
      opened++;
      return sessionAvailable ? {
        status: "VERIFIED_RECENT_HUMAN_AUTH",
        requestId: job.requestId, shopId,
        snapshotFingerprint: job.snapshotFingerprint,
        verifiedAtMs: now, cookieHeader: "id_token=secret",
        cookieExpiresAtMs: now + 60_000, fetchPort,
        duplicatePreflight: async () => {
          currentMs += duplicateDelayMs;
          return duplicate;
        },
        reverifyAuth: async () => ({
          status: reverifyStatuses[reverifyCount++] ?? "VALID",
          verifiedAtMs: staleReverify ? now : currentMs,
        }),
        readback,
      } : null;
    },
  };
  return { ports, calls, claimed: () => claimed,
    opened: () => opened, readbacks: () => readbacks,
    clock: () => currentMs, reverifyCount: () => reverifyCount };
}
const run = state => updateStoredWebHttpDraftOnce(job.requestId,
  owner, state.ports, state.clock);

test("stored preparation can only pass a proved existing draft update", async () => {
  const state = scenario();
  const output = await run(state);
  assert.equal(output.status, "WRITE_ATTEMPT_FINISHED");
  assert.equal(output.writeResult.status,
    "UPDATE_ACKNOWLEDGED_NEEDS_READBACK");
  assert.equal(output.allowCreate, false);
  assert.equal(output.allowPublish, false);
  assert.equal(output.listingConfirmed, false);
  assert.deepEqual(state.calls, ["OwnShops", "UpdateProductDraft"]);
  assert.equal(state.claimed(), 1);
  const second = await run(state);
  assert.equal(second.status, "RESERVATION_BLOCKED_NO_SEND");
  assert.equal(second.detail, "ALREADY_CLAIMED_NO_SEND");
  assert.deepEqual(state.calls, ["OwnShops", "UpdateProductDraft"]);
});

test("missing durable image, target, contract or auth never reserves or sends", async () => {
  for (const options of [
    { targetProof: null }, { imageProof: null },
    { contractProof: null }, { sessionAvailable: false },
    { targetProof: { ...target, requestId: "b".repeat(64) } },
  ]) {
    const state = scenario(options);
    const output = await run(state);
    assert.match(output.status,
      /^(EVIDENCE_MISSING|AUTH_UNVERIFIED)_NO_SEND$/);
    assert.equal(state.claimed(), 0);
    assert.equal(state.calls.length, 0);
  }
});

test("31-second duplicate scan cannot reuse an old auth proof", async () => {
  for (const options of [
    { duplicateDelayMs: 31_000, staleReverify: true },
    { duplicateDelayMs: 31_000,
      reverifyStatuses: ["AUTH_REQUIRED"] },
  ]) {
    const state = scenario(options);
    const output = await run(state);
    assert.equal(output.status, "AUTH_UNVERIFIED_NO_SEND");
    assert.equal(state.reverifyCount(), 1);
    assert.equal(state.claimed(), 0);
    assert.equal(state.calls.length, 0);
  }
});

test("auth becoming unknown just before update stops after reservation", async () => {
  const state = scenario({ reverifyStatuses: ["VALID", "UNKNOWN"] });
  const output = await run(state);
  assert.equal(output.status, "WRITE_ATTEMPT_FINISHED");
  assert.equal(output.writeResult.status, "AUTH_UNVERIFIED_NO_SEND");
  assert.equal(state.reverifyCount(), 2);
  assert.equal(state.claimed(), 0);
  assert.deepEqual(state.calls, ["OwnShops"]);
});

test("sold inventory and duplicate target ambiguity stop before reservation", async () => {
  for (const options of [
    { current: { ...inventory, saleEndDate: "2026-09-15" } },
    { current: { ...inventory, categoryName: "発送完了" } },
    { current: { ...inventory, market: "メルカリSHOP" } },
    { duplicate: "FOUND" },
  ]) {
    const state = scenario(options);
    const output = await run(state);
    assert.equal(output.status, "SOURCE_OR_TARGET_UNVERIFIED_NO_SEND");
    assert.equal(state.claimed(), 0);
    assert.equal(state.calls.length, 0);
  }
});

test("shop-wide 30-second slot prevents a second product mutation", async () => {
  const previousSlot = { shopId, revision: 1,
    lastStartedAt: new Date(now - 5_000).toISOString(),
    sendBeforeAt: new Date(now - 1_000).toISOString(),
    nextEligibleAt: new Date(now + 30_000).toISOString(),
    requestId: "b".repeat(64),
    attemptId: "7444d0d8-4795-4448-b2cc-d731638462d5",
    requestedBy: owner };
  const state = scenario({ previousSlot });
  const output = await run(state);
  assert.equal(output.status, "RESERVATION_BLOCKED_NO_SEND");
  assert.equal(output.detail, "WAIT_INTERVAL");
  assert.equal(state.claimed(), 0);
  assert.equal(state.calls.length, 0);
});

test("unknown update response is reconciled once and never resent", async () => {
  const state = scenario({ writeStatus: 302 });
  const output = await run(state);
  assert.equal(output.writeResult.status, "RESULT_UNKNOWN_NO_RESEND");
  assert.equal(output.writeResult.readbackStatus,
    "MATCHING_DRAFT_OBSERVED_NO_RESEND");
  assert.equal(state.readbacks(), 1);
  assert.equal(state.claimed(), 1);
  await run(state);
  assert.equal(state.claimed(), 1);
  assert.deepEqual(state.calls, ["OwnShops", "UpdateProductDraft"]);
});
