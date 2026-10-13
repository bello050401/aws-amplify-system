import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { buildWebHttpDraftJob } from "./webHttpDraftJob.ts";
import { prepareInventoryImageForObservedUpload } from
  "./webHttpInventoryImageSource.ts";

const inventoryId = "1fa6d72b-306f-4af8-bfc8-a4bd4435eb33";
const storageKey = "inventory/front.jpg";
const shipping = { method: "METHOD_TYPE_UNDECIDED",
  payer: "PAYER_TYPE_SELLER", origin: "jp11",
  duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" };
const pack = { schemaVersion: 1,
  kind: "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK",
  shopId: "evkhihBFFNn5hukMS9s36H", inventoryId,
  draftId: "0d76fb56-41f8-4dd3-ae18-a660a5e97ae1",
  draftUpdatedAt: "2026-10-08T01:02:03.000Z", title: "Fixture sofa",
  description: "Fixture description", condition: "NO_NOTABLE_DAMAGE",
  imageRefs: [{ source: "INVENTORY", storageKey, sortOrder: 0,
    photoAssetId: null }], priceYen: 46900, quantity: 1,
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
const image = new Uint8Array(await sharp({ create: { width: 100, height: 80,
  channels: 3, background: "#723832" } }).jpeg().toBuffer());
const sha = createHash("sha256").update(image).digest("hex");

test("saved BELLO image produces a proof tied to the exact frozen job", async () => {
  const proof = await prepareInventoryImageForObservedUpload(job, {
    readInventory: async () => ({ id: inventoryId,
      images: [{ storageKey, originalHash: sha }] }),
    readStorageBytes: async () => image,
  });
  assert.equal(proof?.sourceProof.originalSha256, sha);
  assert.equal(proof?.sourceProof.snapshotFingerprint,
    job.snapshotFingerprint);
  assert.equal(proof?.prepared.preparedJpegSha256,
    proof?.sourceProof.preparedJpegSha256);
});

test("changed or missing saved image blocks preparation before any Shops send", async () => {
  const readStorageBytes = async () => image;
  const withImages = images => ({ readInventory: async () =>
    ({ id: inventoryId, images }), readStorageBytes });
  assert.equal(await prepareInventoryImageForObservedUpload(job,
    withImages([])), null);
  assert.equal(await prepareInventoryImageForObservedUpload(job,
    withImages([{ storageKey, originalHash: "0".repeat(64) }])), null);
  assert.equal(await prepareInventoryImageForObservedUpload(job, {
    readInventory: async () => ({ id: inventoryId,
      images: [{ storageKey, originalHash: sha }] }),
    readStorageBytes: async () => new Uint8Array(0),
  }), null);
});
