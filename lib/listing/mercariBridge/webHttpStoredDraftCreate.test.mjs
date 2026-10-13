import test from "node:test";
import assert from "node:assert/strict";
import { buildWebHttpDraftJob } from "./webHttpDraftJob.ts";
import { createStoredWebHttpDraftOnce } from "./webHttpStoredDraftCreate.ts";

const inventoryId = "7ad79e0c-3b49-49a2-9a4b-f379863028e1";
const shopId = "evkhihBFFNn5hukMS9s36H";
const owner = "admin@example.com";
const now = 100_000;
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
const image = { status: "VERIFIED_SAME_IMAGE_BYTES", shopId,
  inventoryId, snapshotFingerprint: job.snapshotFingerprint,
  remoteAssetId: "Asset123456", imageRefCount: 1,
  sourceImageSha256: "a".repeat(64) };
const selected = { status: "HUMAN_VERIFIED_SHOPS_SELECTION", shopId,
  snapshotFingerprint: job.snapshotFingerprint,
  categoryId: pack.categoryId, categoryPath: pack.categoryPath,
  belloConditionCode: pack.condition, shopsConditionEnum: "CONDITION_CLEAN",
  adminPriceYen: pack.priceYen, adminQuantity: 1,
  countryRestrictionTemplateId: "verified-country-template",
  channelListingScope: "verified-scope", variantDefaultsVerified: true };
const seed = { status: "VERIFIED_OBSERVED_SEED_STRATEGY",
  snapshotFingerprint: job.snapshotFingerprint, value: 12345 };
const contract = { status: "VERIFIED_OBSERVED_CREATE_CONTRACT",
  requestId: job.requestId, snapshotFingerprint: job.snapshotFingerprint };

function scenario({ imageProof = image, seedProof = seed,
  contractProof = contract, sessionAvailable = true,
  duplicate = "ABSENT_COMPLETE", stock = inventory } = {}) {
  let slot = null, attempt = null, claimed = 0;
  const calls = [];
  const sendRepository = {
    getSlot: async () => slot, getAttempt: async () => attempt,
    transactReserve: async (_previous, next, item) => {
      slot = next; attempt = item;
    },
    claimMutationStart: async (id, attemptId) => {
      if (attempt?.requestId !== id || attempt.attemptId !== attemptId ||
          attempt.status !== "RESERVED_NO_SEND") throw Error("claimed");
      claimed++; attempt.status = "SEND_CLAIMED_RESULT_UNKNOWN";
    },
    acknowledgeDraftMutation: async (id, attemptId, kind, remoteId) => {
      if (attempt?.requestId !== id || attempt.attemptId !== attemptId ||
          attempt.status !== "SEND_CLAIMED_RESULT_UNKNOWN")
        throw Error("not claimed");
      attempt.status = "DRAFT_ACKNOWLEDGED";
      attempt.draftMutationKind = kind;
      attempt.remoteDraftId = remoteId;
    },
  };
  const readback = { verifyTargetShop: async () =>
    ({ status: "VERIFIED", shopMatched: true }),
    listDraftCandidates: async () => ({ status: "OK", complete: true,
      candidates: [] }) };
  const fetchPort = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.operationName);
    return Response.json({ data: body.operationName === "OwnShops" ?
      { ownShops: [{ id: shopId }] } :
      { createProductDraft: { id: "Draft123456" } } });
  };
  const ports = {
    jobRepository: { getJob: async () => job },
    source: { readInventory: async () => stock,
      readSavedDraft: async () => draft,
      readSelectedCategory: async () => ({
        categoryId: pack.categoryId, fullPath: pack.categoryPath }),
      hasExistingBinding: async () => false,
      hasExistingChannelListing: async () => false,
      readCurrentImageSha256: async () => image.sourceImageSha256 },
    sendRepository,
    readVerifiedImage: async () => imageProof,
    readVerifiedSelection: async () => selected,
    readVerifiedSeed: async () => seedProof,
    readVerifiedContract: async () => contractProof,
    openVerifiedSession: async () => sessionAvailable ? {
      status: "VERIFIED_RECENT_HUMAN_AUTH", requestId: job.requestId,
      shopId, snapshotFingerprint: job.snapshotFingerprint,
      verifiedAtMs: now, cookieHeader: "id_token=secret",
      cookieExpiresAtMs: now + 60_000, fetchPort,
      duplicatePreflight: async () => duplicate,
      reverifyAuth: async () => ({ status: "VALID", verifiedAtMs: now }),
      readback,
    } : null,
  };
  return { ports, calls, claimed: () => claimed };
}
const run = state => createStoredWebHttpDraftOnce(job.requestId,
  owner, state.ports, () => now);

test("proved HTTPS draft create is one attempt and never claims publication", async () => {
  const state = scenario();
  const first = await run(state);
  assert.equal(first.status, "WRITE_ATTEMPT_FINISHED");
  assert.equal(first.writeResult.status, "CREATE_ACKNOWLEDGED_NEEDS_UPDATE");
  assert.equal(first.allowPublish, false);
  assert.equal(first.listingConfirmed, false);
  assert.deepEqual(state.calls, ["OwnShops", "CreateProductDraft"]);
  assert.equal(state.claimed(), 1);
  assert.equal((await run(state)).status, "RESERVATION_BLOCKED_NO_SEND");
  assert.deepEqual(state.calls, ["OwnShops", "CreateProductDraft"]);
});

test("missing proof, stale inventory or duplicate never creates", async () => {
  for (const options of [
    { imageProof: null }, { seedProof: null }, { contractProof: null },
    { sessionAvailable: false }, { duplicate: "FOUND" },
    { stock: { ...inventory, saleEndDate: "2026-10-01" } },
  ]) {
    const state = scenario(options);
    assert.notEqual((await run(state)).status, "WRITE_ATTEMPT_FINISHED");
    assert.equal(state.claimed(), 0);
    assert.deepEqual(state.calls, []);
  }
});
