/**
 * QA-006: 一覧サイドバー(カテゴリ/保管場所の絞り込み)のURL構築。
 *
 * 修正前は InventorySidebar.tsx と CategoryFilterList.tsx がそれぞれ
 * 独自の `buildHref` を持ち、どちらも q/categoryIds/locationId の3つ
 * しか見ていなかった —— 詳細検索(advanced/adv)を適用した状態でカテゴ
 * リ/保管場所をクリックすると、その2つがURLから消えていた(詳細検索
 * UIごと閉じ、通常の一覧に戻る)。表示件数(limit)も同様に無条件で
 * 既定値(50件)へ戻っていた。
 *
 * ここへ1本化し、サイドバー操作(カテゴリ/保管場所/「すべての在庫」/
 * 「すべて解除」)はすべて q・advanced・adv・limit を引き継いだ上で
 * categoryIds/locationId だけを変える——「絞り込み操作で検索条件を
 * 黙って捨てない」を、ロジックが2箇所に分岐したまま保守されなくなる
 * のを防ぐため、実装を1箇所にする。
 *
 * 依存ゼロの純粋関数(lib/inventory/listReturnParams.tsと同じ理由 ——
 * このリポジトリのテスト実行環境には node_modules が無く、next/react
 * に依存するモジュールは実行して検証できない。ここを純粋関数に寄せる
 * ことで、素のnodeだけで挙動を検証できるようにしてある)。
 *
 * offsetは意図的にここへ含めない —— 絞り込み条件(カテゴリ/保管場所)
 * が変わった以上、直前のページ位置を残すと「存在しない/意味の異なる
 * ページに居続ける」ことになる。サイドバー操作は常に1ページ目へ戻す
 * (=戻り先のURLにoffsetを一切乗せない)。
 *
 * advanced/adv自体の中身の妥当性(壊れたJSON等)はここでは判定しない
 * ——app/inventory/(protected)/page.tsxのparseAdvancedQueryが「壊れた
 * URLはエラー画面にせず無視する」を一元的に担当しており、ここはその値
 * をそのまま素通しするだけに留める(二重に判定ロジックを持たない)。
 */
export interface SidebarFilterState {
  q?: string;
  categoryIds?: string[];
  locationId?: string;
  /** パネルの開閉状態("1"のみ意味を持つ)。searchParams.advancedをそのまま。 */
  advanced?: string;
  /** 詳細検索の実際の条件(JSON文字列)。searchParams.advをそのまま。 */
  adv?: string;
  /** 表示件数("100"のみ意味を持つ、既定50は省略)。 */
  limit?: string;
}

export function buildSidebarFilterHref(state: SidebarFilterState): string {
  const sp = new URLSearchParams();
  if (state.q) sp.set("q", state.q);
  if (state.categoryIds && state.categoryIds.length > 0) sp.set("categoryIds", state.categoryIds.join(","));
  if (state.locationId) sp.set("locationId", state.locationId);
  if (state.advanced) sp.set("advanced", state.advanced);
  if (state.adv) sp.set("adv", state.adv);
  if (state.limit) sp.set("limit", state.limit);
  const qs = sp.toString();
  return qs ? `/inventory?${qs}` : "/inventory";
}
