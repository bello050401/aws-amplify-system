import test from "node:test";
import assert from "node:assert/strict";
import { WEB_HTTP_SHOP_ID } from "./webHttpDraftJob.ts";
import { buildObservedStopProductRequest, buildObservedCreateProductRequest,
  parseObservedProductRead, buildObservedProductValidationRequest,
  observedProductValidationSucceeded, parseObservedCreateProductAck,
  observedStopProductAcknowledged } from "./webHttpObservedProductContract.ts";

// Synthetic values, with the exact response hierarchy captured on 2026-10-13.
const product = () => ({ id: "Product123", name: "Fixture chair",
  description: "Fixture description", snapshotId: "revision-3", inStock: false,
  shop: { id: WEB_HTTP_SHOP_ID }, status: { id: "STATUS_OPENED" }, price: 99999,
  condition: { id: "CONDITION_BAD" }, brands: [],
  categories: [{ category: [{ id: "root" }, { id: "furniture" },
    { id: "chairs" }, { id: "leaf" }] }],
  thumbnails: [{ id: "FrontAsset" }, { id: "BackAsset" }],
  variants: [{ id: "Variant123", name: "", quantity: 0,
    stockSnapshotId: "stock-9", skuCode: "BELLO_FIXTURE", janCode: "",
    catalogSkuId: null, maxQuantityPerOrderConfig: { configuredValue: null,
      actualValue: 0 }, optionTypes: [{ id: "Type123",
        options: [{ id: "Option123", name: "" }] }], attributes: [] }],
  shippingMethodType: { id: "METHOD_MERCARI_SHIPPING_YAMATO" },
  shippingPayerType: { id: "PAYER_TYPE_SELLER" },
  shippingDurationType: { id: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" },
  shippingFromState: { id: "jp11" }, currentDualPrice: null,
  shippingConfiguration: null, mercaribinForBusinessSetting: null,
  preOrder: null, auction: null, countryRestrictionTemplateId: null,
  isRefurbished: false, channelListingScope: "CHANNEL_LISTING_SCOPE_ALL_CHANNELS" });
const read = p => ({ data: { ownShops: [{ id: WEB_HTTP_SHOP_ID }],
  shopProduct: p, productOrders: [] } });

test("stop keeps the current stock, two images, leaf category and both concurrency snapshots", () => {
  const request = buildObservedStopProductRequest(read(product()), "Product123", 0.25);
  assert.equal(request.operationName, "UpdateProductV2");
  const input = request.variables.input;
  assert.equal(input.status, "STATUS_UNOPENED");
  assert.equal(input.productSnapshotId, "revision-3");
  assert.equal(input.variants[0].stockSnapshotId, "stock-9");
  assert.equal(input.variants[0].quantity, 0);
  assert.equal(input.variants[0].optionId, "Option123");
  assert.equal(input.variants[0].optionTypeId, "Type123");
  assert.deepEqual(input.categoryIds, ["leaf"]);
  assert.deepEqual(input.assetIds, ["FrontAsset", "BackAsset"]);
  assert.equal(input.countryRestrictionTemplateId, "");
  assert.equal(input.price, 99999);
  assert.equal(parseObservedProductRead(read(product()), "Product123").inStock, false);
});

test("a changed read supplies changed snapshots and quantity instead of replaying a capture", () => {
  const p = product();
  p.snapshotId = "revision-4";
  p.variants[0].stockSnapshotId = "stock-10";
  p.variants[0].quantity = 2;
  const input = buildObservedStopProductRequest(read(p), p.id, 0.5).variables.input;
  assert.equal(input.productSnapshotId, "revision-4");
  assert.equal(input.variants[0].stockSnapshotId, "stock-10");
  assert.equal(input.variants[0].quantity, 2);
});

test("unknown reads, wrong shop, unsupported fields and an already stopped item do not build an update", () => {
  const failed = [null, {}, { errors: [{ message: "secret" }] },
    { data: { shopProduct: product(), ownShops: [] } },
    read({ ...product(), shop: { id: "other" } }),
    read({ ...product(), id: "other" }),
    read({ ...product(), status: { id: "STATUS_UNOPENED" } }),
    read({ ...product(), snapshotId: "" }),
    read({ ...product(), shippingConfiguration: { id: "custom" } }),
    read({ ...product(), categories: [{ category: { id: "leaf" } }] }),
    read({ ...product(), preOrder: {} }),
    read({ ...product(), variants: [{ ...product().variants[0], optionTypes: [] }] }),
    read({ ...product(), variants: [{ ...product().variants[0], attributes: [{}] }] })];
  for (const body of failed)
    assert.equal(buildObservedStopProductRequest(body, "Product123", 0.25), null);
  assert.equal(buildObservedStopProductRequest(read(product()), "Product123", NaN), null);
});

test("publication uses the verified draft's fields and its ID without old product snapshots", () => {
  const p = product();
  const draft = { ...p, id: "Draft123", mercariBinForBusinessSetting: null };
  const request = buildObservedCreateProductRequest({ data: { productDraft: draft } },
    "Draft123", 0.25);
  assert.equal(request.operationName, "CreateProduct");
  const input = request.variables.input;
  assert.equal(input.productDraftId, "Draft123");
  assert.equal(input.status, "STATUS_OPENED");
  assert.equal(input.shopId, WEB_HTTP_SHOP_ID);
  assert.equal(input.price, 99999);
  assert.deepEqual(input.assetIds, ["FrontAsset", "BackAsset"]);
  assert.deepEqual(input.categoryIds, ["leaf"]);
  assert.equal(input.variants[0].quantity, 0);
  assert.equal("id" in input.variants[0], false);
  assert.equal("stockSnapshotId" in input.variants[0], false);
  assert.equal("productSnapshotId" in input, false);
  assert.equal(buildObservedCreateProductRequest({ data: { productDraft: draft } },
    "WrongDraft", 0.25), null);
});

test("validation and acknowledgements require successful GraphQL data and exact product identity", () => {
  assert.deepEqual(buildObservedProductValidationRequest("Chair", "Description").variables,
    { input: { name: "Chair", description: "Description" } });
  assert.equal(observedProductValidationSucceeded({ data: { validateProductInfo: { result: true } } }), true);
  assert.equal(observedProductValidationSucceeded({ data: { validateProductInfo: { result: false } } }), false);
  assert.equal(observedProductValidationSucceeded({ data: { validateProductInfo: { result: true } }, errors: [] }), false);
  assert.equal(parseObservedCreateProductAck({ data: { createProduct: { id: "Product123" } } }), "Product123");
  assert.equal(parseObservedCreateProductAck({ data: { createProduct: {} } }), null);
  const ack = { data: { updateProductV2: { id: "Product123", status: { id: "STATUS_UNOPENED" } } } };
  assert.equal(observedStopProductAcknowledged(ack, "Product123"), true);
  assert.equal(observedStopProductAcknowledged(ack, "OtherProduct"), false);
  assert.equal(observedStopProductAcknowledged({ ...ack, errors: [{}] }, "Product123"), false);
});
