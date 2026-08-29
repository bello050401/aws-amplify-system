/**
 * [UNVERIFIED] カテゴリー一覧取得クエリ(BELLO統合改修 master指示書
 * Phase D — origin/claude/mercari-shops-auto-listing-ag0w6m branchの
 * integrations/mercari-shops/queries/categories.tsから移植、GraphQL
 * 文字列は無変更)。実Schema確認後にフィールド名を調整すること。
 *
 * 用途は2つ: (1) 出品下書きのカテゴリーマッピング選択肢の取得、
 * (2) TOKEN保存前の疎通確認(app/actions/mercariSecret.tsのZAICO同様の
 * 「保存前に実際にAPIを叩いて確認する」パターン) — 書き込みを一切
 * 伴わない最も軽量な操作としてこのクエリを流用している。
 */
export const PRODUCT_CATEGORIES_QUERY = /* GraphQL */ `
  query ProductCategories {
    productCategories {
      id
      name
      parentId
      children {
        id
      }
    }
  }
`;

export interface ProductCategoriesResponse {
  productCategories: {
    id: string;
    name: string;
    parentId: string | null;
    children: { id: string }[];
  }[];
}
