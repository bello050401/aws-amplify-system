import assert from "node:assert/strict";
import test from "node:test";
import { buildOfficialSkuLookupPage, inspectOfficialSkuLookupPage,
  OFFICIAL_API_ENDPOINT, scanOfficialSkuLookupPages } from "../src/officialSkuLookup.mjs";

const page = (edges, hasNextPage = false, endCursor = null) => ({ data: { products: {
  edges, pageInfo: { hasNextPage, endCursor },
} } });
const product = (id, skuCode) => ({ node: { id, variants: [{ skuCode }] } });

test("SKU lookup builds only a documented read query for the official endpoint", () => {
  const first = buildOfficialSkuLookupPage("NEW_SKU_1");
  assert.equal(first.endpoint, OFFICIAL_API_ENDPOINT);
  assert.equal(first.method, "POST");
  assert.match(first.query, /^query BelloProductsBySku/);
  assert.equal(first.query.includes("mutation"), false);
  assert.deepEqual(first.variables, { keyword: "NEW_SKU_1", after: null, first: 100 });
  assert.equal(buildOfficialSkuLookupPage("NEW_SKU_1", "cursor2").variables.after, "cursor2");
  assert.throws(() => buildOfficialSkuLookupPage("bad sku"));
  assert.throws(() => buildOfficialSkuLookupPage({ toString: () => "NEW_SKU_1" }));
});

test("exact SKU on any page blocks a new listing even when other product names match", () => {
  const result = inspectOfficialSkuLookupPage(page([
    product("unrelated", "OTHER_SKU"), product("existing", "NEW_SKU_1"),
  ]), "NEW_SKU_1");
  assert.deepEqual(result, { status: "FOUND", productId: "existing", nextCursor: null });
});

test("SKU absence is established only on a complete valid last page", () => {
  assert.deepEqual(inspectOfficialSkuLookupPage(page([product("other", "OTHER_SKU")],
    true, "cursor2"), "NEW_SKU_1"),
  { status: "NEXT_PAGE", productId: null, nextCursor: "cursor2" });
  assert.deepEqual(inspectOfficialSkuLookupPage(page([], false), "NEW_SKU_1", ["cursor2"]),
    { status: "FINAL_PAGE_NO_MATCH", productId: null, nextCursor: null });
  assert.deepEqual(scanOfficialSkuLookupPages([
    { requestedAfter: null, body: page([product("other", "OTHER_SKU")], true, "cursor2") },
    { requestedAfter: "cursor2", body: page([], false) },
  ], "NEW_SKU_1"),
  { status: "ABSENT_ON_COMPLETE_SCAN", productId: null, nextCursor: null });
  assert.deepEqual(scanOfficialSkuLookupPages([
    { requestedAfter: null, body: page([product("other", "OTHER_SKU")], true, "cursor2") },
  ], "NEW_SKU_1"),
  { status: "INCOMPLETE", productId: null, nextCursor: "cursor2" });
});

test("a later page alone or a skipped cursor cannot certify absence", () => {
  assert.deepEqual(scanOfficialSkuLookupPages([
    { requestedAfter: "cursor2", body: page([], false) },
  ], "NEW_SKU_1").status, "UNVERIFIED");
  assert.deepEqual(scanOfficialSkuLookupPages([
    { requestedAfter: null, body: page([], true, "cursor2") },
    { requestedAfter: "otherCursor", body: page([], false) },
  ], "NEW_SKU_1").status, "UNVERIFIED");
  assert.deepEqual(scanOfficialSkuLookupPages([
    { requestedAfter: null, body: page([product("existing", "NEW_SKU_1")], true, "cursor2") },
    { requestedAfter: "cursor2", body: page([], false) },
  ], "NEW_SKU_1").status, "UNVERIFIED");
});

test("errors, malformed rows, repeated cursors and ambiguous duplicate IDs stay unverified", () => {
  const cases = [
    { ...page([]), errors: [{ message: "do-not-store" }] },
    page([{ node: { id: "x" } }]),
    page([], true, "cursor2"),
    page([product("one", "NEW_SKU_1"), product("two", "NEW_SKU_1")]),
    page([{ node: { id: undefined, variants: [{ skuCode: "NEW_SKU_1" }] } }]),
    page([{ node: { id: null, variants: [{ skuCode: "NEW_SKU_1" }] } }]),
    page([{ node: { id: { toString: () => "valid" }, variants: [{ skuCode: "NEW_SKU_1" }] } }]),
  ];
  for (const [index, body] of cases.entries()) {
    const result = inspectOfficialSkuLookupPage(body, "NEW_SKU_1",
      index === 2 ? ["cursor2"] : []);
    assert.deepEqual(result, { status: "UNVERIFIED", productId: null, nextCursor: null });
    assert.equal(JSON.stringify(result).includes("do-not-store"), false);
  }
});
