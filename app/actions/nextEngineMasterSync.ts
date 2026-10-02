"use server";

import { revalidatePath } from "next/cache";
import { getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { clearFailedNextEngineMasterSync, getNextEngineMasterSync, listNextEngineSuppliers,
  refreshNextEngineMasterSync, startNextEngineMasterSync,
  type MasterSyncView, type NextEngineSupplierChoice } from "@/lib/listing/nextEngine/masterSync";

export type MasterSyncResult = { ok: true; value: MasterSyncView | null } | { ok: false; message: string };
export type NextEngineSuppliersResult = { ok: true; suppliers: NextEngineSupplierChoice[] } | { ok: false; message: string };
const safeMessages = new Set([
  "ネクストエンジンの商品送信が有効になっていません。",
  "登録済みの仕入先コードを指定してください。",
  "在庫と保存済みの出品下書きを確認してください。",
  "この商品の送信履歴があります。状態を確認してください。",
  "ネクストエンジンのアプリ設定が必要です。",
  "ネクストエンジンに接続してください。",
  "使用できる仕入先を確認できません。",
  "同じ商品コードがNEに存在します。上書きせず確認してください。",
  "NEに店舗が登録されています。自動連携設定を確認するまで送信しません。",
  "送信履歴を確保できません。送信していません。",
  "登録結果が不明です。再送信せず状態を確認してください。",
]);

export async function readNextEngineMasterSyncAction(inventoryId: string): Promise<MasterSyncResult> {
  if (!await getInventoryRole()) return { ok: false, message: "在庫の閲覧権限が必要です。" };
  try { return { ok: true, value: await getNextEngineMasterSync(inventoryId) }; }
  catch { return { ok: false, message: "NEの商品登録状態を確認できませんでした。" }; }
}

export async function listNextEngineSuppliersAction(): Promise<NextEngineSuppliersResult> {
  if (await getInventoryRole() !== "ADMIN") return { ok: false, message: "管理者のみ確認できます。" };
  try { return { ok: true, suppliers: await listNextEngineSuppliers() }; }
  catch { return { ok: false, message: "NEの仕入先を確認できませんでした。" }; }
}

export async function startNextEngineMasterSyncAction(inventoryId: string, supplierCode: string): Promise<MasterSyncResult> {
  if (await getInventoryRole() !== "ADMIN") return { ok: false, message: "NEへの商品送信は管理者のみ操作できます。" };
  try {
    const value = await startNextEngineMasterSync(inventoryId, supplierCode, await getCurrentInventoryUserEmail());
    revalidatePath(`/inventory/${inventoryId}/listing`);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, message: error instanceof Error && safeMessages.has(error.message) ? error.message
      : "NEの商品登録を完了できませんでした。再送せず状態を確認してください。" };
  }
}

export async function refreshNextEngineMasterSyncAction(inventoryId: string): Promise<MasterSyncResult> {
  if (!await getInventoryRole()) return { ok: false, message: "在庫の閲覧権限が必要です。" };
  try {
    const value = await refreshNextEngineMasterSync(inventoryId);
    revalidatePath(`/inventory/${inventoryId}/listing`);
    return { ok: true, value };
  } catch { return { ok: false, message: "NEの商品登録状態を確認できませんでした。再送しないでください。" }; }
}

export async function clearFailedNextEngineMasterSyncAction(inventoryId: string): Promise<MasterSyncResult> {
  if (await getInventoryRole() !== "ADMIN") return { ok: false, message: "NEへの商品送信は管理者のみ操作できます。" };
  try {
    await clearFailedNextEngineMasterSync(inventoryId);
    revalidatePath(`/inventory/${inventoryId}/listing`);
    return { ok: true, value: null };
  } catch { return { ok: false, message: "NEの失敗記録を再準備できません。NEの商品と処理結果を確認してください。" }; }
}
