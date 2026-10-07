import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { enqueueGeneralPrivateCreate, claimGeneralPrivateCreateOnce } from
  "../src/generalPrivateCreateJob.mjs";
import { inspectGeneralPrivateCreateRemoteScan,
  preflightGeneralPrivateCreateRemote } from
  "../src/generalPrivateCreateRemotePreflight.mjs";

const shopId = "evkhihBFFNn5hukMS9s36H";
const inventoryId = "98765432-1234-4234-8234-987654321abc";
const pack = () => ({ schemaVersion: 1,
  kind: "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK", shopId, inventoryId,
  draftId: "12345678-1234-4234-8234-123456789abc",
  draftUpdatedAt: "2026-10-07T10:00:00.000Z", title: "Test sofa",
  description: "Saved description", condition: "NO_NOTABLE_DAMAGE",
  imageRefs: [{ source: "INVENTORY", storageKey: "inventory/sofa.jpg",
    sortOrder: 0, photoAssetId: null }], priceYen: 99999, quantity: 1,
  categoryId: "12345", categoryPath: "家具・インテリア > ソファ > 2人掛け",
  brandId: null, brandName: null,
  managementCode: `BELLO_${inventoryId.replace(/-/g, "").toUpperCase()}`,
  shipping: { method: "METHOD_TYPE_UNDECIDED", payer: "PAYER_TYPE_SELLER",
    origin: "jp11", duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" },
  status: "PREPARED_NO_SEND" });
const row = (remoteId, title, skuCode) =>
  ({ remoteId, title, skuCode, detailVerified: true });
const page = (pageNumber, rows, nextDisabled, transitionKind, firstIdBefore) =>
  ({ pageNumber, bodyRowCount: rows.length, nextDisabled, rows,
    settled: { transitionKind, firstIdBefore,
      firstIdAfter: rows[0]?.remoteId ?? null,
      rowIdsOnSecondRead: rows.map(item => item.remoteId),
      nextDisabledOnSecondRead: nextDisabled, delayMs: 600 } });
const observedAt = "2026-10-07T12:00:00.000Z";
const now = Date.parse(observedAt) + 1000;
function completeScan() {
  const first = [row("remote1", "Other chair", "OTHER_1")];
  const second = [row("remote2", "Other table", "OTHER_2")];
  const draft = [row("draft1", "Other draft", "OTHER_DRAFT")];
  return { shopId, managementCode: pack().managementCode, observedAt,
    tabs: [
      { kind: "ON_SALE_ALL", tabUrl:
          `https://mercari-shops.com/seller/shops/${shopId}/products?tab=on_sale`,
        allVisibilitySelected: true, paginationKind: "PREV_NEXT",
        pages: [page(1, first, false, "TAB_NAVIGATION", null),
          page(2, second, true, "NEXT_CLICK_ROW_CHANGED", "remote1")] },
      { kind: "DRAFT_ALL", tabUrl:
          `https://mercari-shops.com/seller/shops/${shopId}/products?tab=draft`,
        allVisibilitySelected: null, paginationKind: "NO_CONTROLS",
        pages: [page(1, draft, null, "TAB_CHANGED_ROW_SET", "remote2")] },
    ] };
}

test("only a settled complete UI scan reports a read-only no-match", () => {
  const result = inspectGeneralPrivateCreateRemoteScan(pack(), completeScan(), now);
  assert.equal(result.status, "NO_MATCH_IN_OBSERVED_UI");
  assert.equal(result.allowFinalCreate, false);
  assert.deepEqual([result.onSaleRows, result.draftRows], [2, 1]);
});

test("stale rows and transient disabled Next never establish an ending page", () => {
  const stale = completeScan();
  stale.tabs[0].pages[1].rows[0] = row("remote1", "Other chair", "OTHER_1");
  stale.tabs[0].pages[1].settled.firstIdAfter = "remote1";
  stale.tabs[0].pages[1].settled.rowIdsOnSecondRead = ["remote1"];
  assert.equal(inspectGeneralPrivateCreateRemoteScan(pack(), stale, now).status,
    "REMOTE_SCAN_UNVERIFIED");
  const stillNext = completeScan();
  stillNext.tabs[0].pages[1].nextDisabled = false;
  stillNext.tabs[0].pages[1].settled.nextDisabledOnSecondRead = false;
  assert.equal(inspectGeneralPrivateCreateRemoteScan(pack(), stillNext, now).status,
    "REMOTE_SCAN_INCOMPLETE");
  const tooSoon = completeScan();
  tooSoon.tabs[0].pages[1].settled.delayMs = 100;
  assert.equal(inspectGeneralPrivateCreateRemoteScan(pack(), tooSoon, now).status,
    "REMOTE_SCAN_UNVERIFIED");
  const malformed = completeScan();
  malformed.tabs[1].pages[0].rows[0] = null;
  malformed.tabs[1].pages[0].settled.rowIdsOnSecondRead = [null];
  assert.equal(inspectGeneralPrivateCreateRemoteScan(pack(), malformed, now).status,
    "REMOTE_SCAN_UNVERIFIED");
});

test("matched SKU or title blocks, and unattributed blank drafts stay ambiguous", () => {
  const matched = completeScan();
  matched.tabs[0].pages[1].rows[0].skuCode = pack().managementCode;
  assert.equal(inspectGeneralPrivateCreateRemoteScan(pack(), matched, now).status,
    "REMOTE_DUPLICATE_POSSIBLE");
  matched.tabs[0].pages[1].rows[0].skuCode = pack().managementCode.toLowerCase();
  assert.equal(inspectGeneralPrivateCreateRemoteScan(pack(), matched, now).status,
    "REMOTE_DUPLICATE_POSSIBLE");
  const blank = completeScan();
  blank.tabs[1].pages[0].rows[0] = { remoteId: null, title: "",
    skuCode: null, detailVerified: false };
  blank.tabs[1].pages[0].settled.firstIdAfter = null;
  blank.tabs[1].pages[0].settled.rowIdsOnSecondRead = [null];
  assert.equal(inspectGeneralPrivateCreateRemoteScan(pack(), blank, now).status,
    "REMOTE_DRAFT_AMBIGUOUS");
});

test("a local UNKNOWN claim blocks the remote scan without reading Shops", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-remote-preflight-"));
  try {
    await enqueueGeneralPrivateCreate(root, pack());
    await claimGeneralPrivateCreateOnce(root, inventoryId);
    let called = false;
    const result = await preflightGeneralPrivateCreateRemote({ root, inventoryId,
      captureReadOnlyScan: async () => { called = true; return completeScan(); } });
    assert.equal(result.status, "LOCAL_CLAIM_UNKNOWN_NO_RETRY");
    assert.equal(result.allowFinalCreate, false);
    assert.equal(called, false);
  } finally {
    if (dirname(resolve(root)) !== resolve(tmpdir()) ||
        !basename(root).startsWith("bello-remote-preflight-"))
      throw Error("Unexpected temporary test directory");
    await rm(root, { recursive: true, force: true });
  }
});
