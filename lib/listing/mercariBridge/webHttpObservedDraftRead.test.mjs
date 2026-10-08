import test from "node:test";
import assert from "node:assert/strict";
import { buildWebHttpDraftJob } from "./webHttpDraftJob.ts";
import { B005396_CORRECT_DRAFT_ID, B005396_EMPTY_DRAFT_ID,
  readObservedB005396Draft } from "./webHttpObservedDraftRead.ts";

const inventoryId = "2c53f36a-7a60-4e34-801d-8abc24f6cfc0";
const shipping = { method: "METHOD_TYPE_UNDECIDED", payer: "PAYER_TYPE_SELLER",
  origin: "jp11", duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" };
const pack = { schemaVersion: 1, kind: "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK",
  shopId: "evkhihBFFNn5hukMS9s36H", inventoryId,
  draftId: "0d76fb56-41f8-4dd3-ae18-a660a5e97ae1",
  draftUpdatedAt: "2026-10-08T01:02:03.000Z", title: "Fixture sofa",
  description: "Fixture description", condition: "NO_NOTABLE_DAMAGE",
  imageRefs: [{ source: "INVENTORY", storageKey: "inventory/front.jpg",
    sortOrder: 0, photoAssetId: null }], priceYen: 99999, quantity: 1,
  categoryId: "furniture_sofa", categoryPath: "家具・インテリア > ソファ",
  brandId: null, brandName: null,
  managementCode: "BELLO_2C53F36A7A604E34801D8ABC24F6CFC0",
  shipping, status: "PREPARED_NO_SEND" };
const evidence = { sourceInventoryCode: "B005396", sourcePriceYen: 50000,
  sourceQuantity: 1, sourceShippingMethod: "KAZAI", selectedQuantity: 1,
  selectedCategoryId: pack.categoryId, selectedCategoryPath: pack.categoryPath,
  categoryEvidence: "ADMIN_SELECTED_MASTER", shopsShipping: shipping,
  imageCount: 1, imageEvidence: "SAVED_REFERENCES_ONLY",
  shippingReviewRequired: true, status: "REVIEW_REQUIRED_NO_SEND" };
const job = buildWebHttpDraftJob(pack, evidence, "admin@example.com");
const response = (id, value) => ({ status: 200,
  body: { data: { productDraft: { id, ...value } } } });
const correct = { name: pack.title, description: pack.description,
  price: pack.priceYen, variants: [{ quantity: 1,
    skuCode: pack.managementCode }], thumbnails: [{ id: "asset" }] };
const empty = { name: pack.title, price: 0, thumbnails: [] };

test("known draft reconciliation only issues two read operations", async () => {
  const calls = [];
  const transport = { post: async request => {
    calls.push(request);
    assert.equal(request.operationName, "GetProductDraft");
    return request.variables.id === B005396_CORRECT_DRAFT_ID ?
      response(B005396_CORRECT_DRAFT_ID, correct) :
      response(B005396_EMPTY_DRAFT_ID, empty);
  } };
  const result = await readObservedB005396Draft(job, transport);
  assert.equal(result.ok, true);
  assert.equal(result.duplicateDraftObserved, true);
  assert.equal(result.allowCreate, false);
  assert.equal(result.allowUpdate, false);
  assert.deepEqual(calls.map(x => x.variables.id),
    [B005396_CORRECT_DRAFT_ID, B005396_EMPTY_DRAFT_ID]);
});

test("no authenticated transport, mismatched draft, or read error cannot create", async () => {
  const noAuth = await readObservedB005396Draft(job, null);
  assert.equal(noAuth.code, "AUTH_TRANSPORT_UNAVAILABLE");
  assert.equal(noAuth.allowCreate, false);
  const mismatched = await readObservedB005396Draft(job, { post: async request =>
    request.variables.id === B005396_CORRECT_DRAFT_ID ?
      response(B005396_CORRECT_DRAFT_ID, { ...correct, price: 0 }) :
      response(B005396_EMPTY_DRAFT_ID, empty) });
  assert.equal(mismatched.code, "DRAFT_MISMATCH");
  assert.equal(mismatched.allowCreate, false);
  const failed = await readObservedB005396Draft(job,
    { post: async () => { throw Error("network unavailable"); } });
  assert.equal(failed.code, "REMOTE_READ_UNVERIFIED");
  assert.equal(failed.allowCreate, false);
});
