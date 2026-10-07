import test from "node:test";
import assert from "node:assert/strict";
import { scanGeneralPrivateCreateNormalUiReadOnly } from
  "../src/generalPrivateCreateNormalUiScan.mjs";

const shopId = "evkhihBFFNn5hukMS9s36H";
const title = "Target TV Board";
const managementCode = "B005413-PRIVATE-TEST";
const saleUrl = `https://mercari-shops.com/seller/shops/${shopId}/products?tab=on_sale`;
const input = { shopId, title, managementCode, expectedDraftRowCount: 12 };

function snapshot(titles, { nextDisabled, prevDisabled,
  statusChipExact = true, visibilityChipExact = true } = {}) {
  return { url: saleUrl, documentUrl: saleUrl, loading: false,
    statusChipExact, visibilityChipExact, tableMatches: 1, tableIndex: 0,
    headerCount: 10, titleColumn: 0, nextCount: 1, prevCount: 1,
    nextDisabled, prevDisabled,
    rows: titles.map(value => ({ title: value,
      signature: JSON.stringify(["image", value, "1"]),
      cellCount: 10, dataActionCount: 0, menuControlsVerified: true })) };
}

function fakeAdapter(pages, { transient = false, stuck = false } = {}) {
  let pageIndex = 0;
  let afterNextReads = 0;
  let nextClicks = 0;
  let navigations = 0;
  let waits = 0;
  return {
    gotoSale: async url => { assert.equal(url, saleUrl); navigations++; },
    saleSnapshot: async () => {
      if (stuck && pageIndex > 0) return pages[0];
      if (transient && pageIndex > 0 && afterNextReads++ < 2)
        return snapshot(Array.from({ length: 51 }, (_, i) => `stale-${i}`),
          { nextDisabled: true, prevDisabled: true });
      return pages[pageIndex];
    },
    clickNext: async () => { nextClicks++; pageIndex++; },
    wait: async ms => { assert.equal(ms, 600); waits++; },
    calls: () => ({ nextClicks, navigations, waits }),
  };
}

const drafts = rows => async () => ({ status: "DRAFT_DETAILS_DOM_OBSERVED",
  rows, allowFinalCreate: false });
const emptyDrafts = drafts(Array.from({ length: 12 }, () =>
  ({ title: "", skuCode: null })));

function domButton(testId, role = null, ariaLabel = null) {
  return { tagName: "BUTTON", innerText: "", textContent: "",
    getAttribute: name => name === "data-testid" ? testId :
      name === "role" ? role : name === "aria-label" ? ariaLabel : null };
}

function domTable(title, { dataButton = false, unknownMenu = false,
  mismatchedSuffix = false, dataCellRoleButton = false,
  menuCellContentEditable = false, wrongHeader = false } = {}) {
  const headerTexts = ["商品名", "", "公開設定", "価格", "在庫", "いいね!",
    "閲覧", "作成日時", "更新日時", ""];
  if (wrongHeader) headerTexts[2] = "unexpected heading";
  const headers = headerTexts.map(textContent => ({ textContent }));
  const suffix = "hiddenRemoteId";
  const menuButtons = [
    domButton(`product-menu-button-${suffix}`, null, "メニュー"),
    domButton(`copy-product-menu-item-${mismatchedSuffix ? "anotherId" : suffix}`,
      "menuitem"),
    domButton(unknownMenu ? `unexpected-${suffix}` :
      `product-page-menu-item-${suffix}`, "menuitem"),
  ];
  const cells = Array.from({ length: 10 }, (_, i) => ({
    textContent: i === 1 ? title : i === 0 ? "image" : "",
    matches: selector => i === 1 && dataCellRoleButton &&
      selector.includes('[role="button"]') ||
      i === 9 && menuCellContentEditable &&
      selector.includes('[contenteditable="true"]'),
    querySelectorAll: () => i === 9 ? menuButtons :
      i === 1 && dataButton ? [domButton("unexpected-data-action")] : [],
  }));
  const row = { querySelectorAll: selector =>
    selector === ":scope > td" ? cells : [] };
  return { querySelectorAll: selector => selector === "thead th" ? headers :
    selector === "tbody tr" ? [row] : [] };
}

