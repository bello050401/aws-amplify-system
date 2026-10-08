import test from "node:test";
import assert from "node:assert/strict";
import { bindB005396PrivateDraftDuplicateReader,
  captureB005396PrivateDraftDuplicateProof,
  readStableGeneralPrivateDraftCount } from
  "../src/generalPrivateDraftDuplicateReader.mjs";

const shopId = "evkhihBFFNn5hukMS9s36H";
const managementCode = "BELLO_2C53F36A7A604E34801D8ABC24F6CFC0";
const ownDraftId = "shopsDraft123";
const title = "ソファ";
const listUrl = `https://mercari-shops.com/seller/shops/${shopId}/products?tab=draft`;
const target = { shopId, managementCode, ownDraftId, title };
const draftRows = [{ draftId: ownDraftId, title, skuCode: managementCode },
  { draftId: "otherDraft", title: "椅子", skuCode: "OTHER_SKU" }];
function listSnapshot(rowCount) {
  return { url: listUrl, documentUrl: listUrl, loading: false,
    paginationControls: 0, tableMatches: 1, tableIndex: 0,
    headerCount: 10, titleColumn: 0,
    rows: Array.from({ length: rowCount }, (_, index) => ({
      title: index === 0 ? title : "椅子", signature: `row-${index}`,
      cellCount: 10, interactiveCount: 0 })) };
}
function fakeContext() {
  let currentUrl = listUrl;
  let closed = false;
  const page = { url: () => currentUrl,
    goto: async url => { currentUrl = url; },
    waitForTimeout: async () => {},
    close: async () => { closed = true; } };
  return { context: { newPage: async () => page }, page,
    wasClosed: () => closed,
    setUrl: value => { currentUrl = value; } };
}
const noSale = { diagnostic: "SALE_SKU_SEARCH_NO_MATCH_OBSERVED",
  allowFinalCreate: false };
const countTwo = { status: "DRAFT_COUNT_OBSERVED", count: 2,
  allowFinalCreate: false };
const details = { status: "DRAFT_DETAILS_DOM_OBSERVED", rows: draftRows,
  allowFinalCreate: false };

test("draft count distinguishes stable zero, authentication and changing table", async () => {
  const { page, setUrl } = fakeContext();
  let reads = 0;
  const zero = await readStableGeneralPrivateDraftCount({ page, shopId,
    readList: async () => { reads++; return listSnapshot(0); },
    wait: async () => {} });
  assert.deepEqual(zero, { status: "DRAFT_COUNT_OBSERVED", count: 0,
    allowFinalCreate: false });
  assert.equal(reads, 3);

  const changed = await readStableGeneralPrivateDraftCount({ page, shopId,
    readList: async () => listSnapshot(++reads % 2),
    wait: async () => {} });
  assert.equal(changed.status, "REMOTE_SCAN_INCOMPLETE");
  assert.equal(changed.allowFinalCreate, false);

  const auth = await readStableGeneralPrivateDraftCount({ page, shopId,
    readList: async () => { setUrl("https://mercari-shops.com/signin/");
      return listSnapshot(2); }, wait: async () => {} });
  assert.equal(auth.diagnostic, "AUTH_REQUIRED");
  assert.equal(auth.allowFinalCreate, false);
});

test("exact sale SKU absence and complete draft details prove only own draft", async () => {
  const { context, wasClosed } = fakeContext();
  const calls = [];
  const proof = await captureB005396PrivateDraftDuplicateProof({
    context, ...target }, {
    searchSaleSku: async args => { calls.push(["sale", args]);
      return noSale; },
    readDraftCount: async args => { calls.push(["count", args]);
      return countTwo; },
    collectDrafts: async args => { calls.push(["drafts", args]);
      return details; },
  });
  assert.equal(proof.status, "NO_OTHER_MATCH_OBSERVED");
  assert.equal(proof.complete, true);
  assert.equal(proof.allowFinalCreate, false);
  assert.equal(proof.shopId, shopId);
  assert.equal(proof.ownDraftId, ownDraftId);
  assert.equal(calls[0][1].positiveControlPrefix, "B00");
  assert.equal(calls[0][1].managementCode, managementCode);
  assert.equal(calls[2][1].expectedRowCount, 2);
  assert.equal(wasClosed(), true);
});

test("explicit save callback binds the retained browser context", async () => {
  const { context, wasClosed } = fakeContext();
  const captureDuplicateProof = bindB005396PrivateDraftDuplicateReader(
    context, { searchSaleSku: async () => noSale,
      readDraftCount: async () => countTwo,
      collectDrafts: async () => details });
  const result = await captureDuplicateProof(target);
  assert.equal(result.status, "NO_OTHER_MATCH_OBSERVED");
  assert.equal(result.allowFinalCreate, false);
  assert.equal(wasClosed(), true);
});

test("sale match, unavailable scan and stable empty draft remain non-authorizing", async () => {
  for (const [sale, count, status, diagnostic] of [
    [{ diagnostic: "SALE_SKU_SEARCH_MATCH_POSSIBLE",
      allowFinalCreate: false }, countTwo,
    "REMOTE_DUPLICATE_POSSIBLE", "SALE_SKU_MATCH_POSSIBLE"],
    [{ diagnostic: "SALE_SKU_SEARCH_UNAVAILABLE",
      allowFinalCreate: false }, countTwo,
    "REMOTE_SCAN_INCOMPLETE", "SALE_SKU_SEARCH_UNVERIFIED"],
    [noSale, { status: "DRAFT_COUNT_OBSERVED", count: 0,
      allowFinalCreate: false },
    "REMOTE_SCAN_INCOMPLETE", "DRAFT_ZERO_ROWS_OBSERVED"],
  ]) {
    const { context, wasClosed } = fakeContext();
    const result = await captureB005396PrivateDraftDuplicateProof({
      context, ...target }, {
      searchSaleSku: async () => sale,
      readDraftCount: async () => count,
      collectDrafts: async () => details });
    assert.equal(result.status, status);
    assert.equal(result.diagnostic, diagnostic);
    assert.equal(result.allowFinalCreate, false);
    assert.equal(wasClosed(), true);
  }
});

test("other matching or unidentified drafts cannot prove uniqueness", async () => {
  for (const [rows, status, diagnostic] of [
    [[draftRows[0], { ...draftRows[1], skuCode: managementCode }],
      "REMOTE_DUPLICATE_POSSIBLE", "DRAFT_MATCH_POSSIBLE"],
    [[draftRows[0], { ...draftRows[1], skuCode: null }],
      "REMOTE_SCAN_INCOMPLETE", "DRAFT_IDENTITY_UNVERIFIED"],
    [[draftRows[1], { ...draftRows[1], draftId: "anotherDraft" }],
      "REMOTE_SCAN_INCOMPLETE", "OWN_DRAFT_UNVERIFIED"],
  ]) {
    const { context } = fakeContext();
    const result = await captureB005396PrivateDraftDuplicateProof({
      context, ...target }, {
      searchSaleSku: async () => noSale,
      readDraftCount: async () => countTwo,
      collectDrafts: async () => ({ ...details, rows }) });
    assert.equal(result.status, status);
    assert.equal(result.diagnostic, diagnostic);
    assert.equal(result.allowFinalCreate, false);
  }
});
