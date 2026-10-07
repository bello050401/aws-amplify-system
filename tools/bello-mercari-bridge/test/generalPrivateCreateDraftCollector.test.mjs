import test from "node:test";
import assert from "node:assert/strict";
import { collectGeneralPrivateCreateDraftDetailsReadOnly } from
  "../src/generalPrivateCreateDraftCollector.mjs";

const shopId = "evkhihBFFNn5hukMS9s36H";
const listUrl = `https://mercari-shops.com/seller/shops/${shopId}/products?tab=draft`;
const details = [
  { id: "draft-A", title: "Bontempi chair", skuCode: "B005007" },
  { id: "blank-B", title: "", skuCode: "" },
];

function fakeAdapter({ entries = details, mutateList = null,
  mutateDetail = null } = {}) {
  let url = listUrl;
  let listReads = 0;
  const calls = [];
  return { calls,
    adapter: {
      async goto(target) { calls.push(["goto", target]); url = target; },
      async wait(ms) { calls.push(["wait", ms]); },
      async list() {
        calls.push(["list"]);
        listReads++;
        const current = mutateList?.(listReads, entries) ?? entries;
        return { url, documentUrl: url, loading: false,
          paginationControls: 0, tableIndex: 0, headerCount: 10,
          titleColumn: 0, tableMatches: 1,
          rows: current.map(entry => ({ title: entry.title,
            signature: JSON.stringify(["", entry.title, "", "¥0", "0", "", "", "", "", ""]),
            cellCount: 10, interactiveCount: 0 })) };
      },
      async clickRow(tableIndex, index) {
        calls.push(["clickRow", tableIndex, index]);
        url = `https://mercari-shops.com/seller/shops/${shopId}/products/create?productDraftId=${entries[index].id}`;
      },
      async detail() {
        calls.push(["detail"]);
        const id = new URL(url).searchParams.get("productDraftId");
        const entry = entries.find(item => item.id === id);
        const result = { url, documentUrl: url, loading: false,
          nameFieldCount: 1, skuFieldCount: 1,
          title: entry?.title ?? "", skuCode: entry?.skuCode ?? "" };
        return mutateDetail?.(result) ?? result;
      },
    },
  };
}

test("reads a named and blank draft twice without a save/create action", async () => {
  const { adapter, calls } = fakeAdapter();
  const result = await collectGeneralPrivateCreateDraftDetailsReadOnly({
    shopId, expectedRowCount: 2, adapter });
  assert.deepEqual(result, { status: "DRAFT_DETAILS_DOM_OBSERVED",
    rows: [
      { draftId: "draft-A", title: "Bontempi chair", skuCode: "B005007" },
      { draftId: "blank-B", title: "", skuCode: null },
    ], allowFinalCreate: false });
  assert.equal(calls.filter(item => item[0] === "clickRow").length, 4);
  assert.equal(calls.every(item => ["goto", "wait", "list", "clickRow", "detail"]
    .includes(item[0])), true);
});

test("row count or title change prevents a complete result", async () => {
  const count = fakeAdapter({ mutateList: reads => reads >= 4 ?
    [...details, { id: "transient-C", title: "", skuCode: "" }] : details });
  const result = await collectGeneralPrivateCreateDraftDetailsReadOnly({
    shopId, expectedRowCount: 2, adapter: count.adapter });
  assert.equal(result.status, "DRAFT_LIST_CHANGED");
  assert.deepEqual(result.rows, []);
  const title = fakeAdapter({ mutateDetail: data => ({ ...data, title: "Different draft" }) });
  assert.equal((await collectGeneralPrivateCreateDraftDetailsReadOnly({
    shopId, expectedRowCount: 2, adapter: title.adapter })).status,
  "DRAFT_DETAIL_UNVERIFIED");
});

