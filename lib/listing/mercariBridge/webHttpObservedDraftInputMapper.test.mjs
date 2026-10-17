import test from "node:test";
import assert from "node:assert/strict";
import { buildWebHttpDraftJob } from "./webHttpDraftJob.ts";
import { mapObservedDraftInput } from "./webHttpObservedDraftInputMapper.ts";

const inventoryId = "7ad79e0c-3b49-49a2-9a4b-f379863028e1";
const shopId = "evkhihBFFNn5hukMS9s36H";
const draftId = "5011916b-65af-4b73-89e5-00b9474a4e8a";
const remoteDraftId = "2JXsGZ7vdfvq7bwbM7dAw9";
const imageHash = "a".repeat(64);
const shipping = { method: "METHOD_TYPE_UNDECIDED",
  payer: "PAYER_TYPE_SELLER", origin: "jp11",
  duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" };
const pack = { schemaVersion: 1, kind: "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK",
  shopId, inventoryId, draftId,
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
const job = buildWebHttpDraftJob(pack, evidence, "admin@example.com");
const inventory = { id: inventoryId, sku: "B009990", quantity: 1,
  categoryName: "ソファ", market: null, saleEndDate: null };
const draft = { id: draftId, inventoryId, title: pack.title,
  description: pack.description, price: evidence.sourcePriceYen,
  condition: pack.condition, shippingMethod: "KAZAI",
  images: pack.imageRefs, createdBy: null, updatedBy: null,
  createdAt: "2026-10-01T00:00:00.000Z", updatedAt: pack.draftUpdatedAt };
const selected = { status: "HUMAN_VERIFIED_SHOPS_SELECTION", shopId,
  snapshotFingerprint: job.snapshotFingerprint,
  categoryId: pack.categoryId, categoryPath: pack.categoryPath,
  belloConditionCode: pack.condition, shopsConditionEnum: "CONDITION_CLEAN",
  adminPriceYen: pack.priceYen, adminQuantity: pack.quantity,
  countryRestrictionTemplateId: "verified-country-template",
  channelListingScope: "verified-scope", variantDefaultsVerified: true };
const image = { status: "VERIFIED_SAME_IMAGE_BYTES", shopId, inventoryId,
  snapshotFingerprint: job.snapshotFingerprint, remoteAssetId: "Asset123456",
  imageRefCount: 1, sourceImageSha256: imageHash };
const seed = { status: "VERIFIED_OBSERVED_SEED_STRATEGY",
  snapshotFingerprint: job.snapshotFingerprint, value: 0.5 };
const targetDraft = { status: "VERIFIED_SAME_JOB_DRAFT", shopId, inventoryId,
  snapshotFingerprint: job.snapshotFingerprint, draftId: remoteDraftId };
const proofs = { selected, image, seed, targetDraft };
function ports(overrides = {}) {
  const state = { inventory, draft, category: { categoryId: pack.categoryId,
    fullPath: pack.categoryPath }, binding: false, channel: false,
    duplicate: "ABSENT_COMPLETE", imageHash, ...overrides };
  return { readInventory: async () => state.inventory,
    readSavedDraft: async () => state.draft,
    readSelectedCategory: async () => state.category,
    readSelectedBrand: async () => state.brand ?? null,
    hasExistingBinding: async () => state.binding,
    hasExistingChannelListing: async () => state.channel,
    readRemoteDuplicate: async () => state.duplicate,
    readCurrentImageSha256: async () => state.imageHash };
}

test("anonymous shipping and a saved description suffix survive mapping",async()=>{
  const anon={...pack,descriptionSuffix:"配送について",description:pack.description+"\n\n配送について",shipping:{...shipping,method:"METHOD_MERCARI_SHIPPING_YAMATO"}};
  const j=buildWebHttpDraftJob(anon,{...evidence,shopsShipping:anon.shipping},"admin@example.com");
  assert.ok(j);
  const p=Object.fromEntries(Object.entries(proofs).map(([key,value])=>[key,{...value,snapshotFingerprint:j.snapshotFingerprint}]));
  const r=await mapObservedDraftInput(j,"UPDATE",ports({duplicate:{status:"TARGET_ONLY_COMPLETE",draftId:remoteDraftId}}),p);
  assert.equal(r.ok,true);assert.equal(r.mutation.input.shippingMethodType,"METHOD_MERCARI_SHIPPING_YAMATO");
  assert.equal(r.mutation.input.description,anon.description);
});

test("maps exact observed create and update input without sending", async () => {
  const create = await mapObservedDraftInput(job, "CREATE", ports(), proofs);
  assert.equal(create.ok, true);
  assert.equal(create.allowHttpWrite, false);
  assert.equal(create.mutation.idempotencyKeySeed, 0.5);
  assert.deepEqual(create.mutation.input, {
    name: pack.title, description: pack.description, brandIds: null,
    shippingPayerType: shipping.payer,
    countryRestrictionTemplateId: selected.countryRestrictionTemplateId,
    isRefurbished: false, channelListingScope: selected.channelListingScope,
    shopId, price: null, assetIds: null, categoryIds: null,
    condition: null, shippingFromStateId: null,
    shippingDurationType: null, shippingMethodType: null,
    variants: [{ name: "", quantity: 1, skuCode: pack.managementCode,
      janCode: "", maxQuantityPerOrder: null, catalogSkuId: null }],
  });
  const update = await mapObservedDraftInput(job, "UPDATE",
    ports({ duplicate: { status: "TARGET_ONLY_COMPLETE",
      draftId: remoteDraftId } }), proofs);
  assert.equal(update.ok, true);
  assert.equal(update.allowHttpWrite, false);
  assert.deepEqual(update.mutation.input, {
    name: pack.title, description: pack.description, brandIds: null,
    shippingPayerType: shipping.payer,
    countryRestrictionTemplateId: selected.countryRestrictionTemplateId,
    isRefurbished: false, channelListingScope: selected.channelListingScope,
    id: remoteDraftId, price: pack.priceYen, assetIds: [image.remoteAssetId],
    categoryIds: [pack.categoryId], condition: "CONDITION_CLEAN",
    shippingFromStateId: shipping.origin,
    shippingDurationType: shipping.duration,
    shippingMethodType: shipping.method,
    variants: [{ name: "", quantity: 1, skuCode: pack.managementCode,
      janCode: "", maxQuantityPerOrder: null, catalogSkuId: "",
      attributes: [] }],
  });
});

test("changed BELLO draft or current inventory blocks mapping", async () => {
  for (const changes of [
    { draft: { ...draft, title: "Changed" } },
    { draft: { ...draft, price: 51000 } },
    { draft: { ...draft, images: [] } },
    { inventory: { ...inventory, sku: "B005396" } },
    { inventory: { ...inventory, quantity: 0 } },
    { inventory: { ...inventory, categoryName: "発送完了" } },
    { inventory: { ...inventory, categoryName: "売り切れ" } },
    { inventory: { ...inventory, saleEndDate: "2026-09-15" } },
    { inventory: { ...inventory, market: "メルカリSHOP" } },
  ]) {
    const result = await mapObservedDraftInput(job, "CREATE",
      ports(changes), proofs);
    assert.equal(result.ok, false);
  }
});

test("an unread market field is not the same as an explicit null", async () => {
  const { market: _market, ...withoutMarket } = inventory;
  for (const current of [withoutMarket,
    { ...inventory, market: undefined },
    { ...inventory, market: "" }]) {
    const result = await mapObservedDraftInput(job, "CREATE",
      ports({ inventory: current }), proofs);
    assert.deepEqual(result, { ok: false,
      code: "CURRENT_SOURCE_UNVERIFIED", allowHttpWrite: false });
  }
  assert.equal((await mapObservedDraftInput(job, "CREATE",
    ports({ inventory: { ...inventory, market: null } }), proofs)).ok, true);
});

test("existing listing, incomplete duplicate scan and changed category block", async () => {
  for (const changes of [
    { binding: true }, { channel: true }, { duplicate: "UNKNOWN" },
    { duplicate: "FOUND" }, { category: null },
    { category: { categoryId: pack.categoryId, fullPath: "changed" } },
  ]) {
    const result = await mapObservedDraftInput(job, "CREATE",
      ports(changes), proofs);
    assert.equal(result.ok, false);
  }
});

test("unverified image, condition, seed or target draft blocks", async () => {
  for (const [port, proof] of [
    [ports({ imageHash: "b".repeat(64) }), proofs],
    [ports(), { ...proofs, image: null }],
    [ports(), { ...proofs, selected: { ...selected,
      shopsConditionEnum: "NO_NOTABLE_DAMAGE" } }],
    [ports(), { ...proofs, selected: { ...selected,
      categoryId: "other" } }],
    [ports(), { ...proofs, seed: null }],
  ]) {
    const result = await mapObservedDraftInput(job, "CREATE", port, proof);
    assert.equal(result.ok, false);
  }
  const updatePorts = ports({ duplicate: { status: "TARGET_ONLY_COMPLETE",
    draftId: remoteDraftId } });
  const missingTarget = await mapObservedDraftInput(job, "UPDATE",
    updatePorts, { ...proofs, targetDraft: null });
  assert.equal(missingTarget.ok, false);
});

test("image asset and target draft IDs must be strings before pattern checks", async () => {
  for (const invalidId of [undefined, null, 123, true]) {
    const assetResult = await mapObservedDraftInput(job, "CREATE",
      ports(), { ...proofs,
        image: { ...image, remoteAssetId: invalidId } });
    assert.deepEqual(assetResult, { ok: false,
      code: "IMAGE_UNVERIFIED", allowHttpWrite: false });
    const targetResult = await mapObservedDraftInput(job, "UPDATE",
      ports({ duplicate: { status: "TARGET_ONLY_COMPLETE",
        draftId: invalidId } }),
      { ...proofs, targetDraft: { ...targetDraft,
        draftId: invalidId } });
    assert.deepEqual(targetResult, { ok: false,
      code: "TARGET_UNVERIFIED", allowHttpWrite: false });
  }
});

test("unknown brands and incomplete multiple-image proofs are rejected", async () => {
  const branded = { ...pack, brandId: "brand-id", brandName: "Brand" };
  const brandedJob = buildWebHttpDraftJob(branded, evidence,
    "admin@example.com");
  const brandedProofs = { ...proofs,
    selected: { ...selected,
      snapshotFingerprint: brandedJob.snapshotFingerprint },
    image: { ...image,
      snapshotFingerprint: brandedJob.snapshotFingerprint },
    seed: { ...seed,
      snapshotFingerprint: brandedJob.snapshotFingerprint } };
  assert.equal((await mapObservedDraftInput(brandedJob, "CREATE",
    ports(), brandedProofs)).ok, false);
  const multipleImages = { ...pack, imageRefs: [pack.imageRefs[0],
    { ...pack.imageRefs[0], storageKey: "inventory/side.jpg",
      sortOrder: 1 }] };
  const multipleEvidence = { ...evidence, imageCount: 2 };
  const multipleJob = buildWebHttpDraftJob(multipleImages,
    multipleEvidence, "admin@example.com");
  const multipleProofs = { ...proofs,
    selected: { ...selected,
      snapshotFingerprint: multipleJob.snapshotFingerprint },
    image: { ...image,
      snapshotFingerprint: multipleJob.snapshotFingerprint },
    seed: { ...seed,
      snapshotFingerprint: multipleJob.snapshotFingerprint } };
  assert.equal((await mapObservedDraftInput(multipleJob, "CREATE",
    ports({ draft: { ...draft, images: multipleImages.imageRefs } }),
    multipleProofs)).ok, false);
});

test("all observed conditions and a master-verified optional brand survive mapping", async () => {
  const cases = [["NEW", "CONDITION_BRAND_NEW"], ["LIKE_NEW", "CONDITION_ALMOST_NEW"],
    ["NO_NOTABLE_DAMAGE", "CONDITION_CLEAN"], ["SLIGHT_DAMAGE", "CONDITION_LITTLE_DIRTY"],
    ["DAMAGE", "CONDITION_DIRTY"], ["BAD", "CONDITION_BAD"]];
  for (const [condition, remoteCondition] of cases) {
    for (const brand of [null, { brandId: "Brand1", name: "Selected brand" }]) {
      const currentPack = { ...pack, condition, brandId: brand?.brandId ?? null, brandName: brand?.name ?? null };
      const currentJob = buildWebHttpDraftJob(currentPack, evidence, "admin@example.com");
      const updatedProofs = Object.fromEntries(Object.entries(proofs).map(([key, value]) =>
        [key, { ...value, snapshotFingerprint: currentJob.snapshotFingerprint }]));
      updatedProofs.selected.belloConditionCode = condition;
      updatedProofs.selected.shopsConditionEnum = remoteCondition;
      const source = ports({ draft: { ...draft, condition }, brand,
        duplicate: { status: "TARGET_ONLY_COMPLETE", draftId: remoteDraftId } });
      const mapped = await mapObservedDraftInput(currentJob, "UPDATE", source, updatedProofs);
      assert.equal(mapped.ok, true);
      assert.equal(mapped.mutation.input.condition, remoteCondition);
      assert.deepEqual(mapped.mutation.input.brandIds, brand ? [brand.brandId] : null);
      if (brand) {
        for (const wrong of [null, { ...brand, name: "Different brand" }, { ...brand, brandId: "Other" }]) {
          assert.equal((await mapObservedDraftInput(currentJob, "UPDATE", {
            ...source, readSelectedBrand: async () => wrong,
          }, updatedProofs)).ok, false);
        }
      }
    }
  }
});

test("a changed BELLO condition cannot retain the previous condition proof", async () => {
  const changed = { ...pack, condition: "NEW" };
  const changedJob = buildWebHttpDraftJob(changed, evidence,
    "admin@example.com");
  const changedProofs = { ...proofs,
    selected: { ...selected, belloConditionCode: "NEW",
      snapshotFingerprint: changedJob.snapshotFingerprint },
    image: { ...image,
      snapshotFingerprint: changedJob.snapshotFingerprint },
    seed: { ...seed,
      snapshotFingerprint: changedJob.snapshotFingerprint } };
  const result = await mapObservedDraftInput(changedJob, "CREATE",
    ports({ draft: { ...draft, condition: "NEW" } }), changedProofs);
  assert.deepEqual(result, { ok: false, code: "SELECTION_UNVERIFIED",
    allowHttpWrite: false });
});

test("B005396 sold inventory cannot be mapped even with complete proofs", async () => {
  const soldJob = { ...job, inventoryId:
    "2c53f36a-7a60-4e34-801d-8abc24f6cfc0" };
  const result = await mapObservedDraftInput(soldJob, "CREATE",
    ports(), proofs);
  assert.deepEqual(result, { ok: false, code: "INVALID_JOB",
    allowHttpWrite: false });
});

test("multiple verified photos preserve order and reject a missing proof or changed bytes", async () => {
 const refs = [pack.imageRefs[0], { ...pack.imageRefs[0], storageKey: "inventory/side.jpg", sortOrder: 1 }];
 const multiPack = { ...pack, imageRefs: refs };
 const multiJob = buildWebHttpDraftJob(multiPack, { ...evidence, imageCount: 2 }, "admin@example.com");
 const fingerprint = multiJob.snapshotFingerprint;
 const multiProofs = {
   selected: { ...selected, snapshotFingerprint: fingerprint, countryRestrictionTemplateId: "" },
   seed: { ...seed, snapshotFingerprint: fingerprint },
   targetDraft: { ...targetDraft, snapshotFingerprint: fingerprint },
   image: { ...image, snapshotFingerprint: fingerprint, imageRefCount: 2,
     remoteAssetIds: [image.remoteAssetId, "SideAsset"], sourceImageSha256s: [imageHash, "b".repeat(64)] }
 };
 const p = ports({ draft: { ...draft, images: refs }, duplicate: { status: "TARGET_ONLY_COMPLETE", draftId: remoteDraftId } });
 p.readCurrentImageSha256 = async ref => ref.storageKey === refs[0].storageKey ? imageHash : "b".repeat(64);
 const mapped = await mapObservedDraftInput(multiJob, "UPDATE", p, multiProofs);
 assert.equal(mapped.ok, true); assert.deepEqual(mapped.mutation.input.assetIds, [image.remoteAssetId, "SideAsset"]);
 const missing = structuredClone(multiProofs); missing.image.remoteAssetIds.pop();
 assert.equal((await mapObservedDraftInput(multiJob, "UPDATE", p, missing)).ok, false);
 p.readCurrentImageSha256 = async () => "c".repeat(64);
 assert.equal((await mapObservedDraftInput(multiJob, "UPDATE", p, multiProofs)).ok, false);
});