test("normal UI scan waits through stale 51 rows and detects a later-page title", async () => {
  const adapter = fakeAdapter([
    snapshot(["Other item"], { nextDisabled: false, prevDisabled: true }),
    snapshot([title], { nextDisabled: true, prevDisabled: false }),
  ], { transient: true });
  const result = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
    adapter, collectDrafts: async () => { throw Error("Duplicate stops early"); } });
  assert.deepEqual(result, { status: "REMOTE_DUPLICATE_POSSIBLE",
    diagnostic: "SALE_TITLE_MATCH", allowFinalCreate: false });
  assert.equal(adapter.calls().nextClicks, 1);
  assert.equal(adapter.calls().navigations, 1);
  assert.ok(adapter.calls().waits >= 6);
  assert.equal(JSON.stringify(result).includes(title), false);
});

test("draft detail SKU match is advisory and never permits create", async () => {
  const adapter = fakeAdapter([
    snapshot(["Other item"], { nextDisabled: false, prevDisabled: true }),
    snapshot(["Another item"], { nextDisabled: true, prevDisabled: false }),
  ]);
  const rows = Array.from({ length: 12 }, () => ({ title: "", skuCode: null }));
  rows[3] = { title: "Different title", skuCode: managementCode.toLowerCase() };
  const result = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
    adapter, collectDrafts: drafts(rows) });
  assert.equal(result.status, "REMOTE_DUPLICATE_POSSIBLE");
  assert.equal(result.diagnostic, "DRAFT_SKU_MATCH");
  assert.equal(result.allowFinalCreate, false);
  assert.equal(JSON.stringify(result).includes(managementCode), false);
});

test("no visible match remains incomplete because sale SKUs are unverified", async () => {
  const adapter = fakeAdapter([
    snapshot(["Other item"], { nextDisabled: false, prevDisabled: true }),
    snapshot(["Another item"], { nextDisabled: true, prevDisabled: false }),
  ]);
  const result = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
    adapter, collectDrafts: emptyDrafts });
  assert.deepEqual(result, { status: "REMOTE_SCAN_INCOMPLETE",
    diagnostic: "SALE_SKU_UNVERIFIED", allowFinalCreate: false });
});

test("remote list titles of 131 through 500 characters remain readable", async () => {
  for (const length of [131, 500]) {
    const adapter = fakeAdapter([
      snapshot(["x".repeat(length)],
        { nextDisabled: false, prevDisabled: true }),
      snapshot([title], { nextDisabled: true, prevDisabled: false }),
    ]);
    const result = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
      adapter, collectDrafts: async () => { throw Error("Duplicate stops early"); } });
    assert.equal(result.status, "REMOTE_DUPLICATE_POSSIBLE");
    assert.equal(result.diagnostic, "SALE_TITLE_MATCH");
    assert.equal(result.allowFinalCreate, false);
  }
});

test("unstable pagination and unproved visibility fail closed", async () => {
  const first = snapshot(["first"], { nextDisabled: false, prevDisabled: true });
  const second = snapshot(["second"], { nextDisabled: true, prevDisabled: false });
  const stuck = fakeAdapter([first, second], { stuck: true });
  const unchanged = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
    adapter: stuck, collectDrafts: emptyDrafts });
  assert.equal(unchanged.status, "REMOTE_SCAN_INCOMPLETE");
  assert.equal(unchanged.diagnostic, "SALE_ROW_SET_UNCHANGED");
  assert.equal(stuck.calls().nextClicks, 1);
  const hiddenFilter = fakeAdapter([snapshot(["other"], {
    nextDisabled: true, prevDisabled: true, visibilityChipExact: false })]);
  const filtered = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
    adapter: hiddenFilter, collectDrafts: emptyDrafts });
  assert.equal(filtered.diagnostic, "SALE_VISIBILITY_FILTER_UNVERIFIED");
  assert.equal(hiddenFilter.calls().nextClicks, 0);
});

test("draft collector failure, read error and invalid input are fixed failures", async () => {
  const page = snapshot(["other"], { nextDisabled: false, prevDisabled: true });
  const last = snapshot(["different"], { nextDisabled: true, prevDisabled: false });
  const unverified = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
    adapter: fakeAdapter([page, last]), collectDrafts: async () =>
      ({ status: "DRAFT_LIST_UNVERIFIED", rows: [], allowFinalCreate: false }) });
  assert.equal(unverified.diagnostic, "DRAFT_LIST_UNVERIFIED");
  const unavailable = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
    adapter: { gotoSale: async () => { throw Error("private token"); } },
    collectDrafts: emptyDrafts });
  assert.equal(unavailable.diagnostic, "UI_READ_UNAVAILABLE");
  assert.equal(JSON.stringify(unavailable).includes("private token"), false);
  const invalid = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
    shopId: [shopId], adapter: fakeAdapter([page, last]), collectDrafts: emptyDrafts });
  assert.equal(invalid.diagnostic, "INPUT_UNVERIFIED");
});

