/**
 * [UNVERIFIED] カテゴリー一覧取得クエリ。実Schema確認後にフィールド名を調整すること
 * (docs/mercari-api.md 3節)。
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
