import "server-only";
import type { InventoryCursorListFilters } from "./inventoryCursorList";

/**
 * 在庫の総件数キャッシュ（2026-09-04 健全化 PHASE 6）。
 *
 * ── なぜ独立したファイルにしてあるか ────────────────────────────
 *
 * 元は lib/inventory/inventoryPage.ts の中にあった。そこは
 * serverDataClient も queries.ts も引き込む重いモジュールなので、
 * **在庫を書き換える側から「キャッシュを捨てる」ためだけに import する
 * のが割に合わなかった**。結果、無効化を呼んでいたのは画面から直接叩く
 * Server Action だけで、CSV取込・ZAICO同期・重複統合のように
 * **在庫の件数が変わる経路が無効化を呼んでいなかった**。
 *
 * lib/inventory/masterCache.ts と同じ考え方で、キャッシュ本体を
 * 依存の無い小さなファイルへ出す。こうしておけば、書き込み処理の
 * すぐ隣で1行呼ぶだけで済む。
 *
 * ── 何を守っているか ────────────────────────────────────────────
 *
 * 総件数は本質的に全件を数えないと出せない（実測 345〜715ms）。
 * 同じ条件の集計をプロセス内に60秒だけ持つ。在庫は編集されるので長くは
 * 持たない —— 60秒なら、同じ画面を続けて開き直しても1回で済み、かつ
 * 「登録したのに件数が増えない」が長く続くことはない。
 *
 * キャッシュはプロセスローカル。SSRのLambdaは複数インスタンスに
 * 分かれるので、ここでの無効化が効くのは**同じインスタンスだけ**。
 * それでも「自分が今登録した直後に古い件数を見る」という一番目に付く
 * ケースは、同一インスタンスに当たる確率が高いので効果がある。
 */

/** 同じ条件の集計をプロセス内に持つ時間。 */
export const COUNT_TTL_MS = 60_000;

const countCache = new Map<string, { at: number; value: number }>();

export function inventoryCountCacheKey(filters: InventoryCursorListFilters): string {
  return JSON.stringify({
    c: [...(filters.categoryIds ?? [])].sort(),
    l: filters.locationId ?? null,
    s: filters.statusId ?? null,
  });
}

export function readInventoryCount(key: string): number | null {
  const hit = countCache.get(key);
  if (hit && Date.now() - hit.at < COUNT_TTL_MS) return hit.value;
  return null;
}

export function writeInventoryCount(key: string, value: number): void {
  countCache.set(key, { at: Date.now(), value });
}

/**
 * 在庫の**件数が変わりうる**書き込みをしたあとに必ず呼ぶ。
 *
 * 呼ぶべき場所（2026-09-04 時点で全て呼んでいる）:
 *   app/actions/inventory.ts        新規登録 / 編集 / 削除
 *   app/actions/inventoryBulkEdit.ts 一括編集
 *   lib/inventory/inventoryImport.ts CSV取込の新規作成
 *   lib/inventory/zaicoSyncPorts.ts  ZAICO同期の新規作成
 *   lib/inventory/zaicoDuplicateAudit.ts 重複統合による削除
 *
 * 新しく在庫を作る/消す経路を足したら、ここへも足すこと。
 */
export function clearInventoryCountCache(): void {
  countCache.clear();
}
