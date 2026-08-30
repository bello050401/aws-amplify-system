import { normalizeMasterName } from "@/lib/inventory/masters";

/**
 * BELLO統合業務OS指示書(2026-08-30) §12/§94: EC出品一覧の対象外
 * カテゴリー。単なるfrontend filterではなく、以下すべてで適用する
 * ことが明示要件:
 *   initial fetch / search / category filter / status filter /
 *   pagination / bulk selection / bulk draft / direct route /
 *   product detail listing action / server action / API mutation /
 *   background listing
 *
 * そのため「表示するかどうか」の1箇所判定(lib/listing/service.tsの
 * listListingsOverview)だけでなく、実際にListingDraft/ChannelListingへ
 * 書き込む経路(saveListingDraft/saveChannelOverride/listOnMercari/
 * bulkCreateListingDrafts、すべてlib/listing/service.ts)の全部から
 * この1つの関数を呼ぶ — 一覧に表示されない商品でも、直接URLや
 * Server Actionを叩けば出品できてしまう、という抜け道を防ぐ
 * (§12「これは単なるfrontend filterではない」への対応)。
 *
 * カテゴリー名で判定する(categoryIdの固定値ハードコードではない)理由:
 * lib/inventory/masterSeed.tsのCATEGORY_SEEDが実際の初期値としてこの
 * 6つの名称を作成するが、Category自体はADMINが自由に作成・改名できる
 * マスタであり、特定の環境のcategoryId値は再現性が無い(実行のたびに
 * 異なるIDが振られる) — 名称の完全一致(NFKC正規化・trim・空白畳み込み
 * ・大文字小文字無視、lib/inventory/masters.tsのnormalizeMasterNameと
 * 同じ正規化)で判定するほうが、実際の運用データと一致する。
 */
const EXCLUDED_CATEGORY_NAMES = ["補修待ち", "発送完了", "事務所備品", "コーディネート用", "無償提供", "破棄"] as const;

const EXCLUDED_CATEGORY_NAMES_NORMALIZED = new Set(EXCLUDED_CATEGORY_NAMES.map(normalizeMasterName));

/**
 * `categoryName`はcategoryId解決後の実際のCategory.name(未設定/削除済み
 * カテゴリならnull)。nullの場合は除外しない(§120「6除外category以外
 * でも、stock0・販売停止・必要field不足ならREADYにしない」— カテゴリー
 * 未設定はこの除外policyの対象ではなく、EC出品自体は別の必須項目
 * (画像/コンディション等、lib/listing/mercari/adapter.tsの既存検証)で
 * 別途ブロックされる)。
 */
export function isEcListingEligible(categoryName: string | null): boolean {
  if (!categoryName) return true;
  return !EXCLUDED_CATEGORY_NAMES_NORMALIZED.has(normalizeMasterName(categoryName));
}

/** UI/エラーメッセージ表示用。 */
export function ecListingIneligibleReason(categoryName: string): string {
  return `カテゴリー「${categoryName}」はEC出品の対象外です。`;
}

export { EXCLUDED_CATEGORY_NAMES };

/**
 * categoryId → Category.name の解決。呼び出し元(lib/listing/service.ts)
 * がlib/inventory/masters.tsのlistAllMasterEntries("Category")を
 * 1回だけ呼んで結果をこの関数へ渡す — bulkCreateListingDraftsのように
 * 複数商品をループする場合でも、ループの外で1回構築すれば済む
 * (Categoryマスタ自体は既にこのアプリ全体で「まとめて全件取得して
 * メモリ上でjoinする」規模として扱われている、CATEGORY_SEED付近の
 * コメント参照)。
 */
export type CategoryNameLookup = (categoryId: string | null) => string | null;

export function buildCategoryNameLookup(categories: { id: string; name: string }[]): CategoryNameLookup {
  const map = new Map(categories.map((c) => [c.id, c.name]));
  return (categoryId) => (categoryId ? (map.get(categoryId) ?? null) : null);
}
