"use server";

import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { loadSalesItems } from "@/lib/inventory/salesView";
import type { SalesTargetItem } from "@/lib/inventory/sales";

/**
 * 売上画面の対象商品一覧(明細)。2026-09-11追加修正「開いたとき即表示
 * する」で、明細の取得(Inventoryへの月フィルタ付きScan)をページの
 * 初期描画から切り離し、ユーザーが明示的に開いたときだけ呼ぶ経路にした
 * (app/inventory/(protected)/sales/SalesItemsSection.tsx参照)。
 *
 * Server Actionはページのレンダリング経路とは別の独立したエンドポイント
 * ——ページ側でgetInventoryRoleを確認していても、このAction自身が直接
 * 呼ばれ得る以上、ここでも同じ認可チェックをやり直す(inventoryCount.ts
 * のgetInventoryCountActionと同じ考え方、§4「認可を保ち」)。
 *
 * 例外を投げずに`{ok:false}`を返すのは、他のServer Actionと同じ理由
 * ——production buildではthrowしたメッセージがNext.jsにマスクされ、
 * 利用者に何も伝わらない(app/actions/ai.ts冒頭のコメント)。呼び出し側
 * (SalesItemsSection)はこれを見て「取得エラー・再試行」を出す。
 */
export async function getSalesItemsAction(
  year: number,
  month: number,
): Promise<{ ok: true; items: SalesTargetItem[] } | { ok: false }> {
  try {
    const role = await getInventoryRole();
    if (!role) return { ok: false };
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return { ok: false };
    const items = await loadSalesItems(year, month);
    return { ok: true, items };
  } catch (err) {
    console.warn("[sales] 対象商品一覧を取得できませんでした", { error: err instanceof Error ? err.name : "unknown" });
    return { ok: false };
  }
}
