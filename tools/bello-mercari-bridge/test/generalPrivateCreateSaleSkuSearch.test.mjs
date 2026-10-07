import test from "node:test";
import assert from "node:assert/strict";
import { searchGeneralPrivateCreateSaleSkuReadOnly } from
  "../src/generalPrivateCreateSaleSkuSearch.mjs";
import { scanGeneralPrivateCreateNormalUiReadOnly } from
  "../src/generalPrivateCreateNormalUiScan.mjs";

const shopId = "exampleShop";
const managementCode = "TARGET_123";
const positiveControlPrefix = "B00";
const baseUrl = `https://mercari-shops.com/seller/shops/${shopId}/products?tab=on_sale`;
const url = query => `${baseUrl}&keyword=${query}`;
const detailUrl = `https://mercari-shops.com/seller/shops/${shopId}/products/exampleId/edit`;

function searchView(query, kind, overrides = {}) {
  const positive = kind === "positive";
  return { url: url(query), documentUrl: url(query), query, queryCount: 1,
    loading: false, statusChipExact: true, visibilityChipExact: true,
    tableMatches: 1, tableIndex: 0, headerCount: 10, titleColumn: 0,
    rows: positive ? [{ cellCount: 10, signature: "visible-row",
      dataActionCount: 0, menuControlsVerified: true }] : [],
    emptyCount: positive ? 0 : 1,
    nonProductRowCount: positive ? 0 : 1,
    nextCount: positive ? 1 : 0, prevCount: positive ? 1 : 0,
    prevDisabled: positive ? true : null, ...overrides };
}

function fakeUi({ exactViews = [], controlViews = [], detail = {} } = {}) {
  let query = null;
  let exactReads = 0;
  let controlReads = 0;
  const calls = [];
  return { calls,
    goto: async target => { assert.equal(target, baseUrl); calls.push("goto"); },
    search: async value => { query = value; calls.push(`search:${value}`); },
    searchSnapshot: async () => {
      if (query === positiveControlPrefix) {
        controlReads++;
        return controlViews.shift() ?? searchView(query, "positive");
      }
      exactReads++;
      return exactViews.shift() ?? searchView(query, "empty");
    },
    clickControlRow: async index => { assert.equal(index, 0); calls.push("open-control"); },
    controlDetail: async () => ({ url: detailUrl, documentUrl: detailUrl,
      loading: false, skuFieldCount: 1, skuCode: "B00199", ...detail }),
    wait: async ms => { assert.equal(ms, 600); calls.push("wait"); },
    reads: () => ({ controlReads, exactReads }),
  };
}

test("positive SKU control and three stable empty reads are advisory only", async () => {
  const noPager = searchView(positiveControlPrefix, "positive",
    { nextCount: 0, prevCount: 0, prevDisabled: null });
  const adapter = fakeUi({ controlViews: [noPager, noPager, noPager] });
  const result = await searchGeneralPrivateCreateSaleSkuReadOnly({ shopId,
    managementCode, positiveControlPrefix, adapter });
  assert.deepEqual(result, { diagnostic: "SALE_SKU_SEARCH_NO_MATCH_OBSERVED",
    allowFinalCreate: false });
  assert.deepEqual(adapter.calls.filter(call => call.startsWith("search:")),
    [`search:${positiveControlPrefix}`, `search:${managementCode}`]);
  assert.equal(adapter.reads().controlReads, 3);
  assert.equal(adapter.reads().exactReads, 3);
  assert.equal(adapter.calls.filter(call => call === "open-control").length, 1);
  assert.equal(JSON.stringify(result).includes(managementCode), false);
});

test("a transient empty state followed by rows cannot count as no match", async () => {
  const adapter = fakeUi({ exactViews: [searchView(managementCode, "empty"),
    searchView(managementCode, "positive")] });
  const result = await searchGeneralPrivateCreateSaleSkuReadOnly({ shopId,
    managementCode, positiveControlPrefix, adapter });
  assert.equal(result.diagnostic, "SALE_SKU_SEARCH_MATCH_POSSIBLE");
  assert.equal(result.allowFinalCreate, false);
});

