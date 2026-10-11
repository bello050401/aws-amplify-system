import test from "node:test";
import assert from "node:assert/strict";
import { buildWebHttpDraftJob } from "./webHttpDraftJob.ts";
import { openMercariWebHttpReadOnly } from "./webHttpReadOnlyClient.ts";
import { reconcileReservedWebHttpDraft } from
  "./webHttpDraftSaveReconciliation.ts";

const shopId = "evkhihBFFNn5hukMS9s36H";
const inventoryId = "8f5c2a66-790a-4a35-8896-424b67a0be40";
const ids = ["DraftOne123", "DraftTwo123", "DraftThree123"];
const sku = "BELLO_8F5C2A66790A4A358896424B67A0BE40";
const credentials = { idToken: "private-id", refreshToken: "private-refresh" };
const shipping = { method: "METHOD_TYPE_UNDECIDED", payer: "PAYER_TYPE_SELLER",
  origin: "jp11", duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" };
const pack = { schemaVersion: 1, kind: "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK",
  shopId, inventoryId, draftId: "4771cabe-f2d5-4e5c-93c9-61d67264a2c8",
  draftUpdatedAt: "2026-10-08T01:02:03.000Z", title: "Fixture sofa",
  description: "Fixture description", condition: "NO_NOTABLE_DAMAGE",
  imageRefs: [{ source: "INVENTORY", storageKey: "inventory/front.jpg",
    sortOrder: 0, photoAssetId: null }], priceYen: 99999, quantity: 1,
  categoryId: "furniture_sofa", categoryPath: "家具・インテリア > ソファ",
  brandId: null, brandName: null, managementCode: sku,
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
  requestedBy: job.requestedBy, status: "SEND_CLAIMED_RESULT_UNKNOWN" };
const response = (body, status = 200, cookie = null) => {
  const headers = new Headers();
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(body === null ? null : JSON.stringify(body),
    { status, headers });
};
const page = (draftIds, hasNextPage, endCursor) => ({ data: {
  productDrafts: { pageInfo: { hasNextPage, endCursor },
    edges: draftIds.map(id => ({ node: { id, name: "listing" } })) } } });
const detail = (id, itemSku = "unrelated") => ({ data: {
  productDraft: { id, name: pack.title, description: pack.description,
    price: pack.priceYen, thumbnails: [{ id: "Asset123" }],
    variants: [{ skuCode: itemSku, quantity: 1 }] } } });

async function session({ pages = [page([ids[0], ids[1]], true, "cursor-a"),
  page([ids[2]], false, "cursor-b")],
  skuById = { [ids[0]]: "unrelated", [ids[1]]: sku,
    [ids[2]]: "unrelated" },
  badDetailId = null, authDetailId = null, throwDetailId = null,
  authPage = -1, badPage = -1,
  shopMatched = true, expireOnPage = -1 } = {}) {
  const calls = [];
  let currentMs = 1_000;
  let pageIndex = 0;
  const fetchPort = async (url, init) => {
    if (url.endsWith("/auth/signin/idp"))
      return response({}, 200,
        "id_token=opaque; Path=/; Secure; HttpOnly; Max-Age=60");
    const request = JSON.parse(init.body);
    calls.push(request);
    if (request.operationName === "Self")
      return response({ data: { self: { accountId: "private" } } });
    if (request.operationName === "OwnShops")
      return response({ data: { ownShops: [
        { id: shopMatched ? shopId : "other" }] } });
    if (request.operationName === "productDrafts") {
      const index = pageIndex++;
      if (index === expireOnPage) currentMs = 61_000;
      if (index === authPage) return response(null, 401);
      if (index === badPage) return response({ errors: [{ message: "private" }] });
      return response(pages[index] ?? { data: {} });
    }
    if (request.operationName === "GetProductDraft") {
      const id = request.variables.id;
      if (id === authDetailId) return response(null, 403);
      if (id === throwDetailId) throw Error("read failed");
      return response(detail(id === badDetailId ? "WrongId" : id,
        skuById[id] ?? "unrelated"));
    }
    throw Error("unexpected operation");
  };
  const opened = await openMercariWebHttpReadOnly(credentials,
    { fetchPort, clock: () => currentMs });
  assert.equal(opened.status, "READY");
  return { client: opened.client, calls, pageCount: () => pageIndex };
}

test("all pages and every detail feed read-only reconciliation", async () => {
  const state = await session();
  const result = await reconcileReservedWebHttpDraft(job,
    { getAttempt: async () => attempt }, state.client.reconciliationReadback);
  assert.equal(result.status, "MATCHING_DRAFT_OBSERVED_NO_RESEND");
  assert.equal(result.observedDraftId, ids[1]);
  assert.deepEqual([result.allowCreate, result.allowUpdate,
    result.allowPublish], [false, false, false]);
  assert.deepEqual(state.calls.map(call => call.operationName),
    ["Self", "OwnShops", "productDrafts", "productDrafts",
      "GetProductDraft", "GetProductDraft", "GetProductDraft"]);
  const list = state.calls.filter(call => call.operationName === "productDrafts");
  assert.deepEqual(list.map(call => call.variables),
    [{ shopId, first: 50 }, { shopId, first: 50, cursor: "cursor-a" }]);
  assert.ok(list.every(call => call.query.includes("fragment PageInfo") &&
    call.query.includes("ProductDraftListItem")));
  assert.ok(state.calls.every(call =>
    !["CreateProductDraft", "UpdateProductDraft", "PublishProduct"]
      .includes(call.operationName)));
  assert.equal(JSON.stringify(result).includes("opaque"), false);
});

test("same SKU on separate pages remains a duplicate, never a resend", async () => {
  const state = await session({ skuById: {
    [ids[0]]: sku, [ids[1]]: "unrelated", [ids[2]]: sku } });
  const result = await reconcileReservedWebHttpDraft(job,
    { getAttempt: async () => attempt }, state.client.reconciliationReadback);
  assert.equal(result.status, "MULTIPLE_DRAFTS_NO_RESEND");
  assert.equal(result.observedDraftId, null);
  assert.equal(result.allowCreate, false);
});

test("incomplete pages, cursor loops and malformed detail never reconcile", async () => {
  for (const options of [
    { badPage: 1 },
    { pages: [page([ids[0]], true, "cursor-a")] },
    { badDetailId: ids[1] },
    { throwDetailId: ids[1] },
    { pages: [page([ids[0]], true, "repeat"),
      page([ids[1]], true, "repeat")] },
    { pages: [page([ids[0]], true, "cursor-a"),
      page([ids[0]], false, "cursor-b")] },
    { pages: [page([ids[0]], true, "")] },
  ]) {
    const state = await session(options);
    const result = await reconcileReservedWebHttpDraft(job,
      { getAttempt: async () => attempt }, state.client.reconciliationReadback);
    assert.equal(result.status, "READ_UNVERIFIED_NO_RESEND");
    assert.equal(result.allowCreate, false);
    assert.equal(result.observedDraftId, null);
  }
});

test("wrong shop, page authentication failure and expired cookie stop safely", async () => {
  const wrong = await session({ shopMatched: false });
  const wrongResult = await reconcileReservedWebHttpDraft(job,
    { getAttempt: async () => attempt }, wrong.client.reconciliationReadback);
  assert.equal(wrongResult.status, "SHOP_UNVERIFIED_NO_RESEND");
  assert.equal(wrong.pageCount(), 0);

  const auth = await session({ authPage: 1 });
  const authResult = await reconcileReservedWebHttpDraft(job,
    { getAttempt: async () => attempt }, auth.client.reconciliationReadback);
  assert.equal(authResult.status, "AUTH_REQUIRED_NO_RESEND");

  const detailAuth = await session({ authDetailId: ids[1] });
  const detailAuthResult = await reconcileReservedWebHttpDraft(job,
    { getAttempt: async () => attempt },
    detailAuth.client.reconciliationReadback);
  assert.equal(detailAuthResult.status, "AUTH_REQUIRED_NO_RESEND");

  const expired = await session({ expireOnPage: 0 });
  const expiredResult = await reconcileReservedWebHttpDraft(job,
    { getAttempt: async () => attempt }, expired.client.reconciliationReadback);
  assert.equal(expiredResult.status, "READ_UNVERIFIED_NO_RESEND");
  assert.equal(expiredResult.allowCreate, false);
});
