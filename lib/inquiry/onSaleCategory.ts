import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";

/**
 * 問い合わせの商品特定を「出品中の在庫」だけに絞るためのカテゴリ解決。
 *
 * ── なぜ絞るのか(2026-09-03 利用者指示) ──────────────────────────
 *
 * 「商品は出品中からしかこない」。お客様が問い合わせてくるのは販売ページに
 * 出ている商品だけなので、それ以外を候補に入れる意味が無い。実際、発送完了
 * (4,329件)まで含めて商品名で照合していたため、
 *
 *   - 同名の過去在庫が候補に混ざって1件に絞れない
 *   - 5,313件を走査するので遅い
 *
 * という二重の問題が出ていた。
 *
 * ── なぜ名前で引くのか ──────────────────────────────────────────
 *
 * カテゴリIDをコードへ書くと、環境ごとに違う値になり、Stagingで動いても
 * 本番で黙って0件になる。カテゴリ名はBELLOの運用そのものなので、名前で
 * 引いてIDへ解決する。
 */

/** 出品中を表すカテゴリ名。BELLOの運用上の呼称。 */
export const ON_SALE_CATEGORY_NAME = "販売中";

const CACHE_TTL_MS = 5 * 60_000;
let cache: { at: number; id: string | null } | null = null;

export function clearOnSaleCategoryCache(): void {
  cache = null;
}

/**
 * 「販売中」カテゴリのID。見つからなければ null。
 *
 * **null を「該当なし」として扱わない。** 呼び出し側は絞り込みを
 * 諦める(全件を見る)こと。ここで空の結果を返すと、カテゴリ名が変わった
 * 瞬間にすべての問い合わせで商品が特定できなくなり、しかも
 * 「商品が見つからない」としか表示されないため原因に辿り着けない。
 */
export async function getOnSaleCategoryId(): Promise<string | null> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.id;

  const { data, errors } = await serverDataClient.models.Category.list({
    filter: { name: { eq: ON_SALE_CATEGORY_NAME } },
    limit: 50,
    ...inventoryAuthMode,
  });
  if (errors && errors.length > 0) {
    // 読めなかったことを「無かった」に丸めない。絞り込みを諦めるだけにする。
    console.warn(
      "[onSaleCategory] カテゴリを読めませんでした。出品中での絞り込みを行わずに続行します。",
      errors.map((e) => e.message).join("; "),
    );
    return null;
  }
  const hit = (data ?? []).find((c) => c.name === ON_SALE_CATEGORY_NAME) ?? null;
  const id = hit?.id ?? null;
  cache = { at: Date.now(), id };
  return id;
}
