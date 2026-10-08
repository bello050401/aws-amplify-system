import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { classifyBoundDraftReadTarget,
  evaluateBoundDraftReadProof, exactCompletedReadCycles,
  exactDraftBaseline } from
  "../src/draftBoundReadProof.mjs";

const shopId = "evkhihBFFNn5hukMS9s36H";
const managementCode = "BELLO_2C53F36A7A604E34801D8ABC24F6CFC0";
const target = { shopId, managementCode, title: "対象商品",
  priceYen: 99_999 };
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
const hashRow = value => createHash("sha256").update(JSON.stringify({
  node: rowOf(value).node, item: value })).digest("hex");
const baselineFor = values => ({ schemaVersion: 1,
  kind: "B005396_DRAFT_BASELINE", shopId, rowCount: values.length,
  rows: values.map(value => ({ draftId: value.id,
    fingerprint: hashRow(value) })).sort((a, b) =>
      a.draftId < b.draftId ? -1 : a.draftId > b.draftId ? 1 : 0),
  observedAt: new Date().toISOString() });
const reviewedOwn = { description: "対象説明", categoryId: "cat1",
  condition: "NO_NOTABLE_DAMAGE", quantity: 1, imageCount: 1,
  shipping: { method: "METHOD_TYPE_UNDECIDED",
    payer: "PAYER_TYPE_SELLER", origin: "jp11",
    duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" } };
function ownItem(id = "draft1") {
  const own = item(id, target.title, managementCode, target.priceYen);
  own.description = reviewedOwn.description;
  own.condition.id = reviewedOwn.condition;
  own.categories = [{ id: reviewedOwn.categoryId }];
  own.thumbnails = [{}];
  own.shippingMethodType.id = reviewedOwn.shipping.method;
  own.shippingDurationType.id = reviewedOwn.shipping.duration;
  own.shippingFromState = { id: reviewedOwn.shipping.origin };
  return own;
}
function proof({ first = item("draft1", "別の商品", "OTHER_1", 20_000),
  second = item("draft2", "", "", 0), domRows = rows,
  list = null, detailReadCounts = null, ownDraftId = null,
  reviewed = null, baseline = null } = {}) {
  const details = new Map([["draft1", entry(first)],
    ["draft2", entry(second)]]);
  return evaluateBoundDraftReadProof({ list: list ?? [rowOf(first), rowOf(second)],
    details, failed: false, rows: domRows, ...target, expectedRowCount: 2,
    listReadCount: 2, detailReadCounts: detailReadCounts ??
      new Map([["draft1", 2], ["draft2", 2]]), ownDraftId, reviewed,
      baseline });
}

test("two fresh bound reads of every draft establish only an advisory no match", () => {
  const result = proof();
  assert.equal(result.status, "DRAFT_NETWORK_BOUND_NO_MATCH");
  assert.equal(result.complete, true);
  assert.equal(result.allowFinalCreate, false);
  assert.equal(result.rowCount, 2);
  assert.equal(result.anonymousVerified, 1);
  assert.equal(exactDraftBaseline(result.baseline, shopId, 2), true);
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

test("a later uncompleted read blocks after two successful reads", () => {
  const good = { kind: "DETAIL", complete: true,
    requests: [{ state: "SUCCESS" }] };
  assert.equal(exactCompletedReadCycles([good, good]), true);
  assert.equal(exactCompletedReadCycles([good, good, { kind: "DETAIL",
    complete: false, requests: [{ state: "PENDING" }] }]), false);
  assert.equal(exactCompletedReadCycles([good, good, { kind: "DETAIL",
    complete: true, requests: [{ state: "FAILED" }] }]), false);
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
  const own = ownItem();
  const domRows = [{ draftId: "draft1", title: target.title,
    skuCode: managementCode }, rows[1]];
  const second = item("draft2", "", "", 0);
  const baseline = baselineFor([second]);
  assert.equal(proof({ first: own, second, domRows, ownDraftId: "draft1",
    reviewed: reviewedOwn, baseline }).status,
  "DRAFT_NETWORK_BOUND_NO_OTHER_MATCH");
  own.description = "変化した説明";
  assert.equal(proof({ first: own, second, domRows, ownDraftId: "draft1",
    reviewed: reviewedOwn, baseline }).status,
  "DRAFT_NETWORK_BOUND_UNVERIFIED");
});

test("initial twelve cannot become own draft plus another new draft", () => {
  const initial = Array.from({ length: 12 }, (_, index) =>
    item(`prior${String(index).padStart(2, "0")}`,
      `別の商品${index}`, `OTHER_${index}`, 1000 + index));
  const baseline = baselineFor(initial);
  const current = [...initial, ownItem("claimDraft"),
    item("unrelatedNew", "別の新規", "OTHER_NEW", 1000)];
  assert.equal(evaluateBoundDraftReadProof({
    list: current.map(rowOf), details: new Map(current.map(value =>
      [value.id, entry(value)])), failed: false,
    rows: current.map(value => ({ draftId: value.id, title: value.name,
      skuCode: value.variants[0].skuCode })),
    ...target, expectedRowCount: 14, listReadCount: 2,
    detailReadCounts: new Map(current.map(value => [value.id, 2])),
    ownDraftId: "claimDraft", reviewed: reviewedOwn, baseline,
  }).diagnostic, "DRAFT_BASELINE_UNVERIFIED");
});

test("a changed description on an existing ID breaks the fixed baseline", () => {
  const old = item("prior", "別の商品", "OTHER_1", 20_000);
  const baseline = baselineFor([old]);
  const changed = structuredClone(old);
  changed.description = "changed after initial read";
  const own = ownItem("claimDraft");
  assert.equal(evaluateBoundDraftReadProof({ list: [rowOf(changed), rowOf(own)],
    details: new Map([[changed.id, entry(changed)], [own.id, entry(own)]]),
    failed: false, rows: [
      { draftId: changed.id, title: changed.name,
        skuCode: changed.variants[0].skuCode },
      { draftId: own.id, title: own.name,
        skuCode: own.variants[0].skuCode }],
    ...target, expectedRowCount: 2, listReadCount: 2,
    detailReadCounts: new Map([[changed.id, 2], [own.id, 2]]),
    ownDraftId: own.id, reviewed: reviewedOwn, baseline,
  }).diagnostic, "DRAFT_BASELINE_CHANGED");
});
