"use server";

import { revalidatePath } from "next/cache";
import { canEditInventory, getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import {
  getChannelListing,
  getListingDraftForInventory,
  saveChannelOverride,
  saveListingDraft,
  listOnMercari,
  type ChannelOverrideInput,
  type ListingDraftInput,
} from "@/lib/listing/service";
import { fetchMercariCategories } from "@/lib/listing/mercari/adapter";
import { isMercariConnected } from "@/lib/listing/mercari/tokenAccess";
import type { ChannelListingRecord, ListingDraftRecord, ShippingPayerCode } from "@/lib/listing/types";

/**
 * BELLO統合改修 master指示書 Phase D — EC出品機能のServer Action層。
 * 権限境界(spec: 「READ ONLYとの共存」): Inventory編集権限
 * (canEditInventory — ADMIN/EDITOR)と同じ境界を出品操作にも適用する
 * (spec: 「Listing: create/edit allowed」)。VIEWERは読み取りのみ
 * (getListingDraftForInventory/getChannelListing自体はここでは権限
 * チェックしていない — 呼び出し元のServer Component側で在庫詳細を
 * 読める人なら出品状況の閲覧も問題ない、既存のInventory詳細ページと
 * 同じ閲覧権限モデル)。
 *
 * このファイルはInventoryモデルへ一切書き込まない —
 * lib/listing/service.tsと同じ境界をServer Action層でも維持している
 * (実際の書き込みはservice.ts経由のみ、という一本道)。
 */
async function requireEditPermission(): Promise<string | null> {
  const role = await getInventoryRole();
  if (!canEditInventory(role)) {
    throw new Error("EC出品の作成・編集にはADMINまたはEDITOR権限が必要です。");
  }
  return getCurrentInventoryUserEmail();
}

export async function getListingDraftAction(inventoryId: string): Promise<ListingDraftRecord | null> {
  return getListingDraftForInventory(inventoryId);
}

export async function getChannelListingAction(inventoryId: string): Promise<ChannelListingRecord | null> {
  return getChannelListing(inventoryId, "MERCARI_SHOPS");
}

export async function saveListingDraftAction(inventoryId: string, input: ListingDraftInput): Promise<ListingDraftRecord> {
  const who = await requireEditPermission();
  const result = await saveListingDraft(inventoryId, input, who);
  revalidatePath(`/inventory/${inventoryId}/listing`);
  return result;
}

export async function saveChannelOverrideAction(inventoryId: string, input: ChannelOverrideInput): Promise<ChannelListingRecord> {
  const who = await requireEditPermission();
  const result = await saveChannelOverride(inventoryId, "MERCARI_SHOPS", input, who);
  revalidatePath(`/inventory/${inventoryId}/listing`);
  return result;
}

export async function listOnMercariAction(inventoryId: string, shippingPayer: ShippingPayerCode): Promise<ChannelListingRecord> {
  const who = await requireEditPermission();
  const result = await listOnMercari(inventoryId, shippingPayer, who);
  revalidatePath(`/inventory/${inventoryId}/listing`);
  return result;
}

/**
 * カテゴリー選択肢の取得 — Mercari未接続(TOKEN未設定)の場合は空配列を
 * 返す(spec: 「認証情報が未設定の場合、そこだけをBLOCKED_BY_USERにする
 * — 下書き作成・マッピングUI自体は動作させる」)。UIはこの空配列を
 * 「Mercari接続が必要です」という案内表示のトリガーとして使う。
 */
export async function listMercariCategoriesAction(): Promise<{ id: string; name: string; parentId: string | null }[]> {
  await requireEditPermission();
  if (!(await isMercariConnected())) return [];
  try {
    const categories = await fetchMercariCategories();
    return categories.map((c) => ({ id: c.id, name: c.name, parentId: c.parentId }));
  } catch (err) {
    console.error("[listMercariCategoriesAction] failed:", err);
    return [];
  }
}
