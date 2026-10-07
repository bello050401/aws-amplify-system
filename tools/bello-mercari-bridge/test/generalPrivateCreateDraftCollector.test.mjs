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
          paginationControls: 0, tableIndex: 0, headerCount: 8,
          titleColumn: 0, tableMatches: 1,
          rows: current.map(entry => ({ title: entry.title,
            signature: JSON.stringify([entry.title, "", "¥0", "0", "", "", "", ""]),
            cellCount: 8, interactiveCount: 0 })) };
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
  const count = fakeAdapter({ mutateList: reads => reads >= 3 ?
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
    loading: true, paginationControls: 0, tableIndex: 0, headerCount: 8,
    titleColumn: 0, tableMatches: 1, rows: [] });
  assert.equal((await collectGeneralPrivateCreateDraftDetailsReadOnly({
    shopId, expectedRowCount: 2, adapter: loading.adapter })).status,
  "DRAFT_LIST_UNVERIFIED");
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