test("transient 13-row draft list settles before any detail row is opened", async () => {
  const { adapter, calls } = fakeAdapter();
  const goto = adapter.goto;
  const list = adapter.list;
  let firstAfterNavigation = false;
  adapter.goto = async url => { await goto(url); firstAfterNavigation = true; };
  adapter.list = async () => {
    const snapshot = await list();
    if (firstAfterNavigation) {
      firstAfterNavigation = false;
      snapshot.rows.push({ title: "", signature: "[]",
        cellCount: 10, interactiveCount: 0 });
    }
    return snapshot;
  };
  const result = await collectGeneralPrivateCreateDraftDetailsReadOnly({
    shopId, expectedRowCount: 2, adapter });
  assert.equal(result.status, "DRAFT_DETAILS_DOM_OBSERVED");
  assert.equal(calls.filter(item => item[0] === "clickRow").length, 4);
  assert.equal(calls.filter(item => item[0] === "wait").length >= 2 * 5, true);
});

test("an unstable draft list stops after bounded reads without opening details", async () => {
  const { adapter, calls } = fakeAdapter({ mutateList: reads => reads % 2 ?
    details : [...details, { id: "transient-C", title: "", skuCode: "" }] });
  const result = await collectGeneralPrivateCreateDraftDetailsReadOnly({
    shopId, expectedRowCount: 2, adapter });
  assert.equal(result.status, "DRAFT_LIST_UNVERIFIED");
  assert.equal(calls.filter(item => item[0] === "list").length, 12);
  assert.equal(calls.filter(item => item[0] === "clickRow").length, 0);
  assert.deepEqual(result.rows, []);
});

test("duplicate draft ID, wrong detail URL and loading state fail closed", async () => {
  const duplicate = fakeAdapter({ entries: [details[0], { ...details[1], id: details[0].id }] });
  assert.equal((await collectGeneralPrivateCreateDraftDetailsReadOnly({
    shopId, expectedRowCount: 2, adapter: duplicate.adapter })).status,
  "DRAFT_DETAIL_UNVERIFIED");
  const wrongUrl = fakeAdapter({ mutateDetail: data => ({ ...data,
    documentUrl: data.documentUrl + "&unexpected=1" }) });
  assert.equal((await collectGeneralPrivateCreateDraftDetailsReadOnly({
    shopId, expectedRowCount: 2, adapter: wrongUrl.adapter })).status,
  "DRAFT_DETAIL_UNVERIFIED");
  const loading = fakeAdapter({ mutateList: () => details });
  loading.adapter.list = async () => ({ url: listUrl, documentUrl: listUrl,
    loading: true, paginationControls: 0, tableIndex: 0, headerCount: 10,
    titleColumn: 0, tableMatches: 1, rows: [] });
  assert.equal((await collectGeneralPrivateCreateDraftDetailsReadOnly({
    shopId, expectedRowCount: 2, adapter: loading.adapter })).status,
  "DRAFT_LIST_UNVERIFIED");
});

test("old eight-column draft shape cannot open any detail row", async () => {
  const { adapter, calls } = fakeAdapter();
  const list = adapter.list;
  adapter.list = async () => {
    const snapshot = await list();
    snapshot.headerCount = 8;
    snapshot.rows = snapshot.rows.map(row => ({ ...row, cellCount: 8 }));
    return snapshot;
  };
  const result = await collectGeneralPrivateCreateDraftDetailsReadOnly({
    shopId, expectedRowCount: 2, adapter });
  assert.equal(result.status, "DRAFT_LIST_UNVERIFIED");
  assert.equal(calls.some(item => item[0] === "clickRow"), false);
});