test("only allowlisted draft collector failures pass through without row data", async () => {
  const salePages = () => fakeAdapter([
    snapshot(["Other first item"], { nextDisabled: false, prevDisabled: true }),
    snapshot(["Other last item"], { nextDisabled: true, prevDisabled: false }),
  ]);
  for (const status of ["DRAFT_INPUT_UNVERIFIED", "DRAFT_LIST_UNVERIFIED",
    "DRAFT_LIST_CHANGED", "DRAFT_DETAIL_UNVERIFIED",
    "DRAFT_READ_UNAVAILABLE"]) {
    const result = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
      adapter: salePages(), collectDrafts: async () =>
        ({ status, rows: [], allowFinalCreate: false }) });
    assert.equal(result.status, "REMOTE_SCAN_INCOMPLETE");
    assert.equal(result.diagnostic, status);
    assert.equal(result.allowFinalCreate, false);
  }
  const invalid = [
    { status: "private-draft-id", rows: [], allowFinalCreate: false },
    { status: "DRAFT_LIST_CHANGED", rows: [{ title: "private title" }],
      allowFinalCreate: false },
    { status: "DRAFT_DETAILS_DOM_OBSERVED", rows: [],
      allowFinalCreate: false },
    { status: "DRAFT_LIST_UNVERIFIED", rows: [], allowFinalCreate: true },
  ];
  for (const value of invalid) {
    const result = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
      adapter: salePages(), collectDrafts: async () => value });
    assert.equal(result.diagnostic, "DRAFT_RESULT_UNVERIFIED");
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
  const thrown = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
    adapter: salePages(), collectDrafts: async () => {
      throw Error("private-draft-id");
    } });
  assert.equal(thrown.diagnostic, "DRAFT_READ_UNAVAILABLE");
  assert.equal(JSON.stringify(thrown).includes("private-draft-id"), false);
  let statusReads = 0;
  const changingStatus = { rows: [], allowFinalCreate: false,
    get status() { statusReads++;
      return statusReads === 1 ? "DRAFT_LIST_CHANGED" : "private-draft-id"; } };
  const changed = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
    adapter: salePages(), collectDrafts: async () => changingStatus });
  assert.equal(statusReads, 1);
  assert.equal(changed.diagnostic, "DRAFT_LIST_CHANGED");
  assert.equal(JSON.stringify(changed).includes("private-draft-id"), false);
  const throwingStatus = { rows: [], allowFinalCreate: false,
    get status() { throw Error("private-draft-id"); } };
  const getterFailure = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
    adapter: salePages(), collectDrafts: async () => throwingStatus });
  assert.equal(getterFailure.diagnostic, "DRAFT_RESULT_UNVERIFIED");
  assert.equal(JSON.stringify(getterFailure).includes("private-draft-id"), false);
});

test("unknown visibility control keeps the default browser adapter unverified", async () => {
  const calls = [];
  const page = {
    goto: async (url, options) => { calls.push("goto");
      assert.equal(url, saleUrl);
      assert.equal(options.waitUntil, "domcontentloaded"); },
    url: () => saleUrl,
    locator: selector => { assert.equal(selector, "body");
      return { evaluate: async () => { calls.push("read-body");
        const { url, ...data } = snapshot(["Other item"],
          { nextDisabled: false, prevDisabled: true,
            visibilityChipExact: false });
        return data;
      } }; },
    waitForTimeout: async ms => { assert.equal(ms, 600); },
  };
  const result = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
    page, collectDrafts: emptyDrafts });
  assert.equal(result.diagnostic, "SALE_VISIBILITY_FILTER_UNVERIFIED");
  assert.equal(calls[0], "goto");
  assert.equal(calls.filter(call => call === "read-body").length, 12);
});

