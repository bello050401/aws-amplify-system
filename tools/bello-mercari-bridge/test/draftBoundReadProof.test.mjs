import test from "node:test";
import assert from "node:assert/strict";
import { classifyBoundDraftReadTarget,
  evaluateBoundDraftReadProof } from
  "../src/draftBoundReadProof.mjs";

const shopId = "evkhihBFFNn5hukMS9s36H";
const managementCode = "BELLO_2C53F36A7A604E34801D8ABC24F6CFC0";
const target = { managementCode, title: "対象商品", priceYen: 99_999 };
const rows = [
  { draftId: "draft1", title: "別の商品", skuCode: "OTHER_1" },
  { draftId: "draft2", title: "", skuCode: null },
];
function item(id, name, skuCode, price) {
  return { id, name, description: "", price,
    condition: { id: "CONDITION_UNSPECIFIED", name: "不明",
      __typename: "ProductCondition" }, brands: [], categories: [],
    thumbnails: [], variants: [{ name: "", quantity: 1, janCode: "",
      skuCode, catalogSkuId: null, maxQuantityPerOrderConfig: null,
      attributes: [], __typename: "ProductVariant" }],
    shippingMethodType: { id: "METHOD_TYPE_UNSPECIFIED", name: "不明",
      __typename: "ShippingMethodType" },
    shippingPayerType: { id: "PAYER_TYPE_SELLER",
      name: "送料込み(出品者負担)", __typename: "ShippingPayerType" },
    shippingDurationType: { id: "DURATION_TYPE_UNSPECIFIED", name: "不明",
      __typename: "ShippingDurationType" },
    shippingFromState: null, shippingConfiguration: null,
    mercariBinForBusinessSetting: null, preOrder: null,
    isRefurbished: false,
    channelListingScope: "CHANNEL_LISTING_SCOPE_ALL_CHANNELS",
    __typename: "ProductDraft", countryRestrictionTemplateId: "" };
}
function rowOf(item) {
  return { id: item.id, title: item.name, price: item.price,
    node: { id: item.id, name: item.name, description: item.description,
      price: item.price, shippingPayerType: item.shippingPayerType,
      thumbnails: item.thumbnails, updatedAt: 1_760_000_000_000,
      channelListingScope: item.channelListingScope,
      __typename: "ProductDraft" } };
}
function entry(item) {
  return { id: item.id, title: item.name,
    skuCode: item.variants[0].skuCode || null, priceYen: item.price,
    imageCount: item.thumbnails.length, item };
}
function proof({ first = item("draft1", "別の商品", "OTHER_1", 20_000),
  second = item("draft2", "", "", 0), domRows = rows,
  list = null, detailReadCounts = null, ownDraftId = null,
  reviewed = null } = {}) {
  const details = new Map([["draft1", entry(first)],
    ["draft2", entry(second)]]);
  return evaluateBoundDraftReadProof({ list: list ?? [rowOf(first), rowOf(second)],
    details, failed: false, rows: domRows, ...target, expectedRowCount: 2,
    listReadCount: 2, detailReadCounts: detailReadCounts ??
      new Map([["draft1", 2], ["draft2", 2]]), ownDraftId, reviewed });
}

test("two fresh bound reads of every draft establish only an advisory no match", () => {
  assert.deepEqual(proof(), { status: "DRAFT_NETWORK_BOUND_NO_MATCH",
    complete: true, allowFinalCreate: false, rowCount: 2,
    anonymousVerified: 1 });
});

