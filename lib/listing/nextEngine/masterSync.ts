import "server-only";

import { randomUUID } from "node:crypto";
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
  publicationConfirmed: false; lastError: string | null; currentMatches: boolean; connectionMatches: boolean;
};
export type NextEngineSupplierChoice = { code: string; name: string };

type SyncRow = {
  inventoryId: string; draftId: string; sku: string; fingerprint: string;
  supplierCode: string; title: string; cost: number; price: number;
  queueId?: string | null; status: string; lastError?: string | null;
};
type SyncIdentity = { version: 2; companyNeId: string; credentialVersionId: string; attemptId: string; draftFingerprint: string };
const syncIdentity = (binding: NextEngineAppConfiguration, draftFingerprint: string): string =>
  JSON.stringify({ version: 2, companyNeId: binding.expectedCompanyNeId,
    credentialVersionId: binding.credentialVersionId, attemptId: randomUUID(), draftFingerprint } satisfies SyncIdentity);
const parseSyncIdentity = (value: string): SyncIdentity | null => {
  try {
    const identity: unknown = JSON.parse(value);
    if (!safeObject(identity) || Object.keys(identity).sort().join(",") !==
      "attemptId,companyNeId,credentialVersionId,draftFingerprint,version" || identity.version !== 2 ||
      typeof identity.companyNeId !== "string" || !identity.companyNeId ||
      typeof identity.credentialVersionId !== "string" || !identity.credentialVersionId ||
      typeof identity.attemptId !== "string" || !/^[0-9a-f-]{36}$/.test(identity.attemptId) ||
      typeof identity.draftFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(identity.draftFingerprint)) return null;
    return identity as SyncIdentity;
  } catch { return null; }
};
const countOf = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
  }
  return null;
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
const view = (row: SyncRow, currentMatches: boolean, connectionMatches: boolean): MasterSyncView => ({
  sku: row.sku,
  status: statusValues.includes(row.status as MasterSyncStatus) ? row.status as MasterSyncStatus : "UNKNOWN",
  queueId: row.queueId ?? null,
  publicationConfirmed: false,
  lastError: row.lastError ?? null,
  currentMatches, connectionMatches,
});
const safeObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

async function readRow(inventoryId: string): Promise<SyncRow | null> {
  const { data, errors } = await serverDataClient.models.NextEngineMasterSync.get({ inventoryId }, inventoryAuthMode);
  if (errors) throw new Error("ネクストエンジンの送信履歴を確認できません。");
  return data as SyncRow | null;
}

async function patchRow(row: SyncRow, patch: Partial<SyncRow>): Promise<SyncRow> {
  const result = await serverDataClient.graphql({
    query: `mutation UpdateNextEngineMasterSync($input: UpdateNextEngineMasterSyncInput!, $condition: ModelNextEngineMasterSyncConditionInput) {
      updateNextEngineMasterSync(input: $input, condition: $condition) {
        inventoryId draftId sku fingerprint supplierCode title cost price queueId status lastError
      }
    }`,
    variables: { input: { inventoryId: row.inventoryId, ...patch },
      condition: { fingerprint: { eq: row.fingerprint }, status: { eq: row.status } } },
    authMode: "userPool",
  });
  const response = result as { data?: { updateNextEngineMasterSync?: SyncRow | null }; errors?: unknown };
  const data = response.data?.updateNextEngineMasterSync;
  if (response.errors || !data) throw new Error("ネクストエンジンの送信履歴が変更されました。再送信しないでください。");
  return data;
}

async function createRow(row: SyncRow & { requestedBy?: string }): Promise<SyncRow> {
  const { data, errors } = await serverDataClient.models.NextEngineMasterSync.create(row, inventoryAuthMode);
  if (errors || !data) throw new Error("送信履歴を確保できません。送信していません。");
  return data as SyncRow;
}

