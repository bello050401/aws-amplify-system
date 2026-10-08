import test from "node:test";
import assert from "node:assert/strict";
import { captureGeneralPrivateInitialScanReadOnly } from
  "../src/generalPrivateCreateInitialScan.mjs";
import { inspectGeneralPrivateCreateRemoteScan } from
  "../src/generalPrivateCreateRemotePreflight.mjs";

const shopId = "evkhihBFFNn5hukMS9s36H";
const inventoryId = "2c53f36a-7a60-4e34-801d-8abc24f6cfc0";
const managementCode = `BELLO_${inventoryId.replace(/-/g, "").toUpperCase()}`;
const saleUrl = `https://mercari-shops.com/seller/shops/${shopId}/products?tab=on_sale`;
const detailUrl = `https://mercari-shops.com/seller/shops/${shopId}/products/sale1/edit`;
function fixture({ changedDetail = false, saleTitle = "別の商品",
  skuCode = "OTHER_1", quantity = 1, priceYen = 30_000,
  detailQuantity = quantity } = {}) {
  let detail = false;
  let draftReads = 0;
  const adapter = {
    gotoSale: async url => { assert.equal(url, saleUrl); detail = false; },
    saleSnapshot: async () => ({ url: saleUrl, documentUrl: saleUrl,
      statusChipExact: true, visibilityChipExact: true, loading: false,
      tableMatches: 1, tableIndex: 0, headerCount: 10, titleColumn: 0,
      rows: [{ remoteId: "sale1", title: saleTitle, cellCount: 10,
        visibility: "PUBLIC", quantity, priceYen,
        dataActionCount: 0, menuControlsVerified: true, signature: "stable" }],
      nextCount: 1, prevCount: 1, nextDisabled: true, prevDisabled: true }),
    clickSaleRow: async () => { detail = true; },
    saleDetail: async () => {
      assert.equal(detail, true);
      return { url: detailUrl, documentUrl: detailUrl, loading: false,
        nameFieldCount: 1, skuFieldCount: 1,
        priceFieldCount: 1, quantityFieldCount: 1,
        title: changedDetail ? "別タイトル" : saleTitle, skuCode,
        price: String(priceYen), quantity: String(detailQuantity) };
    },
    wait: async () => {},
  };
  const collectDrafts = async () => {
    draftReads++;
    return { status: "DRAFT_DETAILS_DOM_OBSERVED", allowFinalCreate: false,
      rows: [{ draftId: "draft1", title: "別の下書き",
        skuCode: "OTHER_2" }] };
  };
  return { adapter, collectDrafts, getDraftReads: () => draftReads };
}

test("initial UI scan connects independently read sale and draft identities to raw preflight shape", async () => {
  const ui = fixture();
  const scan = await captureGeneralPrivateInitialScanReadOnly({ shopId,
    managementCode, title: "対象商品",
    expectedDraftRowCount: 1, ...ui });
  assert.deepEqual(scan.tabs[0].pages[0].rows, [{ remoteId: "sale1",
    title: "別の商品", skuCode: "OTHER_1", detailVerified: true,
    visibility: "PUBLIC", quantity: 1, priceYen: 30_000 }]);
  assert.deepEqual(scan.tabs[0].pages[0].settled.rowIdsOnSecondRead,
    ["sale1"]);
  assert.deepEqual(scan.tabs[1].pages[0].settled.rowIdsOnSecondRead,
    ["draft1"]);
  assert.equal(scan.tabs[1].pages[0].settled.firstIdBefore, "sale1");
  assert.equal(ui.getDraftReads(), 2);
  const pack = { schemaVersion: 1,
    kind: "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK", shopId, inventoryId,
    draftId: "12345678-1234-4234-8234-123456789abc",
    draftUpdatedAt: "2026-10-08T00:00:00.000Z", title: "対象商品",
    description: "説明", condition: "NO_NOTABLE_DAMAGE",
    imageRefs: [{ source: "INVENTORY", storageKey: "inventory/sofa.jpg",
      sortOrder: 0, photoAssetId: null }], priceYen: 99999, quantity: 1,
    categoryId: "12345", categoryPath:
      "家具・インテリア > ソファ・ソファベッド > 2人掛け・3人掛けソファ",
    brandId: null, brandName: null, managementCode,
    shipping: { method: "METHOD_TYPE_UNDECIDED", payer: "PAYER_TYPE_SELLER",
      origin: "jp11", duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" },
    status: "PREPARED_NO_SEND" };
  assert.equal(inspectGeneralPrivateCreateRemoteScan(pack, scan).status,
    "NO_MATCH_IN_OBSERVED_UI");
});

test("changed detail title fails closed before draft read", async () => {
  const ui = fixture({ changedDetail: true });
  await assert.rejects(captureGeneralPrivateInitialScanReadOnly({ shopId,
    managementCode, title: "対象商品",
    expectedDraftRowCount: 1, ...ui }), /SALE_DETAIL_UNVERIFIED/);
  assert.equal(ui.getDraftReads(), 0);
});

test("observed blank sale SKU remains distinct from an unread detail", async () => {
  const ui = fixture({ saleTitle: "対象商品", skuCode: "",
    quantity: 0, priceYen: 89_800 });
  const scan = await captureGeneralPrivateInitialScanReadOnly({ shopId,
    managementCode, title: "対象商品", expectedDraftRowCount: 1, ...ui });
  assert.deepEqual(scan.tabs[0].pages[0].rows[0], { remoteId: "sale1",
    title: "対象商品", skuCode: null, detailVerified: true,
    visibility: "PUBLIC", quantity: 0, priceYen: 89_800 });
  const changed = fixture({ saleTitle: "対象商品", skuCode: "",
    quantity: 0, priceYen: 89_800, detailQuantity: 1 });
  await assert.rejects(captureGeneralPrivateInitialScanReadOnly({ shopId,
    managementCode, title: "対象商品", expectedDraftRowCount: 1,
    ...changed }), /SALE_DETAIL_UNVERIFIED/);
});
