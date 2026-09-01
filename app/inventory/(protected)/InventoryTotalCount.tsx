import { countActiveInventory } from "@/lib/inventory/inventoryPage";
import type { InventoryCursorListFilters } from "@/lib/inventory/inventoryCursorList";

/**
 * 総件数だけを担当するServer Component。
 *
 * 【なぜ分けたか】総件数は本質的に全件読まないと出せない。一方、
 * 一覧の行は表示するぶんだけで足りる。両方を1回のawaitにまとめると、
 * 50件を出すために全件読み終わるのを待つことになる —— 実測で
 * TTFB約8秒の原因がまさにこれだった。
 *
 * 呼び出し側は <Suspense> でこれを包む。行は先に描画され、件数だけが
 * 後から差し込まれる。件数を「概算」や「50件以上」に落とさずに済む。
 */
export async function InventoryTotalCount({ filters }: { filters: InventoryCursorListFilters }) {
  const total = await countActiveInventory(filters);
  return <>{total.toLocaleString("ja-JP")}件</>;
}
