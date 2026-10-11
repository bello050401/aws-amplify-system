import test from "node:test";
import assert from "node:assert/strict";
import { buildWebHttpDraftJob } from "./webHttpDraftJob.ts";
import { reconcileReservedWebHttpDraft } from
  "./webHttpDraftSaveReconciliation.ts";

const inventoryId = "8f5c2a66-790a-4a35-8896-424b67a0be40";
const shopId = "evkhihBFFNn5hukMS9s36H";
const shipping = { method: "METHOD_TYPE_UNDECIDED", payer: "PAYER_TYPE_SELLER",
  origin: "jp11", duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" };
const pack = { schemaVersion: 1, kind: "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK",
  shopId, inventoryId, draftId: "4771cabe-f2d5-4e5c-93c9-61d67264a2c8",
  draftUpdatedAt: "2026-10-08T01:02:03.000Z", title: "Fixture sofa",
  description: "Fixture description", condition: "NO_NOTABLE_DAMAGE",
  imageRefs: [{ source: "INVENTORY", storageKey: "inventory/front.jpg",
    sortOrder: 0, photoAssetId: null }], priceYen: 99999, quantity: 1,
  categoryId: "furniture_sofa", categoryPath: "家具・インテリア > ソファ",
  brandId: null, brandName: null,
  managementCode: "BELLO_8F5C2A66790A4A358896424B67A0BE40",
  shipping, status: "PREPARED_NO_SEND" };
const evidence = { sourceInventoryCode: "B009999", sourcePriceYen: 50000,
  sourceQuantity: 1, sourceShippingMethod: "KAZAI", selectedQuantity: 1,
  selectedCategoryId: pack.categoryId, selectedCategoryPath: pack.categoryPath,
  categoryEvidence: "ADMIN_SELECTED_MASTER", shopsShipping: shipping,
  imageCount: 1, imageEvidence: "SAVED_REFERENCES_ONLY",
  shippingReviewRequired: true, status: "REVIEW_REQUIRED_NO_SEND" };
const job = buildWebHttpDraftJob(pack, evidence, "admin@example.com");
const attempt = { requestId: job.requestId, inventoryId, shopId,
  snapshotFingerprint: job.snapshotFingerprint,
  attemptId: "7444d0d8-4795-4448-b2cc-d731638462d5", slotRevision: 1,
  reservedAt: "2026-10-11T01:00:00.000Z",
  sendBeforeAt: "2026-10-11T01:00:04.000Z",
  requestedBy: job.requestedBy, status: "RESERVED_NO_SEND" };
const candidate = { id: "2JXsGZ7vdfvq7bwbM7dAw9", shopId,
  name: pack.title, description: pack.description, price: pack.priceYen,
  quantity: pack.quantity, skuCode: pack.managementCode,
  thumbnailCount: 1 };
const repo = { getAttempt: async () => attempt };
const readback = (candidates = [candidate]) => ({
  verifyTargetShop: async () => ({ status: "VERIFIED", shopMatched: true }),
  listDraftCandidates: async requestedShop => {
    assert.equal(requestedShop, shopId);
    return { status: "OK", complete: true, candidates };
  }
});

test("one matching remote draft is observed but never permits a write", async () => {
  const result = await reconcileReservedWebHttpDraft(job, repo, readback());
  assert.equal(result.status, "MATCHING_DRAFT_OBSERVED_NO_RESEND");
  assert.equal(result.observedDraftId, candidate.id);
  assert.equal(result.allowCreate, false);
  assert.equal(result.allowUpdate, false);
  assert.equal(result.allowPublish, false);
});

test("absence, duplicate SKU and incomplete reads never authorize resend", async () => {
  for (const candidates of [[], [candidate, { ...candidate,
    id: "2JXsGZ5tqLr5Z5SMBXSVUe" }],
  [{ ...candidate, price: 0 }]]) {
    const result = await reconcileReservedWebHttpDraft(job, repo,
      readback(candidates));
    assert.equal(result.allowCreate, false);
    assert.equal(result.observedDraftId, null);
  }
  const incomplete = await reconcileReservedWebHttpDraft(job, repo, {
    ...readback(), listDraftCandidates: async () => ({ status: "OK",
      complete: false, candidates: [candidate] }) });
  assert.equal(incomplete.status, "READ_UNVERIFIED_NO_RESEND");
  assert.equal(incomplete.allowCreate, false);
});

test("stored claim, shop and auth must be verified before candidate read", async () => {
  let reads = 0;
  const guarded = { verifyTargetShop: async () => ({ status: "VERIFIED",
    shopMatched: false }), listDraftCandidates: async () => {
      reads += 1; throw Error("unexpected"); } };
  assert.equal((await reconcileReservedWebHttpDraft(job,
    { getAttempt: async () => null }, guarded)).status,
  "ATTEMPT_UNKNOWN_NO_RESEND");
  assert.equal((await reconcileReservedWebHttpDraft(job, repo, guarded)).status,
    "SHOP_UNVERIFIED_NO_RESEND");
  assert.equal((await reconcileReservedWebHttpDraft(job, repo, {
    ...guarded, verifyTargetShop: async () => ({ status: "AUTH_REQUIRED",
      shopMatched: false }) })).status, "AUTH_REQUIRED_NO_RESEND");
  assert.equal(reads, 0);
});

test("malformed candidate IDs never become observed drafts", async () => {
  for (const id of [undefined, null, 12345, "", "bad/id"]) {
    const observed = await reconcileReservedWebHttpDraft(job, repo,
      readback([{ ...candidate, id }]));
    assert.equal(observed.status, "READ_UNVERIFIED_NO_RESEND");
    assert.equal(observed.observedDraftId, null);
    assert.equal(observed.allowCreate, false);
  }
});