test("first-page both-disabled controls cannot prove the last page", async () => {
  const adapter = fakeAdapter([snapshot(["Other item"],
    { nextDisabled: true, prevDisabled: true })]);
  const result = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
    adapter, collectDrafts: async () => { throw Error("Drafts must not be read"); } });
  assert.equal(result.status, "REMOTE_SCAN_INCOMPLETE");
  assert.equal(result.diagnostic, "SALE_PAGINATION_UNVERIFIED");
  assert.equal(adapter.calls().nextClicks, 0);
});

test("a selected unrelated すべて option is not visibility evidence", async () => {
  const originalDocument = globalThis.document;
  const table = domTable("Other item");
  const next = { disabled: false, getAttribute: () => null };
  const prev = { disabled: true, getAttribute: () => null };
  let unrelatedSeen = false;
  globalThis.document = { location: { href: saleUrl },
    querySelector: () => null,
    querySelectorAll: selector => {
      if (selector === "table") return [table];
      if (selector === '[data-testid="pagination-next-button"]') return [next];
      if (selector === '[data-testid="pagination-prev-button"]') return [prev];
      if (selector === 'button[data-testid="product-status-chip"]')
        return [{ textContent: "ステータス: 出品中" }];
      if (selector === 'button[data-testid="visibility-chip"]')
        return [{ textContent: "公開状態: 非公開" }];
      if (selector === 'button[data-testid="stock-condition-chip"]')
        return [{ textContent: "在庫: すべて" }];
      if (selector.includes("aria-selected") || selector.includes("option:checked")) {
        unrelatedSeen = true;
        return [{ textContent: "すべて", getAttribute: () => "true" }];
      }
      return [];
    } };
  try {
    const page = { goto: async () => {}, url: () => saleUrl,
      locator: selector => { assert.equal(selector, "body");
        return { evaluate: async callback => callback() }; },
      waitForTimeout: async () => {} };
    const result = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
      page, collectDrafts: async () => { throw Error("Must not read drafts"); } });
    assert.equal(result.diagnostic, "SALE_VISIBILITY_FILTER_UNVERIFIED");
    assert.equal(unrelatedSeen, false);
  } finally { globalThis.document = originalDocument; }
});

test("only the exact on-sale status and visibility chips permit list reading", async () => {
  const originalDocument = globalThis.document;
  let pageIndex = 0;
  const names = ["Other first item", "Other second item"];
  const control = disabled => ({ disabled, getAttribute: () => null });
  globalThis.document = { location: { href: saleUrl },
    querySelector: () => null,
    querySelectorAll: selector => {
      if (selector === "table") return [domTable(names[pageIndex])];
      if (selector === '[data-testid="pagination-next-button"]')
        return [control(pageIndex === 1)];
      if (selector === '[data-testid="pagination-prev-button"]')
        return [control(pageIndex === 0)];
      if (selector === 'button[data-testid="product-status-chip"]')
        return [{ textContent: "ステータス: 出品中" }];
      if (selector === 'button[data-testid="visibility-chip"]')
        return [{ textContent: "公開状態: すべて" }];
      if (selector === 'button[data-testid="stock-condition-chip"]')
        return [{ textContent: "在庫: すべて" }];
      return [];
    } };
  try {
    const page = { goto: async () => {}, url: () => saleUrl,
      locator: selector => selector === "body" ?
        { evaluate: async callback => callback() } :
        selector === '[data-testid="pagination-next-button"]' ?
          { click: async () => { pageIndex++; } } :
          { click: async () => { throw Error("Unexpected click"); } },
      waitForTimeout: async () => {} };
    const result = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
      page, collectDrafts: emptyDrafts });
    assert.equal(result.status, "REMOTE_SCAN_INCOMPLETE");
    assert.equal(result.diagnostic, "SALE_SKU_UNVERIFIED");
    assert.equal(pageIndex, 1);
  } finally { globalThis.document = originalDocument; }
});

