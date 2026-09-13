"use server";

import { revalidatePath } from "next/cache";
import { canEditInventory, getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import {
  bulkCreateListingDrafts,
  getChannelListing,
  getListingDraftForInventory,
  listListingsOverview,
  listListingsOverviewSafe,
  saveChannelOverride,
  saveListingDraft,
  listOnMercari,
  listOnBase,
  type ChannelOverrideInput,
  type ListingDraftInput,
  type ListingOverviewRow,
} from "@/lib/listing/service";
import type { ListingsOverviewLoadOutcome } from "@/lib/listing/overviewFailure";
import { fetchMercariCategories } from "@/lib/listing/mercari/adapter";
import { isMercariConnected } from "@/lib/listing/mercari/tokenAccess";
import { isBaseConnected } from "@/lib/base/oauth";
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

// BELLO統合業務OS 第二次完全完遂指示(2026-08-30) §4: BASEチャネル用の
// 対応するServer Action群 — Mercari用の上記と全く同じ権限境界。
export async function getBaseChannelListingAction(inventoryId: string): Promise<ChannelListingRecord | null> {
  return getChannelListing(inventoryId, "BASE");
}

export async function saveBaseChannelOverrideAction(inventoryId: string, input: ChannelOverrideInput): Promise<ChannelListingRecord> {
  const who = await requireEditPermission();
  const result = await saveChannelOverride(inventoryId, "BASE", input, who);
  revalidatePath(`/inventory/${inventoryId}/listing`);
  return result;
}

export async function listOnBaseAction(inventoryId: string): Promise<ChannelListingRecord> {
  const who = await requireEditPermission();
  const result = await listOnBase(inventoryId, who);
  revalidatePath(`/inventory/${inventoryId}/listing`);
  return result;
}

export async function isBaseConnectedAction(): Promise<boolean> {
  return isBaseConnected();
}

/**
 * BELLO統合改修 master指示書(2026-08-29統合改修版) §15/§16: 一覧ベース
 * のEC出品管理画面(app/inventory/(protected)/listings/page.tsx)向け。
 * 閲覧はrequireEditPermissionを課さない — 在庫詳細を読める人(VIEWER
 * 含む)なら出品状況の一覧閲覧も問題ない、既存のgetListingDraftAction/
 * getChannelListingActionと同じ閲覧権限モデル。
 */
export async function listListingsOverviewAction(): Promise<ListingOverviewRow[]> {
  return listListingsOverview();
}

/**
 * EC一覧P1 実失敗分類(2026-09-13): ListingsOverviewTable.tsxの再試行
 * ボタン(retryLoad)専用。`listListingsOverviewAction`(上記、
 * app/inventory/(protected)/listings/pricing-rules/assign/page.tsxが
 * 未変更のまま使い続ける、失敗したら例外を投げる版)とは別に用意する —
 * 再試行時も初回描画(ListingsOverviewData.tsx)と同じ
 * `listListingsOverviewSafe`(安全な分類情報を返す、例外を投げない版)を
 * 通すことで、「初回は分類できるが再試行は汎用エラーに戻る」という
 * 非対称を避ける。戻り値は行の配列(成功)か固定の分類コード(失敗)の
 * どちらか——GraphQLメッセージ原文・商品名・トークンは含まない。
 */
export async function listListingsOverviewSafeAction(): Promise<ListingsOverviewLoadOutcome<ListingOverviewRow>> {
  return listListingsOverviewSafe();
}

/** 一覧画面からの一括下書き作成(spec §16: 一括操作) — 書き込みなのでcanEditInventory境界を課す。 */
export async function bulkCreateListingDraftsAction(
  inventoryIds: string[],
): Promise<{ created: string[]; skipped: string[]; failed: { inventoryId: string; error: string }[] }> {
  const who = await requireEditPermission();
  const result = await bulkCreateListingDrafts(inventoryIds, who);
  if (result.created.length > 0) revalidatePath("/inventory/listings");
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
