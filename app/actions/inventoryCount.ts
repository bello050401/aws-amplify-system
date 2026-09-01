"use server";

import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { countActiveInventory } from "@/lib/inventory/inventoryPage";
import type { InventoryCursorListFilters } from "@/lib/inventory/inventoryCursorList";

/**
 * 在庫の総件数だけを返す。
 *
 * 一覧の描画とは別経路にしてある（理由は InventoryTotalCount.tsx の
 * コメント参照）。ここで失敗しても一覧は表示され続ける。
 *
 * 例外を投げずに `{ok:false}` を返すのは、このリポジトリの他の
 * Server Action と同じ理由 —— production build では throw した
 * メッセージが Next.js にマスクされ、利用者に何も伝わらない
 * （app/actions/ai.ts 冒頭のコメント）。
 */
export async function getInventoryCountAction(
  filters: InventoryCursorListFilters,
): Promise<{ ok: true; total: number } | { ok: false }> {
  try {
    const role = await getInventoryRole();
    // 一覧を見られる人だけ。認証境界は速度のために緩めない（§8.2）。
    if (!role) return { ok: false };
    return { ok: true, total: await countActiveInventory(filters) };
  } catch (err) {
    console.warn("[inventoryCount] 件数を集計できませんでした", { error: err instanceof Error ? err.name : "unknown" });
    return { ok: false };
  }
}
