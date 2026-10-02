import assert from "node:assert/strict";
import { clearFailedNextEngineMasterSync, getNextEngineMasterSync, startNextEngineMasterSync,
  refreshNextEngineMasterSync } from "../lib/listing/nextEngine/masterSync";
import type { ListingDraftRecord } from "../lib/listing/types";
import type { InventoryDetail } from "../lib/inventory/queries";

const inventoryId = "synthetic-inventory";
const sku = "BELLO-SYNC-001";
const supplierCode = "SYNTHETIC-SUPPLIER";
const binding = { clientId: "id", clientSecret: "secret", expectedCompanyNeId: "1", credentialVersionId: "version" };
const tokens = { accessToken: "access", refreshToken: "refresh" };
const inventory = { id: inventoryId, sku, purchasePrice: 100 } as InventoryDetail;
const draft = {
  id: "draft", inventoryId, title: "確認用の椅子", description: "状態を確認した椅子です。",
  price: 300, condition: "NO_NOTABLE_DAMAGE", shippingMethod: "KAZAI",
  images: [{ storageKey: "synthetic-photo", sortOrder: 0 }],
  createdBy: null, updatedBy: null, createdAt: "", updatedAt: "",
} satisfies ListingDraftRecord;

type Row = { inventoryId: string; sku: string; status: string; queueId?: string | null; [key: string]: unknown };
function harness(uploadFailure = false, queueFailure = false, shopCount = 0) {
  let row: Row | null = null;
  let uploadCalls = 0;
  const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body as URLSearchParams;
    assert.equal(body.get("access_token"), "access");
    if (url.endsWith("/api_v1_master_supplier/search"))
      return Response.json({ result: "success", count: "1", data: [{ supplier_id: supplierCode, supplier_deleted_flag: "0" }] });
    if (url.endsWith("/api_v1_master_goods/count"))
      return Response.json({ result: "success", count: "0" });
    if (url.endsWith("/api_v1_master_shop/count"))
      return Response.json({ result: "success", count: String(shopCount) });
    if (url.endsWith("/api_v1_master_goods/upload")) {
      uploadCalls += 1;
      assert.equal(body.get("data_type"), "csv");
      assert.match(body.get("data") ?? "", /BELLO-SYNC-001/);
      if (uploadFailure) throw new Error("network dropped after send");
      return Response.json({ result: "success", que_id: "47" });
    }
    if (url.endsWith("/api_v1_system_que/search"))
      return Response.json({ result: "success", data: [{ que_id: "47", que_method_name: "SYOHIN_KIHON_CSV", que_status_id: queueFailure ? "-1" : "2" }] });
    if (url.endsWith("/api_v1_master_goods/search"))
      return Response.json({ result: "success", data: [{ goods_id: sku, goods_name: draft.title,
        goods_supplier_id: supplierCode, goods_cost_price: "100", goods_selling_price: "300" }] });
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const overrides = {
    configuration: async () => binding,
    readTokens: async () => tokens,
    saveTokens: async () => {},
    request,
    loadInventory: async () => inventory,
    loadDraft: async () => draft,
    loadListing: async () => null,
    readSync: async () => row as never,
    createSync: async (value: Row) => { if (row) throw new Error("duplicate reservation"); row = value; return value as never; },
    updateSync: async (expected: Row, patch: Partial<Row>) => {
      assert.ok(row && row.fingerprint === expected.fingerprint && row.status === expected.status);
      row = { ...row, ...patch }; return row as never;
    },
    deleteSync: async (expected: Row) => {
      assert.ok(row && row.fingerprint === expected.fingerprint && row.status === "FAILED" &&
        row.queueId === expected.queueId);
      row = null;
    },
    currentMatch: async () => true,
  };
  return { overrides, getUploadCalls: () => uploadCalls, getRow: () => row };
}

