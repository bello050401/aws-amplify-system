import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { enqueueGeneralPrivateCreate, claimGeneralPrivateCreateOnce } from
  "../src/generalPrivateCreateJob.mjs";
import { exactB005396KnownExistingEvidence,
  inspectB005396KnownExistingPrivateTest,
  inspectGeneralPrivateCreateRemoteScan,
  preflightGeneralPrivateCreateRemote,
  recordB005396KnownExistingEvidence } from
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
const saleRow = (remoteId, title, skuCode) =>
  ({ ...row(remoteId, title, skuCode), visibility: "PUBLIC",
    quantity: 1, priceYen: 30_000 });
const page = (pageNumber, rows, nextDisabled, transitionKind, firstIdBefore) =>
  ({ pageNumber, bodyRowCount: rows.length, nextDisabled, rows,
    settled: { transitionKind, firstIdBefore,
      firstIdAfter: rows[0]?.remoteId ?? null,
      rowIdsOnSecondRead: rows.map(item => item.remoteId),
      nextDisabledOnSecondRead: nextDisabled, delayMs: 600 } });
const observedAt = "2026-10-07T12:00:00.000Z";
const now = Date.parse(observedAt) + 1000;
function completeScan() {
  const first = [saleRow("remote1", "Other chair", "OTHER_1")];
  const second = [saleRow("remote2", "Other table", "OTHER_2")];
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

const knownInventoryId = "2c53f36a-7a60-4e34-801d-8abc24f6cfc0";
const knownTitle = "HUKLA KASTOR 2Pソファ / モダン 北欧 デザイナーズ ソファ 2人掛け フクラ カストール 片アームソファ";
const knownId = "2JVJtFhb6kB5JBGkDbi2nm";
const knownPack = () => ({ ...pack(), inventoryId: knownInventoryId,
  managementCode: `BELLO_${knownInventoryId.replace(/-/g, "").toUpperCase()}`,
  title: knownTitle, categoryPath:
    "家具・インテリア > ソファ・ソファベッド > 2人掛け・3人掛けソファ" });
function knownScan() {
  const scan = completeScan();
  scan.managementCode = knownPack().managementCode;
  scan.tabs[0].pages[0] = page(1, [{ ...saleRow(knownId, knownTitle, null),
    quantity: 0, priceYen: 89_800 }], false, "TAB_NAVIGATION", null);
  scan.tabs[0].pages[1] = page(2,
    [saleRow("remote2", "Other table", "OTHER_2")], true,
    "NEXT_CLICK_ROW_CHANGED", knownId);
  scan.tabs[1].pages[0] = page(1, Array.from({ length: 12 }, (_, index) =>
    row(`draft${index + 1}`, `Other draft ${index + 1}`,
      `OTHER_DRAFT_${index + 1}`)), null, "TAB_CHANGED_ROW_SET", "remote2");
  return scan;
}

test("only the one approved sold-out public title is a private-test exception", () => {
  const input = knownPack();
  const scan = knownScan();
  assert.equal(inspectGeneralPrivateCreateRemoteScan(input, scan, now).status,
    "REMOTE_DUPLICATE_POSSIBLE");
  const result = inspectB005396KnownExistingPrivateTest(input, scan, now);
  assert.equal(result.status, "B005396_PRIVATE_TEST_EXCEPTION");
  assert.equal(result.allowFinalCreate, false);
  assert.equal(result.evidence.knownExistingRemoteId, knownId);
  assert.equal(result.evidence.knownExistingSkuCode, null);
  assert.equal(result.evidence.allowPublic, false);
  assert.ok(exactB005396KnownExistingEvidence(input, result.evidence, now));

  const changed = [
    value => { value.tabs[0].pages[0].rows[0].remoteId = "otherId"; },
    value => { value.tabs[0].pages[0].rows[0].skuCode = "OTHER"; },
    value => { value.tabs[0].pages[0].rows[0].visibility = "PRIVATE"; },
    value => { value.tabs[0].pages[0].rows[0].quantity = 1; },
    value => { value.tabs[0].pages[0].rows[0].priceYen = 90_000; },
    value => { value.tabs[0].pages[1].rows[0].skuCode = input.managementCode; },
    value => { value.tabs[1].pages[0].rows[0].skuCode = input.managementCode; },
    value => { value.tabs[1].pages[0].rows[0].title = knownTitle; },
    value => { value.tabs[1].pages[0].rows[0].skuCode = null; },
    value => { value.tabs[0].pages[1].nextDisabled = false;
      value.tabs[0].pages[1].settled.nextDisabledOnSecondRead = false; },
    value => { value.tabs[1].pages[0].rows.pop();
      value.tabs[1].pages[0].bodyRowCount--;
      value.tabs[1].pages[0].settled.rowIdsOnSecondRead.pop(); },
  ];
  for (const modify of changed) {
    const candidate = knownScan();
    modify(candidate);
    assert.notEqual(inspectB005396KnownExistingPrivateTest(input,
      candidate, now).status, "B005396_PRIVATE_TEST_EXCEPTION");
  }
  assert.equal(exactB005396KnownExistingEvidence(input,
    { ...result.evidence, knownExistingQuantity: 1 }, now), null);
  assert.equal(exactB005396KnownExistingEvidence(input, result.evidence,
    now + 120_001), null);
});

test("known-title basis is recorded once and never overrides a local claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-known-title-"));
  try {
    const input = knownPack();
    await enqueueGeneralPrivateCreate(root, input);
    const scan = knownScan();
    scan.observedAt = new Date().toISOString();
    const captureReadOnlyScan = async () => scan;
    const ordinary = await preflightGeneralPrivateCreateRemote({ root,
      inventoryId: knownInventoryId, captureReadOnlyScan });
    assert.equal(ordinary.status, "REMOTE_DUPLICATE_POSSIBLE");
    const permitted = await preflightGeneralPrivateCreateRemote({ root,
      inventoryId: knownInventoryId, captureReadOnlyScan,
      allowKnownExistingPrivateTest: true });
    assert.equal(permitted.status, "B005396_PRIVATE_TEST_EXCEPTION");
    await recordB005396KnownExistingEvidence(root, input,
      permitted.evidence);
    const saved = JSON.parse(await readFile(join(root,
      "general-private-create-once",
      `${knownInventoryId}.known-existing-private-test.json`), "utf8"));
    assert.deepEqual(saved, permitted.evidence);
    await assert.rejects(recordB005396KnownExistingEvidence(root, input,
      permitted.evidence), { code: "EEXIST" });
    await claimGeneralPrivateCreateOnce(root, knownInventoryId);
    const afterClaim = await preflightGeneralPrivateCreateRemote({ root,
      inventoryId: knownInventoryId, captureReadOnlyScan,
      allowKnownExistingPrivateTest: true });
    assert.equal(afterClaim.status, "LOCAL_CLAIM_UNKNOWN_NO_RETRY");
  } finally {
    if (dirname(resolve(root)) !== resolve(tmpdir()) ||
        !basename(root).startsWith("bello-known-title-"))
      throw Error("Unexpected temporary test directory");
    await rm(root, { recursive: true, force: true });
  }
});

test("only a settled complete UI scan reports a read-only no-match", () => {
  const result = inspectGeneralPrivateCreateRemoteScan(pack(), completeScan(), now);
  assert.equal(result.status, "NO_MATCH_IN_OBSERVED_UI");
  assert.equal(result.allowFinalCreate, false);
  assert.deepEqual([result.onSaleRows, result.draftRows], [2, 1]);
});

test("stale rows and transient disabled Next never establish an ending page", () => {
  const stale = completeScan();
  stale.tabs[0].pages[1].rows[0] = saleRow("remote1", "Other chair", "OTHER_1");
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
  const identifiedBlank = completeScan();
  identifiedBlank.tabs[1].pages[0].rows[0] = row("draft1", "", null);
  assert.equal(inspectGeneralPrivateCreateRemoteScan(pack(), identifiedBlank, now).status,
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
