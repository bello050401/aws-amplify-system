import "server-only";

import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { getChannelListing, getListingDraftForInventory } from "@/lib/listing/service";
import { getNextEngineAppConfiguration, type NextEngineAppConfiguration } from "./appConfiguration";
import { buildNextEngineListingMasterPlan } from "./listingMasterPlan";
import { readNextEngineTokens, saveNextEngineTokens, type NextEngineTokenPair } from "./tokenStore";
import { resolveNextEngineTokenRotation } from "./tokenRotation";
import { parseNextEngineUploadReceipt } from "./uploadReceipt";
import { checkGoodsUploadQueue } from "./uploadQueueClient";
import { parsePrivateMasterReadback } from "./masterReadback";

export type MasterSyncStatus = "RESERVED" | "UNKNOWN" | "QUEUED" | "WAITING" | "PROCESSING" |
  "FAILED" | "MASTER_APPLIED" | "MASTER_CONFIRMED";
export type MasterSyncView = {
  sku: string; status: MasterSyncStatus; queueId: string | null;
  publicationConfirmed: false; lastError: string | null; currentMatches: boolean;
};
export type NextEngineSupplierChoice = { code: string; name: string };

type SyncRow = {
  inventoryId: string; draftId: string; sku: string; fingerprint: string;
  supplierCode: string; title: string; cost: number; price: number;
  queueId?: string | null; status: string; lastError?: string | null;
};
type Services = {
  configuration: () => Promise<NextEngineAppConfiguration | null>;
  readTokens: (binding: NextEngineAppConfiguration) => Promise<NextEngineTokenPair | null>;
  saveTokens: (tokens: NextEngineTokenPair, binding: NextEngineAppConfiguration) => Promise<void>;
  request: typeof fetch;
  loadInventory: typeof getInventoryDetail;
  loadDraft: typeof getListingDraftForInventory;
  loadListing: typeof getChannelListing;
  readSync: typeof readRow;
  createSync: typeof createRow;
  updateSync: typeof patchRow;
  deleteSync: typeof deleteRow;
  currentMatch: typeof matchesCurrentDraft;
};
const servicesDefault: Services = {
  configuration: getNextEngineAppConfiguration,
  readTokens: readNextEngineTokens,
  saveTokens: saveNextEngineTokens,
  request: fetch,
  loadInventory: getInventoryDetail,
  loadDraft: getListingDraftForInventory,
  loadListing: getChannelListing,
  readSync: readRow,
  createSync: createRow,
  updateSync: patchRow,
  deleteSync: deleteRow,
  currentMatch: matchesCurrentDraft,
};
const statusValues: MasterSyncStatus[] = ["RESERVED", "UNKNOWN", "QUEUED", "WAITING", "PROCESSING", "FAILED", "MASTER_APPLIED", "MASTER_CONFIRMED"];
const view = (row: SyncRow, currentMatches: boolean): MasterSyncView => ({
  sku: row.sku,
  status: statusValues.includes(row.status as MasterSyncStatus) ? row.status as MasterSyncStatus : "UNKNOWN",
  queueId: row.queueId ?? null,
  publicationConfirmed: false,
  lastError: row.lastError ?? null,
  currentMatches,
});
const safeObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

async function readRow(inventoryId: string): Promise<SyncRow | null> {
  const { data, errors } = await serverDataClient.models.NextEngineMasterSync.get({ inventoryId }, inventoryAuthMode);
  if (errors) throw new Error("ネクストエンジンの送信履歴を確認できません。");
  return data as SyncRow | null;
}

async function patchRow(inventoryId: string, patch: Partial<SyncRow>): Promise<SyncRow> {
  const { data, errors } = await serverDataClient.models.NextEngineMasterSync.update({ inventoryId, ...patch }, inventoryAuthMode);
  if (errors || !data) throw new Error("ネクストエンジンの送信履歴を保存できません。");
  return data as SyncRow;
}