async function deleteRow(row: SyncRow): Promise<void> {
  if (row.status !== "FAILED" || !row.queueId || !parseSyncIdentity(row.fingerprint))
    throw new Error("送信履歴を再準備できませんでした。");
  const result = await serverDataClient.graphql({
    query: `mutation DeleteNextEngineMasterSync($input: DeleteNextEngineMasterSyncInput!, $condition: ModelNextEngineMasterSyncConditionInput) {
      deleteNextEngineMasterSync(input: $input, condition: $condition) { inventoryId }
    }`,
    variables: { input: { inventoryId: row.inventoryId },
      condition: { fingerprint: { eq: row.fingerprint }, status: { eq: "FAILED" }, queueId: { eq: row.queueId } } },
    authMode: "userPool",
  });
  const response = result as { data?: { deleteNextEngineMasterSync?: { inventoryId: string } | null }; errors?: unknown };
  const data = response.data?.deleteNextEngineMasterSync;
  if (response.errors || data?.inventoryId !== row.inventoryId) throw new Error("送信履歴を再準備できませんでした。");
}

async function persistRotation(binding: NextEngineAppConfiguration, pair: NextEngineTokenPair, services: Services): Promise<void> {
  const current = await services.configuration();
  if (!current || current.credentialVersionId !== binding.credentialVersionId ||
      current.expectedCompanyNeId !== binding.expectedCompanyNeId) throw new Error("ネクストエンジンの接続設定が変更されました。");
  await services.saveTokens(pair, binding);
}
async function assertBinding(binding: NextEngineAppConfiguration, services: Services): Promise<void> {
  const current = await services.configuration();
  if (!current || current.credentialVersionId !== binding.credentialVersionId ||
      current.expectedCompanyNeId !== binding.expectedCompanyNeId || current.clientId !== binding.clientId ||
      current.clientSecret !== binding.clientSecret || !await services.readTokens(binding)) {
    throw new Error("ネクストエンジンの接続設定が変更されました。");
  }
}
async function connectedToRow(row: SyncRow, services: Services) {
  const identity = parseSyncIdentity(row.fingerprint);
  if (!identity) throw new Error("以前の送信履歴は接続先を確認できません。再送信しないでください。");
  const connectedState = await connected(services);
  if (connectedState.binding.expectedCompanyNeId !== identity.companyNeId ||
      connectedState.binding.credentialVersionId !== identity.credentialVersionId) {
    throw new Error("送信時と異なるネクストエンジンに接続されています。再送信しないでください。");
  }
  return connectedState;
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
    const identity = parseSyncIdentity(row.fingerprint);
    return !!identity && buildNextEngineListingMasterPlan(inventory, draft, listing, row.supplierCode).fingerprint === identity.draftFingerprint;
  } catch { return false; }
}

async function currentView(row: SyncRow, services: Services = servicesDefault): Promise<MasterSyncView> {
  const identity = parseSyncIdentity(row.fingerprint);
  let connectionMatches = false;
  if (identity) {
    try {
      const binding = await services.configuration();
      connectionMatches = !!binding && binding.expectedCompanyNeId === identity.companyNeId &&
        binding.credentialVersionId === identity.credentialVersionId && !!await services.readTokens(binding);
    } catch { /* A failed connection check must not report a previous company's status as current. */ }
  }
  return view(row, await services.currentMatch(row), connectionMatches);
}

