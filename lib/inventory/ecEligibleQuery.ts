import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { listAllMasterEntries } from "@/lib/inventory/masters";
import { isEcListingEligible } from "@/lib/listing/ecEligibility";
import { toListRow, type InventoryListRow } from "@/lib/inventory/queries";

/**
 * EC出品の対象になり得る在庫だけを、カテゴリのGSIから直接引く。
 *
 * ## なぜ必要か —— 実測
 *
 * EC出品一覧は、在庫を**全件読んでから**対象外カテゴリを落として
 * 表示していた。実データで数えると:
 *
 *   在庫総数                        5,313件
 *   うち対象外カテゴリ               4,965件
 *     発送完了 4,565 / 破棄 178 / 事務所備品 134 /
 *     補修待ち 49 / 無償提供 31 / コーディネート用 8
 *   実際に表示される対象              348件
 *
 * つまり **348件を出すために5,313件を読んでいた**。読み取りの実測値は
 * 全件スキャンで 9,246ms(7往復)。
 *
 * カテゴリ別のGSI(inventoriesByCategoryId)は既に存在するので、
 * 対象カテゴリだけを引けば読む量が15分の1になる。ページを切って
 * 件数を減らす方法もあるが、この画面は**取得済みの全件に対して
 * 絞り込み・検索**を行うため、件数を削ると検索できる範囲が狭まる。
 * 「対象だけを全部引く」なら、検索の範囲を一切狭めずに速くできる。
 *
 * ## 境界(正直に)
 *
 * カテゴリが未設定の在庫はカテゴリGSIに現れないため、この関数の
 * 結果には含まれない(実測で1件)。EC出品はカテゴリの対応付けが
 * 必須なので、カテゴリ未設定の在庫はそもそも出品できず、この一覧に
 * 出ないことによる実害は無い。件数は `uncategorizedExcluded` として
 * 返すので、呼び出し側が黙って落とさずに扱える。
 */

export interface EcEligibleInventoryResult {
  items: InventoryListRow[];
  /** 引いた対象カテゴリの数。 */
  queriedCategories: number;
  /** カテゴリ未設定のため対象外になった件数は数えられないので、その旨を示す。 */
  uncategorizedExcluded: true;
}

/** 1カテゴリあたりの取得上限。最大カテゴリ(販売中277件)でも1〜2往復で収まる。 */
const PAGE_SIZE = 200;
/** 1カテゴリが異常に大きい場合の歯止め。 */
const MAX_PAGES_PER_CATEGORY = 20;

export async function listEcEligibleInventory(): Promise<EcEligibleInventoryResult> {
  const categories = await listAllMasterEntries("Category");
  const eligible = categories.filter((c) => isEcListingEligible(c.name));

  // カテゴリごとの取得は互いに独立しているので同時に投げる。
  // カテゴリ数は実測19件(うち対象13件)で、同時実行数として問題にならない。
  const perCategory = await Promise.all(
    eligible.map(async (category) => {
      const rows: InventoryListRow[] = [];
      let nextToken: string | null | undefined;
      let pages = 0;
      do {
        const { data, nextToken: nt, errors } = await serverDataClient.models.Inventory.listInventoryByCategoryId(
          { categoryId: category.id },
          { limit: PAGE_SIZE, nextToken: nextToken ?? undefined, ...inventoryAuthMode },
        );
        // 取得エラーを0件と区別する。黙って空にすると「その分類の商品が
        // 無い」ように見えてしまう。
        if (errors) throw new Error(`在庫の取得に失敗しました(カテゴリ ${category.name}): ${errors.map((e) => e.message).join("; ")}`);
        rows.push(...data.map((d) => toListRow(d as never)));
        nextToken = nt;
        pages++;
      } while (nextToken && pages < MAX_PAGES_PER_CATEGORY);
      return rows;
    }),
  );

  const items = perCategory.flat();
  // 一覧の並びは在庫一覧と揃える(更新の新しい順)。
  items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));

  return { items, queriedCategories: eligible.length, uncategorizedExcluded: true };
}