async function main() {
  process.env.NEXT_ENGINE_MASTER_UPLOAD_ENABLED = "1";
  process.env.NEXT_ENGINE_NO_AUTO_MALL_SYNC_CONFIRMED = "1";
  const success = harness();
  const queued = await startNextEngineMasterSync(inventoryId, supplierCode, null, success.overrides);
  assert.equal(queued.status, "QUEUED");
  assert.equal(queued.queueId, "47");
  assert.equal(queued.publicationConfirmed, false);
  assert.equal(queued.connectionMatches, true);
  assert.equal((await refreshNextEngineMasterSync(inventoryId, success.overrides))?.status, "MASTER_CONFIRMED");
  await assert.rejects(startNextEngineMasterSync(inventoryId, supplierCode, null, success.overrides), /送信履歴/);
  assert.equal(success.getUploadCalls(), 1);

  const ambiguous = harness(true);
  await assert.rejects(startNextEngineMasterSync(inventoryId, supplierCode, null, ambiguous.overrides), /再送信せず/);
  assert.equal(ambiguous.getRow()?.status, "UNKNOWN");
  await assert.rejects(startNextEngineMasterSync(inventoryId, supplierCode, null, ambiguous.overrides), /送信履歴/);
  assert.equal(ambiguous.getUploadCalls(), 1);

  const failed = harness(false, true);
  await startNextEngineMasterSync(inventoryId, supplierCode, null, failed.overrides);
  assert.equal((await refreshNextEngineMasterSync(inventoryId, failed.overrides))?.status, "FAILED");
  await clearFailedNextEngineMasterSync(inventoryId, failed.overrides);
  assert.equal(failed.getRow(), null);
  await startNextEngineMasterSync(inventoryId, supplierCode, null, failed.overrides);
  assert.equal(failed.getUploadCalls(), 2);
  const connectedShop = harness(false, false, 1);
  await assert.rejects(startNextEngineMasterSync(inventoryId, supplierCode, null, connectedShop.overrides), /店舗が登録/);
  assert.equal(connectedShop.getUploadCalls(), 0);

  const switched = harness();
  let activeBinding = binding;
  const otherBinding = { ...binding, expectedCompanyNeId: "other-company", credentialVersionId: "other-version" };
  const switchedRequest = switched.overrides.request;
  switched.overrides.configuration = async () => activeBinding;
  switched.overrides.request = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await switchedRequest(input, init);
    if (String(input).endsWith("/api_v1_master_shop/count")) activeBinding = otherBinding;
    return response;
  }) as typeof fetch;
  await assert.rejects(startNextEngineMasterSync(inventoryId, supplierCode, null, switched.overrides), /接続設定が変更/);
  assert.equal(switched.getUploadCalls(), 0);
  assert.equal(switched.getRow(), null);

  const changedAfterReservation = harness();
  let reservationBinding = binding;
  changedAfterReservation.overrides.configuration = async () => reservationBinding;
  const createOriginal = changedAfterReservation.overrides.createSync;
  changedAfterReservation.overrides.createSync = async (value: Row) => {
    const saved = await createOriginal(value);
    reservationBinding = otherBinding;
    return saved;
  };
  await assert.rejects(startNextEngineMasterSync(inventoryId, supplierCode, null,
    changedAfterReservation.overrides), /再送信せず/);
  assert.equal(changedAfterReservation.getUploadCalls(), 0);
  assert.equal(changedAfterReservation.getRow()?.status, "UNKNOWN");

  const differentCompany = harness();
  await startNextEngineMasterSync(inventoryId, supplierCode, null, differentCompany.overrides);
  differentCompany.overrides.configuration = async () => otherBinding;
  await assert.rejects(refreshNextEngineMasterSync(inventoryId, differentCompany.overrides), /異なるネクストエンジン/);
  assert.equal(differentCompany.getRow()?.status, "QUEUED");
  const switchedView = await getNextEngineMasterSync(inventoryId, differentCompany.overrides);
  assert.equal(switchedView?.connectionMatches, false);
  const legacyRow = { ...differentCompany.getRow()!, fingerprint: "a".repeat(64), status: "MASTER_CONFIRMED" };
  differentCompany.overrides.readSync = async () => legacyRow as never;
  differentCompany.overrides.configuration = async () => binding;
  assert.equal((await getNextEngineMasterSync(inventoryId, differentCompany.overrides))?.connectionMatches, false);
  assert.equal((await refreshNextEngineMasterSync(inventoryId, differentCompany.overrides))?.connectionMatches, false);

  const confirmedThenSwitched = harness();
  await startNextEngineMasterSync(inventoryId, supplierCode, null, confirmedThenSwitched.overrides);
  await refreshNextEngineMasterSync(inventoryId, confirmedThenSwitched.overrides);
  confirmedThenSwitched.overrides.configuration = async () => otherBinding;
  const previousCompanyView = await getNextEngineMasterSync(inventoryId, confirmedThenSwitched.overrides);
  assert.equal(previousCompanyView?.status, "MASTER_CONFIRMED");
  assert.equal(previousCompanyView?.connectionMatches, false);
  assert.equal((await refreshNextEngineMasterSync(inventoryId,
    confirmedThenSwitched.overrides))?.connectionMatches, false);

  for (const badCount of [null, "", false, []]) {
    const invalid = harness();
    const original = invalid.overrides.request;
    invalid.overrides.request = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/api_v1_master_goods/count")
        ? Response.json({ result: "success", count: badCount }) : original(input, init)) as typeof fetch;
    await assert.rejects(startNextEngineMasterSync(inventoryId, supplierCode, null, invalid.overrides), /同じ商品コード/);
    assert.equal(invalid.getUploadCalls(), 0);
    assert.equal(invalid.getRow(), null);

    const invalidClear = harness(false, true);
    await startNextEngineMasterSync(inventoryId, supplierCode, null, invalidClear.overrides);
    await refreshNextEngineMasterSync(inventoryId, invalidClear.overrides);
    const originalClear = invalidClear.overrides.request;
    invalidClear.overrides.request = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/api_v1_master_goods/count")
        ? Response.json({ result: "success", count: badCount }) : originalClear(input, init)) as typeof fetch;
    await assert.rejects(clearFailedNextEngineMasterSync(inventoryId, invalidClear.overrides), /NEに商品が存在/);
    assert.equal(invalidClear.getRow()?.status, "FAILED");
  }

  const differentCompanyClear = harness(false, true);
  await startNextEngineMasterSync(inventoryId, supplierCode, null, differentCompanyClear.overrides);
  await refreshNextEngineMasterSync(inventoryId, differentCompanyClear.overrides);
  differentCompanyClear.overrides.configuration = async () => otherBinding;
  await assert.rejects(clearFailedNextEngineMasterSync(inventoryId, differentCompanyClear.overrides), /異なるネクストエンジン/);
  assert.equal(differentCompanyClear.getRow()?.status, "FAILED");

  const race = harness(false, true);
  await startNextEngineMasterSync(inventoryId, supplierCode, null, race.overrides);
  await refreshNextEngineMasterSync(inventoryId, race.overrides);
  let arrived = 0;
  let bothArrived!: () => void;
  const bothCounts = new Promise<void>(resolve => { bothArrived = resolve; });
  const release: Array<() => void> = [];
  const original = race.overrides.request;
  race.overrides.request = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/api_v1_master_goods/count") && arrived < 2) {
      const slot = arrived++;
      if (arrived === 2) bothArrived();
      await new Promise<void>(resolve => { release[slot] = resolve; });
    }
    return original(input, init);
  }) as typeof fetch;
  const firstClear = clearFailedNextEngineMasterSync(inventoryId, race.overrides);
  const staleClear = clearFailedNextEngineMasterSync(inventoryId, race.overrides);
  await bothCounts;
  release[0]();
  await firstClear;
  await startNextEngineMasterSync(inventoryId, supplierCode, null, race.overrides);
  release[1]();
  await assert.rejects(staleClear);
  assert.equal(race.getRow()?.status, "QUEUED");
  assert.equal(race.getUploadCalls(), 2);

  console.log("Next Engine master sync: readback, duplicate/UNKNOWN blocks, binding and count guards, conditional failed recovery passed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