test("observed ten-column DOM reads title from the second cell and rejects actions", async () => {
  const originalDocument = globalThis.document;
  try {
    for (const [wrongHeader, actionableCell, rowAction, expected] of [
      [false, false, null, "DRAFT_DETAILS_DOM_OBSERVED"],
      [true, false, null, "DRAFT_LIST_UNVERIFIED"],
      [false, true, null, "DRAFT_LIST_UNVERIFIED"],
      [false, false, "button", "DRAFT_LIST_UNVERIFIED"],
      [false, false, "menuitem", "DRAFT_LIST_UNVERIFIED"],
      [false, false, "contenteditable", "DRAFT_LIST_UNVERIFIED"],
    ]) {
      let url = listUrl;
      let clicks = 0;
      const headerTexts = ["商品名", "", "公開設定", "価格", "在庫",
        "いいね!", "閲覧", "作成日時", "更新日時", ""];
      if (wrongHeader) headerTexts[2] = "unknown";
      const headers = headerTexts.map(textContent => ({ textContent }));
      const rows = details.map(entry => {
        const cells = Array.from({ length: 10 }, (_, index) => ({
          textContent: index === 1 ? entry.title : "",
          matches: () => actionableCell && index === 1,
          querySelectorAll: () => [],
        }));
        return {
          matches: selector => rowAction === "button" &&
            selector.includes('[role="button"]') ||
            rowAction === "menuitem" && selector.includes('[role="menuitem"]') ||
            rowAction === "contenteditable" &&
              selector.includes('[contenteditable="true"]'),
          querySelectorAll: selector => selector === ":scope > td" ? cells : [],
        };
      });
      const table = { querySelectorAll: selector =>
        selector === "thead th" ? headers : selector === "tbody tr" ? rows : [] };
      globalThis.document = {
        location: { get href() { return url; } },
        querySelector: () => null,
        querySelectorAll: selector => {
          if (selector === "table") return url === listUrl ? [table] : [];
          if (selector === 'input[name="name"]') {
            const id = new URL(url).searchParams.get("productDraftId");
            return id ? [{ value: details.find(item => item.id === id)?.title ?? "" }] : [];
          }
          if (selector === 'input[name="variants.0.skuCode"]') {
            const id = new URL(url).searchParams.get("productDraftId");
            return id ? [{ value: details.find(item => item.id === id)?.skuCode ?? "" }] : [];
          }
          return [];
        },
      };
      const page = {
        goto: async target => { url = target; },
        url: () => url,
        waitForTimeout: async () => {},
        locator: selector => selector === "body" ?
          { evaluate: async callback => callback() } : selector === "table" ?
            { nth: index => { assert.equal(index, 0); return {
              locator: child => { assert.equal(child, "tbody tr"); return {
                nth: rowIndex => ({ click: async () => {
                  clicks++;
                  url = `https://mercari-shops.com/seller/shops/${shopId}/products/create?productDraftId=${details[rowIndex].id}`;
                } }),
              }; },
            }; } } : { click: async () => { throw Error("Unexpected action"); } },
      };
      const result = await collectGeneralPrivateCreateDraftDetailsReadOnly({
        page, shopId, expectedRowCount: 2 });
      assert.equal(result.status, expected);
      assert.equal(clicks, expected === "DRAFT_DETAILS_DOM_OBSERVED" ? 4 : 0);
      if (expected === "DRAFT_DETAILS_DOM_OBSERVED") {
        assert.equal(result.rows[0].title, details[0].title);
        assert.equal(result.rows[1].title, "");
      }
    }
  } finally { globalThis.document = originalDocument; }
});

test("blank rows with unchanged table text still require identical IDs on a second pass", async () => {
  const entries = details.map(item => ({ ...item }));
  const { adapter } = fakeAdapter({ entries });
  const click = adapter.clickRow;
  let clicks = 0;
  adapter.clickRow = async (...args) => {
    if (++clicks === 3) entries[0].id = "another-draft";
    return click(...args);
  };
  const result = await collectGeneralPrivateCreateDraftDetailsReadOnly({
    shopId, expectedRowCount: 2, adapter });
  assert.equal(result.status, "DRAFT_LIST_CHANGED");
  assert.deepEqual(result.rows, []);
});

test("a newly added actionable control inside a row prevents row click", async () => {
  const { adapter, calls } = fakeAdapter();
  const list = adapter.list;
  adapter.list = async () => {
    const snapshot = await list();
    snapshot.rows[0].interactiveCount = 1;
    return snapshot;
  };
  const result = await collectGeneralPrivateCreateDraftDetailsReadOnly({
    shopId, expectedRowCount: 2, adapter });
  assert.equal(result.status, "DRAFT_LIST_UNVERIFIED");
  assert.equal(calls.some(item => item[0] === "clickRow"), false);
});