/** Read status only. A master upload never means a marketplace listing exists. */
export async function getNextEngineMasterSync(inventoryId: string, overrides: Partial<Services> = {}): Promise<MasterSyncView | null> {
  const services = { ...servicesDefault, ...overrides };
  const row = await services.readSync(inventoryId);
  return row ? currentView(row, services) : null;
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
  if (countOf(supplier.count) !== 1 || !Array.isArray(supplier.data) || supplier.data.length !== 1 ||
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
  if (countOf(existing.count) !== 0) throw new Error("同じ商品コードがNEに存在します。上書きせず確認してください。");
  const shopTokens = await services.readTokens(binding);
  if (!shopTokens) throw new Error("ネクストエンジンの接続を確認できません。");
  const shops = await apiCall("/api_v1_master_shop/count", new URLSearchParams({
    access_token: shopTokens.accessToken, refresh_token: shopTokens.refreshToken,
    "shop_deleted_flag-eq": "0", wait_flag: "1",
  }), binding, shopTokens, services);
  if (countOf(shops.count) !== 0) throw new Error("NEに店舗が登録されています。自動連携設定を確認するまで送信しません。");
  await assertBinding(binding, services);
  const reserved = await services.createSync({
    inventoryId, draftId: draft.id, sku: plan.sku, fingerprint: syncIdentity(binding, plan.fingerprint),
    supplierCode, title: listing?.overrideTitle?.trim() || draft.title.trim(),
    cost: inventory.purchasePrice!, price: listing?.overridePrice ?? draft.price!,
    status: "RESERVED", requestedBy: who ?? undefined,
  });
  try {
    await assertBinding(binding, services);
    const latest = await services.readTokens(binding);
    if (!latest) throw new Error("接続が失われました。");
    const response = await apiCall("/api_v1_master_goods/upload", new URLSearchParams({
      access_token: latest.accessToken, refresh_token: latest.refreshToken,
      data_type: "csv", data: plan.prepared.csv,
    }), binding, latest, services);
    const receipt = parseNextEngineUploadReceipt(response);
    return currentView(await services.updateSync(reserved, { status: "QUEUED", queueId: receipt.queueId, lastError: null }), services);
  } catch {
    // The request may have reached NE. Keep the reservation and require reconciliation.
    try { await services.updateSync(reserved, { status: "UNKNOWN", lastError: "登録結果が不明です。NE側の状態を確認してください。" }); }
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
  const { binding, tokens } = await connectedToRow(row, services);
  if (row.queueId) {
    const queue = await checkGoodsUploadQueue(tokens, next => persistRotation(binding, next, services), row.queueId, services.request);
    await assertBinding(binding, services);
    if (queue.state === "FAILED") return currentView(await services.updateSync(row, { status: "FAILED", lastError: "NEの商品マスタ取込に失敗しました。NEでエラーを確認してください。" }), services);
    if (queue.state !== "MASTER_APPLIED") return currentView(await services.updateSync(row, { status: queue.state }), services);
  }
  const latest = await services.readTokens(binding);
  if (!latest) throw new Error("ネクストエンジンの接続を確認できません。");
  const result = await apiCall("/api_v1_master_goods/search", new URLSearchParams({
    access_token: latest.accessToken, refresh_token: latest.refreshToken,
    fields: "goods_id,goods_name,goods_supplier_id,goods_cost_price,goods_selling_price",
    "goods_id-eq": row.sku, offset: "0", limit: "2",
  }), binding, latest, services);
  await assertBinding(binding, services);
  if (!Array.isArray(result.data) || result.data.length === 0) {
    return currentView(await services.updateSync(row, { status: row.queueId ? "MASTER_APPLIED" : "UNKNOWN" }), services);
  }
  try {
    parsePrivateMasterReadback(result, { sku: row.sku, title: row.title, supplierCode: row.supplierCode, cost: row.cost, price: row.price });
  } catch {
    return currentView(await services.updateSync(row, { status: "UNKNOWN", lastError: "NEの商品内容が送信記録と一致しません。確認してください。" }), services);
  }
  return currentView(await services.updateSync(row, { status: "MASTER_CONFIRMED", lastError: null }), services);
}

/** A failed queue may be cleared only after confirming the exact SKU is absent in NE. */
export async function clearFailedNextEngineMasterSync(inventoryId: string, overrides: Partial<Services> = {}): Promise<void> {
  const services = { ...servicesDefault, ...overrides };
  const row = await services.readSync(inventoryId);
  if (!row || row.status !== "FAILED" || !row.queueId) throw new Error("取込失敗が確定した商品だけ再準備できます。");
  const { binding, tokens } = await connectedToRow(row, services);
  const queue = await checkGoodsUploadQueue(tokens, next => persistRotation(binding, next, services), row.queueId, services.request);
  if (queue.state !== "FAILED") throw new Error("NEの取込失敗を確認できません。");
  const latest = await services.readTokens(binding);
  if (!latest) throw new Error("ネクストエンジンの接続を確認できません。");
  const existing = await apiCall("/api_v1_master_goods/count", new URLSearchParams({
    access_token: latest.accessToken, refresh_token: latest.refreshToken, "goods_id-eq": row.sku,
  }), binding, latest, services);
  if (countOf(existing.count) !== 0) throw new Error("NEに商品が存在します。再送前に内容を確認してください。");
  await assertBinding(binding, services);
  await services.deleteSync(row);
}