async function createRow(row: SyncRow & { requestedBy?: string }): Promise<SyncRow> {
  const { data, errors } = await serverDataClient.models.NextEngineMasterSync.create(row, inventoryAuthMode);
  if (errors || !data) throw new Error("送信履歴を確保できません。送信していません。");
  return data as SyncRow;
}

async function deleteRow(inventoryId: string): Promise<void> {
  const { data, errors } = await serverDataClient.models.NextEngineMasterSync.delete({ inventoryId }, inventoryAuthMode);
  if (errors || !data) throw new Error("送信履歴を再準備できませんでした。");
}

async function persistRotation(binding: NextEngineAppConfiguration, pair: NextEngineTokenPair, services: Services): Promise<void> {
  const current = await services.configuration();
  if (!current || current.credentialVersionId !== binding.credentialVersionId ||
      current.expectedCompanyNeId !== binding.expectedCompanyNeId) throw new Error("ネクストエンジンの接続設定が変更されました。");
  await services.saveTokens(pair, binding);
}

async function apiCall(path: string, body: URLSearchParams, binding: NextEngineAppConfiguration,
  tokens: NextEngineTokenPair, services: Services): Promise<Record<string, unknown>> {
  let response: Response;
  let payload: unknown;
  try {
    response = await services.request(`https://api.next-engine.org${path}`, {
      method: "POST", body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > 65536) throw new Error("oversize");
    payload = JSON.parse(raw);
  } catch {
    throw new Error("ネクストエンジンの応答を確認できません。再送信しないでください。");
  }
  if (!safeObject(payload)) throw new Error("ネクストエンジンの応答を確認できません。再送信しないでください。");
  const rotation = resolveNextEngineTokenRotation(tokens, payload);
  if (rotation.rotated) {
    await persistRotation(binding, { accessToken: rotation.accessToken, refreshToken: rotation.refreshToken }, services);
  }
  if (!response.ok || payload.result !== "success") throw new Error("ネクストエンジンの処理が成功しませんでした。登録状況を確認してください。");
  return payload;
}

async function connected(services: Services): Promise<{ binding: NextEngineAppConfiguration; tokens: NextEngineTokenPair }> {
  const binding = await services.configuration();
  if (!binding) throw new Error("ネクストエンジンのアプリ設定が必要です。");
  const tokens = await services.readTokens(binding);
  if (!tokens) throw new Error("ネクストエンジンに接続してください。");
  return { binding, tokens };
}

async function matchesCurrentDraft(row: SyncRow): Promise<boolean> {
  try {
    const inventory = await getInventoryDetail(row.inventoryId);
    const draft = await getListingDraftForInventory(row.inventoryId);
    if (!inventory || !draft) return false;
    const listing = await getChannelListing(row.inventoryId, "MERCARI_SHOPS");
    return buildNextEngineListingMasterPlan(inventory, draft, listing, row.supplierCode).fingerprint === row.fingerprint;
  } catch { return false; }
}

async function currentView(row: SyncRow, services: Services = servicesDefault): Promise<MasterSyncView> {
  return view(row, await services.currentMatch(row));
}

/** Read status only. A master upload never means a marketplace listing exists. */
export async function getNextEngineMasterSync(inventoryId: string): Promise<MasterSyncView | null> {
  const row = await readRow(inventoryId);
  return row ? currentView(row) : null;
}

/** Supplier choices come from the connected company, so operators do not retype codes. */
export async function listNextEngineSuppliers(overrides: Partial<Services> = {}): Promise<NextEngineSupplierChoice[]> {
  const services = { ...servicesDefault, ...overrides };
  const { binding, tokens } = await connected(services);
  const result = await apiCall("/api_v1_master_supplier/search", new URLSearchParams({
    access_token: tokens.accessToken, refresh_token: tokens.refreshToken,
    fields: "supplier_id,supplier_name,supplier_deleted_flag", offset: "0", limit: "100",
  }), binding, tokens, services);
  if (!Array.isArray(result.data) || result.data.length > 100 || Number(result.count) > 100) {
    throw new Error("仕入先が多いため、設定を確認してください。");
  }
  return result.data.flatMap(value => {
    if (!safeObject(value) || !["0", 0].includes(value.supplier_deleted_flag as string | number)) return [];
    if (typeof value.supplier_id !== "string" || !/^[A-Za-z0-9_-]{1,49}$/.test(value.supplier_id) ||
        typeof value.supplier_name !== "string" || !value.supplier_name.trim()) return [];
    return [{ code: value.supplier_id, name: value.supplier_name }];
  });
}

/** Reserve the inventory before the remote write. An ambiguous result can never be blindly retried. */
export async function startNextEngineMasterSync(inventoryId: string, supplierCode: string, who: string | null,
  overrides: Partial<Services> = {}): Promise<MasterSyncView> {
  if (process.env.NEXT_ENGINE_MASTER_UPLOAD_ENABLED !== "1" ||
      process.env.NEXT_ENGINE_NO_AUTO_MALL_SYNC_CONFIRMED !== "1") {
    throw new Error("ネクストエンジンの商品送信が有効になっていません。");
  }
  if (!/^[A-Za-z0-9_-]{1,49}$/.test(supplierCode)) throw new Error("登録済みの仕入先コードを指定してください。");
  const services = { ...servicesDefault, ...overrides };
  const inventory = await services.loadInventory(inventoryId);
  const draft = await services.loadDraft(inventoryId);
  if (!inventory || !draft) throw new Error("在庫と保存済みの出品下書きを確認してください。");
  const listing = await services.loadListing(inventoryId, "MERCARI_SHOPS");
  const plan = buildNextEngineListingMasterPlan(inventory, draft, listing, supplierCode);
  if (await services.readSync(inventoryId)) throw new Error("この商品の送信履歴があります。状態を確認してください。");
  const { binding, tokens } = await connected(services);
  const supplier = await apiCall("/api_v1_master_supplier/search", new URLSearchParams({
    access_token: tokens.accessToken, refresh_token: tokens.refreshToken,
    fields: "supplier_id,supplier_deleted_flag", "supplier_id-eq": supplierCode, offset: "0", limit: "2",
  }), binding, tokens, services);
  if (Number(supplier.count) !== 1 || !Array.isArray(supplier.data) || supplier.data.length !== 1 ||
      !safeObject(supplier.data[0]) || supplier.data[0].supplier_id !== supplierCode ||
      !["0", 0].includes(supplier.data[0].supplier_deleted_flag as string | number)) {
    throw new Error("使用できる仕入先を確認できません。");
  }
  const currentTokens = await services.readTokens(binding);
  if (!currentTokens) throw new Error("ネクストエンジンの接続を確認できません。");
  const existing = await apiCall("/api_v1_master_goods/count", new URLSearchParams({
    access_token: currentTokens.accessToken, refresh_token: currentTokens.refreshToken,
    "goods_id-eq": plan.sku,
  }), binding, currentTokens, services);
  if (Number(existing.count) !== 0) throw new Error("同じ商品コードがNEに存在します。上書きせず確認してください。");
  const shopTokens = await services.readTokens(binding);
  if (!shopTokens) throw new Error("ネクストエンジンの接続を確認できません。");
  const shops = await apiCall("/api_v1_master_shop/count", new URLSearchParams({
    access_token: shopTokens.accessToken, refresh_token: shopTokens.refreshToken,
    "shop_deleted_flag-eq": "0", wait_flag: "1",
  }), binding, shopTokens, services);
  if (String(shops.count) !== "0") throw new Error("NEに店舗が登録されています。自動連携設定を確認するまで送信しません。");
  await services.createSync({
    inventoryId, draftId: draft.id, sku: plan.sku, fingerprint: plan.fingerprint,
    supplierCode, title: listing?.overrideTitle?.trim() || draft.title.trim(),
    cost: inventory.purchasePrice!, price: listing?.overridePrice ?? draft.price!,
    status: "RESERVED", requestedBy: who ?? undefined,
  });
  try {
    const latest = await services.readTokens(binding);
    if (!latest) throw new Error("接続が失われました。");
    const response = await apiCall("/api_v1_master_goods/upload", new URLSearchParams({
      access_token: latest.accessToken, refresh_token: latest.refreshToken,
      data_type: "csv", data: plan.prepared.csv,
    }), binding, latest, services);
    const receipt = parseNextEngineUploadReceipt(response);
    return currentView(await services.updateSync(inventoryId, { status: "QUEUED", queueId: receipt.queueId, lastError: null }), services);
  } catch {
    // The request may have reached NE. Keep the reservation and require reconciliation.
    try { await services.updateSync(inventoryId, { status: "UNKNOWN", lastError: "登録結果が不明です。NE側の状態を確認してください。" }); }
    catch { /* RESERVED is still non-retryable. */ }
    throw new Error("登録結果が不明です。再送信せず状態を確認してください。");
  }
}

/** A single bounded poll; no upload retry. */
export async function refreshNextEngineMasterSync(inventoryId: string, overrides: Partial<Services> = {}): Promise<MasterSyncView | null> {
  const services = { ...servicesDefault, ...overrides };
  const row = await services.readSync(inventoryId);
  if (!row) return null;
  if (row.status === "MASTER_CONFIRMED" || row.status === "FAILED") return currentView(row, services);
  const { binding, tokens } = await connected(services);
  if (row.queueId) {
    const queue = await checkGoodsUploadQueue(tokens, next => persistRotation(binding, next, services), row.queueId, services.request);
    if (queue.state === "FAILED") return currentView(await services.updateSync(inventoryId, { status: "FAILED", lastError: "NEの商品マスタ取込に失敗しました。NEでエラーを確認してください。" }), services);
    if (queue.state !== "MASTER_APPLIED") return currentView(await services.updateSync(inventoryId, { status: queue.state }), services);
  }
  const latest = await services.readTokens(binding);
  if (!latest) throw new Error("ネクストエンジンの接続を確認できません。");
  const result = await apiCall("/api_v1_master_goods/search", new URLSearchParams({
    access_token: latest.accessToken, refresh_token: latest.refreshToken,
    fields: "goods_id,goods_name,goods_supplier_id,goods_cost_price,goods_selling_price",
    "goods_id-eq": row.sku, offset: "0", limit: "2",
  }), binding, latest, services);
  if (!Array.isArray(result.data) || result.data.length === 0) {
    return currentView(await services.updateSync(inventoryId, { status: row.queueId ? "MASTER_APPLIED" : "UNKNOWN" }), services);
  }
  try {
    parsePrivateMasterReadback(result, { sku: row.sku, title: row.title, supplierCode: row.supplierCode, cost: row.cost, price: row.price });
  } catch {
    return currentView(await services.updateSync(inventoryId, { status: "UNKNOWN", lastError: "NEの商品内容が送信記録と一致しません。確認してください。" }), services);
  }
  return currentView(await services.updateSync(inventoryId, { status: "MASTER_CONFIRMED", lastError: null }), services);
}

/** A failed queue may be cleared only after confirming the exact SKU is absent in NE. */
export async function clearFailedNextEngineMasterSync(inventoryId: string, overrides: Partial<Services> = {}): Promise<void> {
  const services = { ...servicesDefault, ...overrides };
  const row = await services.readSync(inventoryId);
  if (!row || row.status !== "FAILED" || !row.queueId) throw new Error("取込失敗が確定した商品だけ再準備できます。");
  const { binding, tokens } = await connected(services);
  const queue = await checkGoodsUploadQueue(tokens, next => persistRotation(binding, next, services), row.queueId, services.request);
  if (queue.state !== "FAILED") throw new Error("NEの取込失敗を確認できません。");
  const latest = await services.readTokens(binding);
  if (!latest) throw new Error("ネクストエンジンの接続を確認できません。");
  const existing = await apiCall("/api_v1_master_goods/count", new URLSearchParams({
    access_token: latest.accessToken, refresh_token: latest.refreshToken, "goods_id-eq": row.sku,
  }), binding, latest, services);
  if (Number(existing.count) !== 0) throw new Error("NEに商品が存在します。再送前に内容を確認してください。");
  await services.deleteSync(inventoryId);
}
