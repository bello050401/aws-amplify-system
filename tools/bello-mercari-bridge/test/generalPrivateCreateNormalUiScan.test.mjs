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
  allVisibilitySelected = true } = {}) {
  return { url: saleUrl, documentUrl: saleUrl, loading: false,
    allVisibilitySelected, tableMatches: 1, tableIndex: 0,
    headerCount: 2, titleColumn: 0, nextCount: 1, prevCount: 1,
    nextDisabled, prevDisabled,
    rows: titles.map(value => ({ title: value, signature: JSON.stringify([value, "1"]),
      cellCount: 2, interactiveCount: 0 })) };
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
    snapshot(["Other item"], { nextDisabled: true, prevDisabled: true }),
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
    snapshot(["Other item"], { nextDisabled: true, prevDisabled: true }),
  ]);
  const result = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
    adapter, collectDrafts: emptyDrafts });
  assert.deepEqual(result, { status: "REMOTE_SCAN_INCOMPLETE",
    diagnostic: "SALE_SKU_UNVERIFIED", allowFinalCreate: false });
});

test("unstable pagination and unproved visibility fail closed", async () => {
  const first = snapshot(["first"], { nextDisabled: false, prevDisabled: true });
  const second = snapshot(["second"], { nextDisabled: true, prevDisabled: false });
  const stuck = fakeAdapter([first, second], { stuck: true });
  const unchanged = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
    adapter: stuck, collectDrafts: emptyDrafts });
  assert.equal(unchanged.status, "REMOTE_SCAN_INCOMPLETE");
  assert.equal(unchanged.diagnostic, "SALE_PAGINATION_UNVERIFIED");
  assert.equal(stuck.calls().nextClicks, 1);
  const hiddenFilter = fakeAdapter([snapshot(["other"], {
    nextDisabled: true, prevDisabled: true, allVisibilitySelected: false })]);
  const filtered = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
    adapter: hiddenFilter, collectDrafts: emptyDrafts });
  assert.equal(filtered.diagnostic, "SALE_TABLE_UNVERIFIED");
  assert.equal(hiddenFilter.calls().nextClicks, 0);
});

test("draft collector failure, read error and invalid input are fixed failures", async () => {
  const page = snapshot(["other"], { nextDisabled: true, prevDisabled: true });
  const unverified = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
    adapter: fakeAdapter([page]), collectDrafts: async () =>
      ({ status: "DRAFT_LIST_UNVERIFIED", rows: [], allowFinalCreate: false }) });
  assert.equal(unverified.diagnostic, "DRAFT_UNVERIFIED");
  const unavailable = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
    adapter: { gotoSale: async () => { throw Error("private token"); } },
    collectDrafts: emptyDrafts });
  assert.equal(unavailable.diagnostic, "UI_READ_UNAVAILABLE");
  assert.equal(JSON.stringify(unavailable).includes("private token"), false);
  const invalid = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
    shopId: [shopId], adapter: fakeAdapter([page]), collectDrafts: emptyDrafts });
  assert.equal(invalid.diagnostic, "INPUT_UNVERIFIED");
});

test("default browser adapter only navigates and reads the normal UI", async () => {
  const calls = [];
  const page = {
    goto: async (url, options) => { calls.push("goto");
      assert.equal(url, saleUrl);
      assert.equal(options.waitUntil, "domcontentloaded"); },
    url: () => saleUrl,
    locator: selector => { assert.equal(selector, "body");
      return { evaluate: async () => { calls.push("read-body");
        const { url, ...data } = snapshot(["Other item"],
          { nextDisabled: true, prevDisabled: true });
        return data;
      } }; },
    waitForTimeout: async ms => { assert.equal(ms, 600); },
  };
  const result = await scanGeneralPrivateCreateNormalUiReadOnly({ ...input,
    page, collectDrafts: emptyDrafts });
  assert.equal(result.diagnostic, "SALE_SKU_UNVERIFIED");
  assert.deepEqual(calls, ["goto", "read-body", "read-body", "read-body"]);
});