test("filter, URL, query and loading mismatches reject empty results", async () => {
  for (const field of ["url", "documentUrl", "query", "queryCount",
    "statusChipExact", "visibilityChipExact", "loading", "nextCount",
    "nonProductRowCount"]) {
    const bad = searchView(managementCode, "empty", { [field]:
      field === "loading" ? true : field === "nextCount" ||
      field === "nonProductRowCount" || field === "queryCount" ? 2 :
      field.endsWith("Exact") ? false : "unexpected" });
    const adapter = fakeUi({ exactViews: Array.from({ length: 13 }, () => bad) });
    const result = await searchGeneralPrivateCreateSaleSkuReadOnly({ shopId,
      managementCode, positiveControlPrefix, adapter });
    assert.equal(result.diagnostic, "SALE_SKU_SEARCH_UNVERIFIED", field);
    assert.equal(result.allowFinalCreate, false);
  }
});

test("positive control must display a SKU matching the tested prefix", async () => {
  for (const detail of [{ skuCode: "UNRELATED" },
    { url: "https://example.invalid/private", documentUrl: "https://example.invalid/private" },
    { loading: true }]) {
    const adapter = fakeUi({ detail });
    const result = await searchGeneralPrivateCreateSaleSkuReadOnly({ shopId,
      managementCode, positiveControlPrefix, adapter });
    assert.equal(result.diagnostic, "SALE_SKU_SEARCH_CONTROL_UNVERIFIED");
    assert.equal(adapter.calls.some(call => call === `search:${managementCode}`), false);
  }
});

test("invalid input and UI error produce fixed results without private data", async () => {
  const invalid = await searchGeneralPrivateCreateSaleSkuReadOnly({
    shopId: [shopId], managementCode, positiveControlPrefix,
    adapter: fakeUi() });
  assert.equal(invalid.diagnostic, "SALE_SKU_SEARCH_INPUT_UNVERIFIED");
  const readError = await searchGeneralPrivateCreateSaleSkuReadOnly({ shopId,
    managementCode, positiveControlPrefix,
    adapter: { goto: async () => { throw Error("private-data"); } } });
  assert.equal(readError.diagnostic, "SALE_SKU_SEARCH_READ_UNAVAILABLE");
  assert.equal(JSON.stringify(readError).includes("private-data"), false);
});

test("normal scan integrates only allowlisted search results", async () => {
  const first = { url: baseUrl, documentUrl: baseUrl, loading: false,
    statusChipExact: true, visibilityChipExact: true, tableMatches: 1,
    tableIndex: 0, headerCount: 10, titleColumn: 0,
    rows: [{ title: "Other", signature: "other", cellCount: 10,
      dataActionCount: 0, menuControlsVerified: true }],
    nextCount: 1, prevCount: 1, nextDisabled: false, prevDisabled: true };
  const last = { ...first, rows: [{ ...first.rows[0], title: "Another",
    signature: "another" }], nextDisabled: true, prevDisabled: false };
  let page = 0;
  const adapter = { gotoSale: async () => {}, saleSnapshot: async () =>
    page === 0 ? first : last, clickNext: async () => { page++; },
  wait: async () => {} };
  const options = { shopId, managementCode, positiveControlPrefix,
    title: "Target", adapter, expectedDraftRowCount: 12,
    collectDrafts: async () => ({ status: "DRAFT_DETAILS_DOM_OBSERVED",
      rows: Array.from({ length: 12 }, () => ({ title: "", skuCode: null })),
      allowFinalCreate: false }) };
  const observed = await scanGeneralPrivateCreateNormalUiReadOnly({ ...options,
    searchSaleSku: async () => ({ diagnostic: "SALE_SKU_SEARCH_NO_MATCH_OBSERVED",
      allowFinalCreate: false }) });
  assert.deepEqual(observed, { status: "REMOTE_SCAN_INCOMPLETE",
    diagnostic: "SALE_SKU_SEARCH_NO_MATCH_OBSERVED", allowFinalCreate: false });
  page = 0;
  const malicious = await scanGeneralPrivateCreateNormalUiReadOnly({ ...options,
    searchSaleSku: async () => ({ diagnostic: "private-data",
      allowFinalCreate: false }) });
  assert.equal(malicious.diagnostic, "SALE_SKU_SEARCH_RESULT_UNVERIFIED");
  page = 0;
  const changed = await scanGeneralPrivateCreateNormalUiReadOnly({ ...options,
    searchSaleSku: async () => ({ allowFinalCreate: false,
      get diagnostic() { throw Error("private-data"); } }) });
  assert.equal(changed.diagnostic, "SALE_SKU_SEARCH_RESULT_UNVERIFIED");
});