test("observed query hashes bind the account list and exact URL draft ID", () => {
  const list = { operationName: "productDrafts",
    querySha256: "035b93384798e16e4a71bfdab8fa0e95bc0db9ae1a602e7ce832e016cebc147e",
    variables: { shopId, first: 50 },
    pageUrl: `https://mercari-shops.com/seller/shops/${shopId}/products?tab=draft`,
    shopId };
  assert.deepEqual(classifyBoundDraftReadTarget(list), { kind: "LIST" });
  assert.equal(classifyBoundDraftReadTarget({ ...list,
    variables: { ...list.variables, shopId: "anotherShop" } }), null);
  const detail = { operationName: "GetProductDraft",
    querySha256: "f6a841578f2199faec359e918c169f2ecbbdf0ceaa71fbe439588016c598d5b0",
    variables: { id: "draft1" },
    pageUrl: `https://mercari-shops.com/seller/shops/${shopId}/products/create?productDraftId=draft1`,
    shopId };
  assert.deepEqual(classifyBoundDraftReadTarget(detail),
    { kind: "DETAIL", id: "draft1" });
  assert.equal(classifyBoundDraftReadTarget({ ...detail,
    pageUrl: detail.pageUrl.replace("draft1", "draft2") }), null);
  assert.equal(classifyBoundDraftReadTarget({ ...detail,
    pageUrl: detail.pageUrl.replace(shopId, "anotherShop") }), null);
});

test("missing or changed reads fail closed", () => {
  assert.equal(proof({ detailReadCounts: new Map([["draft1", 2],
    ["draft2", 1]]) }).status, "DRAFT_NETWORK_BOUND_UNVERIFIED");
  assert.equal(evaluateBoundDraftReadProof({ failed: true }).status,
    "DRAFT_NETWORK_BOUND_UNVERIFIED");
  assert.equal(proof({ second: item("wrong", "", "", 0) }).status,
    "DRAFT_NETWORK_BOUND_UNVERIFIED");
  assert.equal(proof({ domRows: [rows[0], { ...rows[1],
    draftId: "other" }] }).status, "DRAFT_NETWORK_BOUND_UNVERIFIED");
});

test("blank title with any remaining product content is unresolved", () => {
  for (const change of [
    value => { value.description = "説明あり"; },
    value => { value.categories = [{ id: "cat1" }]; },
    value => { value.variants[0].quantity = 2; },
    value => { value.thumbnails = [{}]; },
    value => { value.price = 99_999; },
    value => { value.name = " \t "; },
  ]) {
    const second = item("draft2", "", "", 0);
    change(second);
    const domRows = [rows[0], { ...rows[1], title: second.name }];
    assert.equal(proof({ second, domRows }).status,
      "DRAFT_NETWORK_BOUND_UNVERIFIED");
  }
});

test("target identity in another draft blocks, while own draft requires all reviewed fields", () => {
  const other = item("draft1", "別の商品", managementCode, 20_000);
  assert.equal(proof({ first: other,
    domRows: [{ ...rows[0], skuCode: managementCode }, rows[1]] }).status,
  "REMOTE_DUPLICATE_POSSIBLE");
  const own = item("draft1", target.title, managementCode, target.priceYen);
  own.description = "対象説明";
  own.condition.id = "NO_NOTABLE_DAMAGE";
  own.categories = [{ id: "cat1" }];
  own.thumbnails = [{}];
  own.shippingMethodType.id = "METHOD_TYPE_UNDECIDED";
  own.shippingDurationType.id = "DURATION_TYPE_FOUR_TO_SEVEN_DAYS";
  own.shippingFromState = { id: "jp11" };
  const reviewed = { description: "対象説明", categoryId: "cat1",
    condition: "NO_NOTABLE_DAMAGE", quantity: 1, imageCount: 1,
    shipping: { method: "METHOD_TYPE_UNDECIDED",
      payer: "PAYER_TYPE_SELLER", origin: "jp11",
      duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" } };
  const domRows = [{ draftId: "draft1", title: target.title,
    skuCode: managementCode }, rows[1]];
  assert.equal(proof({ first: own, domRows, ownDraftId: "draft1",
    reviewed }).status, "DRAFT_NETWORK_BOUND_NO_OTHER_MATCH");
  own.description = "変化した説明";
  assert.equal(proof({ first: own, domRows, ownDraftId: "draft1",
    reviewed }).status, "DRAFT_NETWORK_BOUND_UNVERIFIED");
});
