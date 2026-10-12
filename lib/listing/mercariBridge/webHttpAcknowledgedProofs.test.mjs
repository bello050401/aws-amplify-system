import test from "node:test";
import assert from "node:assert/strict";
import { buildWebHttpDraftJob } from "./webHttpDraftJob.ts";
import { readAcknowledgedImageAssetProof,
  readAcknowledgedDraftTargetProof } from "./webHttpAcknowledgedProofs.ts";
import { webHttpStageRequestId } from "./webHttpSendReservation.ts";

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
const job = buildWebHttpDraftJob(pack, evidence, "owner_123");
const imageSha = "a".repeat(64);
const imageKey = webHttpStageRequestId(job,
  { kind: "IMAGE_UPLOAD", preparedJpegSha256: imageSha });
const createKey = webHttpStageRequestId(job, { kind: "DRAFT_CREATE" });
const common = { inventoryId: job.inventoryId, shopId: job.shopId,
  snapshotFingerprint: job.snapshotFingerprint, requestedBy: job.requestedBy };
const image = { ...common, requestId: imageKey,
  status: "IMAGE_ACKNOWLEDGED", preparedJpegSha256: imageSha,
  remoteAssetId: "Asset123456" };
const create = { ...common, requestId: createKey,
  status: "DRAFT_ACKNOWLEDGED", draftMutationKind: "CREATE",
  remoteDraftId: "Draft123456" };
const remote = { status: "VERIFIED", shopId: job.shopId,
  draftId: create.remoteDraftId, skuCode: job.managementCode,
  name: pack.title, description: pack.description };
const readback = async () => remote;

test("only durable matching acknowledgements become next-stage proofs", async () => {
  const rows = new Map([[imageKey, image], [createKey, create]]);
  const repo = { getAttempt: async key => rows.get(key) ?? null };
  assert.deepEqual(await readAcknowledgedImageAssetProof(job, imageSha, repo),
    { status: "VERIFIED_SAME_IMAGE_BYTES", shopId: job.shopId,
      inventoryId, snapshotFingerprint: job.snapshotFingerprint,
      remoteAssetId: "Asset123456", imageRefCount: 1 });
  assert.deepEqual(await readAcknowledgedDraftTargetProof(job, repo, readback),
    { status: "VERIFIED_SAME_JOB_DRAFT", shopId: job.shopId,
      inventoryId, snapshotFingerprint: job.snapshotFingerprint,
      draftId: "Draft123456" });
});

test("claimed, mismatched, malformed or unreadable records grant no proof", async () => {
  for (const changed of [
    { status: "SEND_CLAIMED_RESULT_UNKNOWN" },
    { snapshotFingerprint: "b".repeat(64) },
    { preparedJpegSha256: "b".repeat(64) },
    { remoteAssetId: "bad/id" },
    { requestedBy: "other" },
  ]) {
    assert.equal(await readAcknowledgedImageAssetProof(job, imageSha,
      { getAttempt: async () => ({ ...image, ...changed }) }), null);
  }
  for (const changed of [
    { status: "SEND_CLAIMED_RESULT_UNKNOWN" },
    { draftMutationKind: "UPDATE" },
    { remoteDraftId: "bad/id" },
    { shopId: "other" },
  ]) {
    assert.equal(await readAcknowledgedDraftTargetProof(job,
      { getAttempt: async () => ({ ...create, ...changed }) }, readback), null);
  }
  assert.equal(await readAcknowledgedDraftTargetProof(job,
    { getAttempt: async () => { throw Error("database unavailable"); } },
    readback), null);
  assert.equal(await readAcknowledgedImageAssetProof(job, "bad",
    { getAttempt: async () => { throw Error("must not read"); } }), null);
});

test("create acknowledgement alone never authorizes a draft update", async () => {
  const repo = { getAttempt: async () => create };
  for (const changed of [
    { status: "AUTH_REQUIRED" }, { status: "UNKNOWN" },
    { shopId: "other" }, { draftId: "OtherDraft" },
    { skuCode: "OTHER" }, { name: "Other name" },
    { description: "Other description" },
  ]) {
    assert.equal(await readAcknowledgedDraftTargetProof(job, repo,
      async () => ({ ...remote, ...changed })), null);
  }
  assert.equal(await readAcknowledgedDraftTargetProof(job, repo,
    async () => { throw Error("network unavailable"); }), null);
  assert.equal(await readAcknowledgedDraftTargetProof(job, repo,
    undefined), null);
});
