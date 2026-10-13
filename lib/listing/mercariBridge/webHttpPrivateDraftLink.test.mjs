import test from "node:test";
import assert from "node:assert/strict";
import { buildWebHttpDraftJob } from "./webHttpDraftJob.ts";
import { webHttpStageRequestId } from "./webHttpSendReservation.ts";
import { recordVerifiedPrivateDraftLink } from "./webHttpPrivateDraftLink.ts";

const inventoryId = "1fa6d72b-306f-4af8-bfc8-a4bd4435eb33";
const shopId = "evkhihBFFNn5hukMS9s36H";
const draftId = "Draft123456";
const sha = "a".repeat(64);
const shipping = { method: "METHOD_TYPE_UNDECIDED",
  payer: "PAYER_TYPE_SELLER", origin: "jp11",
  duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" };
const pack = { schemaVersion: 1,
  kind: "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK", shopId, inventoryId,
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
const job = buildWebHttpDraftJob(pack, evidence, "owner_123");
const common = { inventoryId, shopId, requestedBy: job.requestedBy,
  snapshotFingerprint: job.snapshotFingerprint };
const rows = new Map([
  [webHttpStageRequestId(job, { kind: "DRAFT_CREATE" }),
    { ...common, requestId: webHttpStageRequestId(job,
      { kind: "DRAFT_CREATE" }), status: "DRAFT_ACKNOWLEDGED",
    draftMutationKind: "CREATE", remoteDraftId: draftId }],
  [webHttpStageRequestId(job, { kind: "IMAGE_UPLOAD",
    preparedJpegSha256: sha }), { ...common,
    requestId: webHttpStageRequestId(job, { kind: "IMAGE_UPLOAD",
      preparedJpegSha256: sha }), status: "IMAGE_ACKNOWLEDGED",
    preparedJpegSha256: sha, remoteAssetId: "Asset123" }],
  [webHttpStageRequestId(job, { kind: "DRAFT_UPDATE", draftId }),
    { ...common, requestId: webHttpStageRequestId(job,
      { kind: "DRAFT_UPDATE", draftId }), status: "DRAFT_ACKNOWLEDGED",
    draftMutationKind: "UPDATE", remoteDraftId: draftId }],
]);
const attempts = { getAttempt: async id => rows.get(id) ?? null };
const details = { status: "VERIFIED", shopId, draftId,
  skuCode: job.managementCode, name: pack.title,
  description: pack.description, price: pack.priceYen,
  quantity: pack.quantity, categoryId: pack.categoryId,
  conditionId: "CONDITION_CLEAN", imageAssetIds: ["Asset123"],
  shippingMethodId: shipping.method, shippingPayerId: shipping.payer,
  shippingDurationId: shipping.duration,
  shippingFromStateId: shipping.origin };

test("one private draft link is saved and replay is read-only", async () => {
  let saved = null;
  let creates = 0;
  const links = { get: async () => saved, createIfAbsent: async link => {
    creates++;
    if (saved) throw Error("conditional conflict");
    saved = link;
  } };
  const args = [job, draftId, sha, attempts, async () => details, links,
    "2026-10-13T01:00:00.000Z"];
  const first = await recordVerifiedPrivateDraftLink(...args);
  assert.equal(first.status, "RECORDED");
  assert.equal(first.listingConfirmed, false);
  assert.equal(first.link.status, "PRIVATE_DRAFT_VERIFIED");
  assert.equal((await recordVerifiedPrivateDraftLink(...args)).status,
    "ALREADY_RECORDED");
  assert.equal(creates, 1);
});

test("unknown remote result or conflicting local link cannot be accepted", async () => {
  let created = false;
  const links = { get: async () => null,
    createIfAbsent: async () => { created = true; } };
  assert.equal((await recordVerifiedPrivateDraftLink(job, draftId, sha,
    attempts, async () => ({ ...details, price: 1 }), links)).status,
    "UNVERIFIED");
  assert.equal(created, false);
  const other = { ...details, draftId: "OtherDraft" };
  assert.equal((await recordVerifiedPrivateDraftLink(job, draftId, sha,
    attempts, async () => other, links)).status, "UNVERIFIED");
  const conflict = { get: async () => ({ inventoryId, shopId,
    remoteDraftId: "OtherDraft", requestId: job.requestId,
    snapshotFingerprint: job.snapshotFingerprint,
    status: "PRIVATE_DRAFT_VERIFIED", verifiedAt: "2026-10-13T00:00:00Z" }),
    createIfAbsent: async () => { throw Error("must not create"); } };
  assert.equal((await recordVerifiedPrivateDraftLink(job, draftId, sha,
    attempts, async () => details, conflict)).status, "CONFLICT");
});

test("an updated draft without this job's create acknowledgement is not linked", async () => {
  let created = false;
  const links = { get: async () => null,
    createIfAbsent: async () => { created = true; } };
  const noCreate = { getAttempt: async id =>
    id === webHttpStageRequestId(job, { kind: "DRAFT_CREATE" }) ? null :
      rows.get(id) ?? null };
  const outcome = await recordVerifiedPrivateDraftLink(job, draftId, sha,
    noCreate, async () => details, links);
  assert.equal(outcome.status, "UNVERIFIED");
  assert.equal(created, false);
});

test("lost local create response reconciles the same link without another remote send", async () => {
  let saved = null;
  const links = { get: async () => saved,
    createIfAbsent: async link => {
      saved = link;
      throw Error("response lost after conditional create");
    } };
  const outcome = await recordVerifiedPrivateDraftLink(job, draftId, sha,
    attempts, async () => details, links);
  assert.equal(outcome.status, "ALREADY_RECORDED");
  assert.equal(outcome.link.remoteDraftId, draftId);
  assert.equal(outcome.listingConfirmed, false);
  assert.equal((await recordVerifiedPrivateDraftLink(job, draftId, sha,
    attempts, async () => details,
    { get: async () => { throw Error("unavailable"); },
      createIfAbsent: async () => { throw Error("must not create"); } })).status,
    "STORAGE_UNKNOWN");
});
