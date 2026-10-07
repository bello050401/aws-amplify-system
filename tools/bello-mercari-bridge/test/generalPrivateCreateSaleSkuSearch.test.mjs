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
    emptyShapeExact: !positive,
    nonProductRowCount: positive ? 0 : 2,
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
    [`search:${positiveControlPrefix}`, `search:${managementCode}`,
      `search:${managementCode}`]);
  assert.equal(adapter.reads().controlReads, 3);
  assert.equal(adapter.reads().exactReads, 6);
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

test("a product appearing on the second independent query blocks a negative result", async () => {
  const empty = searchView(managementCode, "empty");
  const found = searchView(managementCode, "positive", {
    nextCount: 0, prevCount: 0, prevDisabled: null });
  const adapter = fakeUi({ exactViews: [empty, empty, empty, found] });
  const result = await searchGeneralPrivateCreateSaleSkuReadOnly({ shopId,
    managementCode, positiveControlPrefix, adapter });
  assert.equal(result.diagnostic, "SALE_SKU_SEARCH_MATCH_POSSIBLE");
  assert.equal(adapter.calls.filter(call => call === `search:${managementCode}`).length, 2);
});

test("filter, URL, query and loading mismatches reject empty results", async () => {
  for (const field of ["url", "documentUrl", "query", "queryCount",
    "statusChipExact", "visibilityChipExact", "loading", "nextCount",
    "nonProductRowCount", "emptyShapeExact"]) {
    const bad = searchView(managementCode, "empty", { [field]:
      field === "loading" ? true : field === "emptyShapeExact" ? false :
      field === "nextCount" || field === "queryCount" ? 2 :
      field === "nonProductRowCount" ? 3 :
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
  assert.equal(readError.diagnostic, "SALE_SKU_SEARCH_NAVIGATION_UNAVAILABLE");
  assert.equal(JSON.stringify(readError).includes("private-data"), false);
});

test("read errors reveal only the failed stage, never the exception", async () => {
  const cases = [
    [{ search: async () => { throw Error("private-control"); } },
      "SALE_SKU_SEARCH_CONTROL_LOOKUP_UNAVAILABLE"],
    [{ search: async (_query, markStage) => {
      markStage("SALE_SKU_SEARCH_CONTROL_ACTION_UNAVAILABLE");
      throw Error("private-action");
    } }, "SALE_SKU_SEARCH_CONTROL_ACTION_UNAVAILABLE"],
    [{ searchSnapshot: async () => { throw Error("private-dom"); } },
      "SALE_SKU_SEARCH_DOM_READ_UNAVAILABLE"],
    [{ clickControlRow: async () => { throw Error("private-row"); } },
      "SALE_SKU_SEARCH_CONTROL_ROW_CLICK_UNAVAILABLE"],
    [{ controlDetail: async () => { throw Error("private-detail"); } },
      "SALE_SKU_SEARCH_DOM_READ_UNAVAILABLE"],
  ];
  for (const [override, diagnostic] of cases) {
    const adapter = { ...fakeUi(), ...override };
    const result = await searchGeneralPrivateCreateSaleSkuReadOnly({ shopId,
      managementCode, positiveControlPrefix, adapter });
    assert.deepEqual(result, { diagnostic, allowFinalCreate: false });
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
});

test("browser adapter reports only fixed search-control counts or lookup exception", async () => {
  let textboxCount = 1;
  let buttonCount = 1;
  let lookupThrows = false;
  const textbox = { count: async () => textboxCount,
    waitFor: async () => {},
    fill: async () => { throw Error("private-fill"); } };
  const page = { goto: async () => {},
    getByRole: role => {
      if (lookupThrows) throw Error("private-lookup");
      return { count: async () => buttonCount, click: async () => {} };
    },
    locator: selector => {
      if (lookupThrows) throw Error("private-lookup");
      assert.equal(selector, 'input[placeholder*="商品管理コード"]');
      return textbox;
    } };
  const options = { page, shopId, managementCode, positiveControlPrefix };
  for (const [textboxes, buttons, expected] of [
    [0, 1, "SALE_SKU_SEARCH_TEXTBOX_ZERO"],
    [2, 1, "SALE_SKU_SEARCH_TEXTBOX_MULTIPLE"],
    [1, 0, "SALE_SKU_SEARCH_BUTTON_ZERO"],
    [1, 2, "SALE_SKU_SEARCH_BUTTON_MULTIPLE"],
  ]) {
    textboxCount = textboxes;
    buttonCount = buttons;
    const result = await searchGeneralPrivateCreateSaleSkuReadOnly(options);
    assert.deepEqual(result, { diagnostic: expected, allowFinalCreate: false });
  }
  textboxCount = 1;
  buttonCount = 1;
  lookupThrows = true;
  const lookup = await searchGeneralPrivateCreateSaleSkuReadOnly(options);
  assert.equal(lookup.diagnostic, "SALE_SKU_SEARCH_CONTROL_LOOKUP_UNAVAILABLE");
  assert.equal(JSON.stringify(lookup).includes("private-lookup"), false);
  lookupThrows = false;
  let hydrated = false;
  textboxCount = 0;
  textbox.waitFor = async () => { textboxCount = 1; hydrated = true; };
  const afterHydration = await searchGeneralPrivateCreateSaleSkuReadOnly(options);
  assert.equal(hydrated, true);
  assert.equal(afterHydration.diagnostic,
    "SALE_SKU_SEARCH_CONTROL_ACTION_UNAVAILABLE");
  const fillFailure = await searchGeneralPrivateCreateSaleSkuReadOnly(options);
  assert.equal(fillFailure.diagnostic, "SALE_SKU_SEARCH_CONTROL_ACTION_UNAVAILABLE");
  assert.equal(JSON.stringify(fillFailure).includes("private-fill"), false);
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
  for (const diagnostic of ["SALE_SKU_SEARCH_NAVIGATION_UNAVAILABLE",
    "SALE_SKU_SEARCH_CONTROL_LOOKUP_UNAVAILABLE",
    "SALE_SKU_SEARCH_TEXTBOX_ZERO", "SALE_SKU_SEARCH_TEXTBOX_MULTIPLE",
    "SALE_SKU_SEARCH_BUTTON_ZERO", "SALE_SKU_SEARCH_BUTTON_MULTIPLE",
    "SALE_SKU_SEARCH_CONTROL_ACTION_UNAVAILABLE",
    "SALE_SKU_SEARCH_DOM_READ_UNAVAILABLE",
    "SALE_SKU_SEARCH_CONTROL_ROW_CLICK_UNAVAILABLE"]) {
    page = 0;
    const staged = await scanGeneralPrivateCreateNormalUiReadOnly({ ...options,
      searchSaleSku: async () => ({ diagnostic, allowFinalCreate: false }) });
    assert.deepEqual(staged, { status: "REMOTE_SCAN_INCOMPLETE", diagnostic,
      allowFinalCreate: false });
  }
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

test("browser adapter reads the observed table through locator.evaluate(element, arg)", async () => {
  const originalDocument = globalThis.document;
  const headers = ["商品名", "", "公開設定", "価格", "在庫", "いいね!",
    "閲覧", "作成日時", "更新日時", ""];
  const textNode = textContent => ({ textContent });
  const menu = prefix => ({ tagName: "BUTTON",
    getAttribute: name => name === "data-testid" ? `${prefix}exampleId` : null });
  const productCells = Array.from({ length: 10 }, (_, index) => ({
    textContent: index === 1 ? "Known control" : "",
    matches: () => false,
    querySelectorAll: () => index === 9 ? [
      menu("product-menu-button-"), menu("copy-product-menu-item-"),
      menu("product-page-menu-item-")] : [],
  }));
  const productRow = { textContent: "Known control",
    querySelectorAll: selector => selector === ":scope > td" ? productCells : [] };
  const blankRow = { textContent: "",
    querySelectorAll: selector => selector === ":scope > td" ? [textNode("")] : [] };
  const emptyRow = { textContent: "現在、登録している商品はありません",
    querySelectorAll: selector => selector === ":scope > td" ?
      [textNode("現在、登録している商品はありません")] : [] };
  let currentUrl = baseUrl;
  let query = "";
  const actions = [];
  const table = { querySelectorAll: selector => selector === "thead th" ?
    headers.map(textNode) : selector === "tbody tr" ?
      currentUrl === url(positiveControlPrefix) ? [productRow] :
      currentUrl === url(managementCode) ? [blankRow, emptyRow] : [] : [] };
  globalThis.document = { location: { get href() { return currentUrl; } },
    querySelector: () => null,
    querySelectorAll: selector => {
      if (selector === "table") return [table];
      if (selector === '[data-testid="pagination-next-button"]' ||
          selector === '[data-testid="pagination-prev-button"]') return [];
      if (selector === 'button[data-testid="product-status-chip"]')
        return [textNode("ステータス: 出品中")];
      if (selector === 'button[data-testid="visibility-chip"]')
        return [textNode("公開状態: すべて")];
      if (selector === 'input[name="variants.0.skuCode"]')
        return currentUrl === detailUrl ? [{ value: "B00199" }] : [];
      return [];
    } };
  const textbox = { count: async () => 1,
    fill: async value => { query = value; actions.push("search-fill"); },
    evaluate: async (callback, arg) => callback({ value: query }, arg) };
  const button = { count: async () => 1,
    click: async () => { currentUrl = url(query); actions.push("search-click"); } };
  const page = { goto: async target => { currentUrl = target; actions.push("goto"); },
    url: () => currentUrl,
    getByRole: (role, options) => role === "textbox" ?
      { count: async () => 0 } :
      role === "button" && options.name === "search" &&
        options.exact === undefined ? button :
        { count: async () => 0 },
    locator: selector => selector === 'input[placeholder*="商品管理コード"]' ?
      textbox : selector === "body" ?
      { evaluate: async (callback, arg) => callback({}, arg) } :
      selector === "table" ? { nth: index => {
        assert.equal(index, 0);
        return { locator: child => { assert.equal(child, "tbody tr");
          return { first: () => ({ click: async () => {
            currentUrl = detailUrl; actions.push("open-control"); } }) }; } };
      } } : { count: async () => 0 },
    waitForTimeout: async ms => { assert.equal(ms, 600); },
  };
  try {
    assert.equal(await page.getByRole("textbox",
      { name: "商品管理コード（前方一致）、商品名検索" }).count(), 0);
    assert.equal(await page.locator('input[placeholder*="商品管理コード"]').count(), 1);
    const result = await searchGeneralPrivateCreateSaleSkuReadOnly({ page,
      shopId, managementCode, positiveControlPrefix });
    assert.equal(result.diagnostic, "SALE_SKU_SEARCH_NO_MATCH_OBSERVED");
    assert.equal(result.allowFinalCreate, false);
    assert.equal(actions.filter(action => action === "open-control").length, 1);
    assert.equal(actions.filter(action => action === "search-click").length, 3);
    assert.equal(actions.filter(action => action === "search-fill").length, 3);
  } finally { globalThis.document = originalDocument; }
});
