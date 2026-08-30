"use server";

import { revalidatePath } from "next/cache";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { canEditInventory, getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { diffField, logInventoryHistory, type HistoryFieldChange } from "@/lib/inventory/history";
import { INLINE_EDIT_HISTORY_SUFFIX, type InlineEditChanges } from "@/lib/inventory/inlineEdit";

export interface BulkInventoryEditItem {
  id: string;
  changes: InlineEditChanges;
}

export interface BulkInventoryEditItemResult {
  id: string;
  success: boolean;
  error?: string;
}

/** Label/before-value pairs for the fields inline edit can touch — used only to build InventoryHistory rows below, keyed the same as InlineEditChanges. */
const FIELD_LABELS: Record<keyof InlineEditChanges, string> = {
  name: "商品名",
  quantity: "数量",
  locationId: "保管場所",
  categoryId: "カテゴリ",
  plannedSalePrice: "販売予定価格",
  salePrice: "販売価格",
  purchasePrice: "購入価格",
  market: "市場",
  note: "備考",
  conditionRating: "コンディション評価",
  damageNotes: "傷・汚れメモ",
};

/**
 * 一覧直接編集の一括保存 (統合改善指示書 §11/§12)。1文字ごとの保存で
 * はなく、dirty行だけをまとめて1回のアクション呼び出しで送る —
 * クライアント側(InventoryTable/DirectEditProvider)がローカルstateで
 * 変更を溜め、保存操作でここへ渡す。
 *
 * 1件ずつ順番に処理し(Promise.allではない)、他の行の成功/失敗に関わら
 * ず各行が独立して成功/失敗するようにする — 10件中9件成功・1件失敗の
 * ようなケースで、成功した9件までは確実に反映されなければならない
 * (spec §12)。新規登録/詳細編集のresolveImages等、既存コードの
 * 「1件ずつ処理してpartial failureを許す」パターンを踏襲。
 *
 * ADMIN/EDITORのみ実行可能 — VIEWERはUI側でもボタン非表示だが、直接
 * このServer Actionを呼んでも同様に拒否される。
 */
export async function bulkUpdateInventoryListFields(items: BulkInventoryEditItem[]): Promise<BulkInventoryEditItemResult[]> {
  const role = await getInventoryRole();
  if (!canEditInventory(role)) {
    throw new Error("在庫を編集する権限がありません（ADMIN または EDITOR のみ）。");
  }
  if (items.length === 0) return [];

  const who = await getCurrentInventoryUserEmail();
  const results: BulkInventoryEditItemResult[] = [];

  for (const item of items) {
    try {
      const { data: existing } = await serverDataClient.models.Inventory.get({ id: item.id }, inventoryAuthMode);
      if (!existing || existing.deletedAt) {
        throw new Error("対象の在庫が見つかりません。");
      }

      // changesに含まれるキーだけを送る — 触れていないフィールドは
      // undefinedのままAmplifyの.update()から除外され、既存値を保持する
      // (createInventory/updateInventoryと同じ規約)。
      const { errors } = await serverDataClient.models.Inventory.update(
        {
          id: item.id,
          updatedBy: who ?? undefined,
          // 第六ラウンドP0-5: 一覧の直接編集による実データ変更なので
          // 一覧の並び順(listUpdatedAt)も更新対象とする。
          listUpdatedAt: new Date().toISOString(),
          ...item.changes,
        },
        inventoryAuthMode,
      );
      if (errors) {
        throw new Error(`更新に失敗しました: ${JSON.stringify(errors)}`);
      }

      const changes: HistoryFieldChange[] = [];
      const push = (c: HistoryFieldChange | null) => c && changes.push(c);
      for (const key of Object.keys(item.changes) as (keyof InlineEditChanges)[]) {
        const before = existing[key as keyof typeof existing] as string | number | null | undefined;
        const after = item.changes[key];
        const diff = diffField(FIELD_LABELS[key], before ?? null, after ?? null);
        if (diff) push({ ...diff, fieldName: `${diff.fieldName}${INLINE_EDIT_HISTORY_SUFFIX}` });
      }
      await logInventoryHistory(item.id, who, changes);

      results.push({ id: item.id, success: true });
    } catch (err) {
      results.push({ id: item.id, success: false, error: err instanceof Error ? err.message : "更新に失敗しました。" });
    }
  }

  revalidatePath("/inventory");
  return results;
}
