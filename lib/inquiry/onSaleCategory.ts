import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";

/**
 * 問い合わせの商品特定で見る在庫の範囲を、カテゴリで決める。
 *
 * ── 基本は出品中だけ(2026-09-03 利用者指示) ──────────────────────
 *
 * 「商品は出品中からしかこない」。お客様が問い合わせてくるのは販売ページに
 * 出ている商品だけなので、それ以外を候補に入れる意味が無い。発送完了
 * (4,329件)まで含めて商品名で照合していたため、同名の過去在庫が候補に
 * 混ざって1件に絞れず、かつ5,313件を毎回走査していた。
 *
 * ── ただし「販売中に無い＝対象外」ではない ──────────────────────
 *
 * BELLOの在庫カテゴリは ZAICO からの同期で入るため、**BASEの出品状態より
 * 遅れることがある**。実測(2026-09-03)でも、BASEで出品中の
 * BoConcept Elba Lounge Chair に対応する在庫は「五十嵐さん」「複数在庫
 * 未出品」にあり、販売中には1件も無かった。ここで打ち切ると、実際に
 * 売っている商品の問い合わせを取りこぼす。
 *
 * そこで、販売中で見つからず、かつBASE側の強い手がかりがある場合に限って
 * **明らかな過去在庫だけを除いた範囲**へ広げる(SYNC_LAG_FALLBACK)。
 * 発送完了・破棄・売り切れを無差別に拾うと誤特定になるので、そこは除く。
 */

/** 出品中を表すカテゴリ名。BELLOの運用上の呼称。 */
export const ON_SALE_CATEGORY_NAME = "販売中";

/**
 * 同期遅れのフォールバックでも候補にしないカテゴリ。
 *
 * 「もう売る対象ではない」ことが名前から確定するものだけを挙げる。
 * 迷うもの(保留・補修待ち・出品待ち等)は**除外しない** —— 除外しすぎると
 * 取りこぼしが増え、フォールバックの意味が無くなる。誤特定の抑止は
 * 「BASE商品名の強い一致でしか採用しない」側で担保する。
 */
export const PAST_INVENTORY_CATEGORY_NAMES = ["発送完了", "破棄", "売り切れ"] as const;

const CACHE_TTL_MS = 5 * 60_000;
let cache: { at: number; value: InquiryCategoryScopes } | null = null;

export interface InquiryCategoryScopes {
  /** 「販売中」カテゴリのID。解決できなければ null。 */
  onSaleCategoryId: string | null;
  /** 明らかな過去在庫のカテゴリID。 */
  pastCategoryIds: string[];
  /** カテゴリ一覧そのものを読めたか。false なら判断材料が無い。 */
  resolved: boolean;
}

export function clearInquiryCategoryScopesCache(): void {
  cache = null;
}

export async function getInquiryCategoryScopes(): Promise<InquiryCategoryScopes> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const { data, errors } = await serverDataClient.models.Category.list({ limit: 500, ...inventoryAuthMode });
  if (errors && errors.length > 0) {
    // 読めなかったことを「該当なし」に丸めない。呼び出し側は
    // 内部エラーとして扱う(黙って全在庫へ広げない)。
    console.warn("[inquiryCategories] カテゴリを読めませんでした。", errors.map((e) => e.message).join("; "));
    return { onSaleCategoryId: null, pastCategoryIds: [], resolved: false };
  }

  const rows = (data ?? []) as unknown as { id: string; name?: string | null }[];
  const value: InquiryCategoryScopes = {
    onSaleCategoryId: rows.find((c) => c.name === ON_SALE_CATEGORY_NAME)?.id ?? null,
    pastCategoryIds: rows
      .filter((c) => c.name && (PAST_INVENTORY_CATEGORY_NAMES as readonly string[]).includes(c.name))
      .map((c) => c.id),
    resolved: true,
  };
  cache = { at: Date.now(), value };
  return value;
}
