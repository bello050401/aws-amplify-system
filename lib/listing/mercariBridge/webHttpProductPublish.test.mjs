import test from "node:test";
import assert from "node:assert/strict";
import { buildWebHttpDraftJob, WEB_HTTP_SHOP_ID as shopId } from "./webHttpDraftJob.ts";
import { publishPreparedWebHttpProduct } from "./webHttpProductPublish.ts";

function scenario() {
  const inventoryId = "7ad79e0c-3b49-49a2-9a4b-f379863028e1", owner = "admin@example.com";
  let now = 100_000, slot = null, binding = null, creates = 0, draftConsumed = false;
  const shipping = { method: "METHOD_TYPE_UNDECIDED", payer: "PAYER_TYPE_SELLER",
    origin: "jp11", duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" };
  const pack = { schemaVersion: 1, kind: "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK", shopId, inventoryId,
    draftId: "5011916b-65af-4b73-89e5-00b9474a4e8a", draftUpdatedAt: "2026-10-08T01:02:03.000Z",
    title: "Fixture sofa", description: "Description", condition: "NO_NOTABLE_DAMAGE",
    imageRefs: [{ source: "INVENTORY", storageKey: "inventory/front.jpg", sortOrder: 0, photoAssetId: null }],
    priceYen: 99999, quantity: 1, categoryId: "furniture_sofa", categoryPath: "家具・インテリア > ソファ",
    brandId: null, brandName: null, managementCode: "BELLO_7AD79E0C3B4949A29A4BF379863028E1",
    shipping, status: "PREPARED_NO_SEND" };
  const job = buildWebHttpDraftJob(pack, { sourceInventoryCode: "B009990", sourcePriceYen: 50000,
    sourceQuantity: 1, sourceShippingMethod: "KAZAI", selectedQuantity: 1, selectedCategoryId: pack.categoryId,
    selectedCategoryPath: pack.categoryPath, categoryEvidence: "ADMIN_SELECTED_MASTER", shopsShipping: shipping,
    imageCount: 1, imageEvidence: "SAVED_REFERENCES_ONLY", shippingReviewRequired: true, status: "REVIEW_REQUIRED_NO_SEND" }, owner);
  const draft = { id: "Draft1", name: pack.title, description: pack.description, price: pack.priceYen,
    condition: { id: "CONDITION_CLEAN" }, brands: [], categories: [{ category: [{ id: pack.categoryId }] }],
    thumbnails: [{ id: "Asset1" }], variants: [{ name: "", quantity: 1, skuCode: pack.managementCode,
      janCode: "", attributes: [], catalogSkuId: null, maxQuantityPerOrderConfig: { configuredValue: null } }],
    shippingMethodType: { id: shipping.method }, shippingPayerType: { id: shipping.payer },
    shippingFromState: { id: shipping.origin }, shippingDurationType: { id: shipping.duration },
    preOrder: null, shippingConfiguration: null, mercariBinForBusinessSetting: null,
    countryRestrictionTemplateId: null, channelListingScope: "CHANNEL_LISTING_SCOPE_ALL_CHANNELS", isRefurbished: false };
  const state = { sourceValid: true, saveFails: false, loseResponse: false, authFails: false, changeBeforeSend: false, changeAfterClaim: false, changedReadbackPrice: false };
  const attempts = new Map(), operations = [];
  const repository = {
    getAttempt: async id => structuredClone(attempts.get(id) ?? null), getSlot: async () => structuredClone(slot),
    transactReserve: async (previous, next, attempt) => {
      if (attempts.has(attempt.requestId) || slot?.revision !== previous?.revision) throw Error("conflict");
      slot = next; attempts.set(attempt.requestId, structuredClone(attempt));
      if (state.changeBeforeSend) state.sourceValid = false;
    },
    claimProductStart: async (id, attemptId, requestJson) => {
      const attempt = attempts.get(id);
      if (attempt?.attemptId !== attemptId || attempt.status !== "RESERVED_NO_SEND") throw Error("conflict");
      attempt.status = "SEND_CLAIMED_RESULT_UNKNOWN"; attempt.productCreateRequestJson = requestJson;
      if (state.changeAfterClaim) state.sourceValid = false;
    },
    acknowledgeProduct: async (id, attemptId, productId) => {
      const attempt = attempts.get(id);
      assert.equal(attempt.attemptId, attemptId); assert.equal(attempt.status, "SEND_CLAIMED_RESULT_UNKNOWN");
      attempt.remoteProductId = productId; attempt.status = "PRODUCT_ACKNOWLEDGED";
    },
  };
  const response = data => new Response(JSON.stringify({ data }), { status: 200 });
  const ports = { session: { cookieHeader: "id_token=private-test-cookie", expiresAtMs: 1_000_000 },
    getJob: async () => job, sourceUnchanged: async () => state.sourceValid,
    readDraftId: async () => draft.id,
    readVerifiedDraft: async () => ({ id: draft.id, assetIds: ["Asset1"] }),
    readBinding: async () => binding,
    saveBinding: async value => { if (state.saveFails) throw Error("storage"); binding = value; }, repository,
    fetchPort: async (url, init) => {
      assert.equal(url, "https://mercari-shops.com/graphql"); assert.equal(init.redirect, "manual");
      const request = JSON.parse(init.body); operations.push(request.operationName);
      if (state.authFails) return new Response("", { status: 401 });
      if (request.operationName === "Self") return response({ self: { accountId: "test-owner" } });
      if (request.operationName === "OwnShops") return response({ ownShops: [{ id: shopId }] });
      if (request.operationName === "GetProductDraft") return response({ productDraft: draftConsumed ? null : draft });
      if (request.operationName === "ValidateProductInfo") return response({ validateProductInfo: { result: true } });
      if (request.operationName === "CreateProduct") {
        creates++; draftConsumed = true;
        if (state.loseResponse) throw Error("lost private-test-cookie");
        return response({ createProduct: { id: "Product1" } });
      }
      assert.equal(request.operationName, "EditProductPage");
      return response({ ownShops: [{ id: shopId }], shopProduct: { ...draft, id: "Product1",
        price: state.changedReadbackPrice ? draft.price + 1 : draft.price,
        shop: { id: shopId }, status: { id: "STATUS_OPENED" }, snapshotId: "rev1", inStock: true,
        auction: null, currentDualPrice: null, mercaribinForBusinessSetting: null,
        variants: [{ ...draft.variants[0], id: "V1", stockSnapshotId: "stock1",
          optionTypes: [{ id: "T1", options: [{ id: "O1" }] }] }] } });
    },
  };
  const run = digest => publishPreparedWebHttpProduct(job.requestId, owner, digest, ports, () => now);
  return { run, state, ports, operations, attempts, get creates() { return creates; },
    get binding() { return binding; }, advance: value => { now += value; } };
}

test("review reads a real draft and never publishes without its confirmation", async () => {
  const s = scenario(), preview = await s.run(null);
  assert.equal(preview.status, "READY_FOR_CONFIRMATION");
  assert.equal(preview.preview.priceYen, 99999); assert.equal(s.creates, 0);
  assert.equal((await s.run("a".repeat(64))).status, "CONFIRMATION_CHANGED"); assert.equal(s.creates, 0);
});
test("confirmed publication reads back and saves the product binding", async () => {
  const s = scenario(), review = await s.run(null);
  const result = await s.run(review.preview.digest);
  assert.equal(result.status, "PUBLISHED"); assert.equal(s.creates, 1);
  assert.equal(s.binding.remoteProductId, "Product1");
  assert.equal((await s.run(review.preview.digest)).status, "EXISTING_PRODUCT"); assert.equal(s.creates, 1);
});
test("lost create response never permits a second creation", async () => {
  const s = scenario(), review = await s.run(null); s.state.loseResponse = true;
  assert.equal((await s.run(review.preview.digest)).status, "RESULT_UNKNOWN_NO_RESEND");
  s.advance(100_000);
  assert.equal((await s.run(review.preview.digest)).status, "RESULT_UNKNOWN_NO_RESEND"); assert.equal(s.creates, 1);
});
test("saved receipt can recover after its draft was consumed and binding storage failed", async () => {
  const s = scenario(), review = await s.run(null); s.state.saveFails = true;
  assert.equal((await s.run(review.preview.digest)).status, "STORAGE_UNAVAILABLE");
  s.state.saveFails = false;
  assert.equal((await s.run(null)).status, "PUBLISHED"); assert.equal(s.creates, 1);
});
test("concurrent confirmations send at most one creation", async () => {
  const s = scenario(), review = await s.run(null);
  await Promise.all([s.run(review.preview.digest), s.run(review.preview.digest)]);
  assert.equal(s.creates, 1);
});
test("changed inventory or expired auth prevents publication", async () => {
  const s = scenario(), review = await s.run(null); s.state.changeBeforeSend = true;
  assert.equal((await s.run(review.preview.digest)).status, "SOURCE_CHANGED"); assert.equal(s.creates, 0);
  const t = scenario(); t.advance(1_000_000);
  assert.equal((await t.run(null)).status, "AUTH_REQUIRED"); assert.equal(t.operations.length, 0);
});
test("authentication errors and session material are never returned to the UI", async () => {
  const s = scenario(); s.state.authFails = true;
  const result = await s.run(null); assert.equal(result.status, "AUTH_REQUIRED");
  assert.ok(!JSON.stringify(result).includes("private-test-cookie"));
});

test("receipt recovery survives changed inventory and unavailable old image bytes", async () => {
  const s = scenario(), review = await s.run(null); s.state.saveFails = true;
  assert.equal((await s.run(review.preview.digest)).status, "STORAGE_UNAVAILABLE");
  s.state.saveFails = false; s.state.sourceValid = false;
  s.ports.readVerifiedDraft = async () => { throw Error("original photos removed"); };
  assert.equal((await s.run(null)).status, "PUBLISHED");
  assert.equal(s.binding.remoteProductId, "Product1"); assert.equal(s.creates, 1);
});
test("a stock change during the atomic claim prevents the create request", async () => {
  const s = scenario(), review = await s.run(null); s.state.changeAfterClaim = true;
  assert.equal((await s.run(review.preview.digest)).status, "RESULT_UNKNOWN_NO_RESEND");
  assert.equal(s.creates, 0);
});

test("a changed readback is linked for recovery but not reported as the confirmed publication", async () => {
 const s = scenario(), r = await s.run(null); s.state.changedReadbackPrice = true;
 assert.equal((await s.run(r.preview.digest)).status, "EXISTING_PRODUCT");
 assert.equal(s.binding.remoteProductId, "Product1"); assert.equal(s.creates, 1);
});