test("observed header th[0] maps to title td[1] with only known menu buttons", async () => {
  const originalDocument = globalThis.document;
  try {
    for (const [options, expected] of [
      [{}, "SALE_TITLE_MATCH"],
      [{ dataButton: true }, "SALE_DATA_ACTION_UNVERIFIED"],
      [{ unknownMenu: true }, "SALE_MENU_CONTROLS_UNVERIFIED"],
      [{ mismatchedSuffix: true }, "SALE_MENU_CONTROLS_UNVERIFIED"],
      [{ dataCellRoleButton: true }, "SALE_DATA_ACTION_UNVERIFIED"],
      [{ menuCellContentEditable: true }, "SALE_MENU_CONTROLS_UNVERIFIED"],
      [{ wrongHeader: true }, "SALE_TABLE_UNVERIFIED"],
    ]) {
      globalThis.document = { location: { href: saleUrl },
        querySelector: () => null,
        querySelectorAll: selector => {
          if (selector === "table") return [domTable(title, options)];
          if (selector === '[data-testid="pagination-next-button"]')
            return [{ disabled: false, getAttribute: () => null }];
          if (selector === '[data-testid="pagination-prev-button"]')
            return [{ disabled: true, getAttribute: () => null }];
          if (selector === 'button[data-testid="product-status-chip"]')
            return [{ textContent: "ステータス: 出品中" }];
          if (selector === 'button[data-testid="visibility-chip"]')
            return [{ textContent: "公開状態: すべて" }];
          return [];
        } };
      const page = { goto: async () => {}, url: () => saleUrl,
        locator: selector => { assert.equal(selector, "body");
          return { evaluate: async callback => callback() }; },
        waitForTimeout: async () => {} };
      const result = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
        page, collectDrafts: async () => { throw Error("Must not read drafts"); } });
      assert.equal(result.diagnostic, expected);
      assert.equal(result.allowFinalCreate, false);
      assert.equal(JSON.stringify(result).includes("hiddenRemoteId"), false);
    }
  } finally { globalThis.document = originalDocument; }
});

test("sale-list failures return only the expected fixed diagnostic", async () => {
  const base = () => snapshot(["private-title"],
    { nextDisabled: false, prevDisabled: true });
  const changedRow = fields => {
    const view = base();
    view.rows[0] = { ...view.rows[0], ...fields };
    return view;
  };
  const cases = [
    [{ ...base(), url: "https://mercari-shops.com/signin/seller" },
      "AUTH_SCREEN"],
    [{ ...base(), url: "https://example.invalid/private-id" },
      "SALE_URL_UNEXPECTED"],
    [{ ...base(), statusChipExact: false },
      "SALE_STATUS_FILTER_UNVERIFIED"],
    [{ ...base(), visibilityChipExact: false },
      "SALE_VISIBILITY_FILTER_UNVERIFIED"],
    [{ ...base(), tableMatches: 0 }, "SALE_TABLE_UNVERIFIED"],
    [{ ...base(), titleColumn: 1 }, "SALE_TABLE_UNVERIFIED"],
    [{ ...base(), rows: Array.from({ length: 51 }, (_, i) =>
      ({ title: `private-title-${i}`, signature: "[]", cellCount: 10,
        dataActionCount: 0, menuControlsVerified: true })) },
      "SALE_ROW_COUNT_UNVERIFIED"],
    [changedRow({ title: "x".repeat(501) }),
      "SALE_TITLE_LENGTH_UNVERIFIED"],
    [changedRow({ title: " " }), "SALE_TITLE_LENGTH_UNVERIFIED"],
    [changedRow({ title: "読み込み中" }),
      "SALE_TITLE_LENGTH_UNVERIFIED"],
    [changedRow({ cellCount: 9 }), "SALE_CELL_COUNT_UNVERIFIED"],
    [changedRow({ dataActionCount: 1 }), "SALE_DATA_ACTION_UNVERIFIED"],
    [changedRow({ menuControlsVerified: false }),
      "SALE_MENU_CONTROLS_UNVERIFIED"],
    [changedRow({ signature: "x".repeat(3001) }),
      "SALE_SIGNATURE_LENGTH_UNVERIFIED"],
    [{ ...base(), nextCount: 0 },
      "SALE_PAGINATION_CONTROLS_UNVERIFIED"],
    [{ ...base(), nextDisabled: null },
      "SALE_PAGINATION_STATE_UNVERIFIED"],
  ];
  for (const [view, diagnostic] of cases) {
    const result = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
      adapter: fakeAdapter([view]),
      collectDrafts: async () => { throw Error("Must not read drafts"); } });
    assert.equal(result.status, "REMOTE_SCAN_INCOMPLETE");
    assert.equal(result.diagnostic, diagnostic);
    assert.equal(result.allowFinalCreate, false);
    assert.equal(JSON.stringify(result).includes("private-title"), false);
    assert.equal(JSON.stringify(result).includes("private-id"), false);
  }
});
