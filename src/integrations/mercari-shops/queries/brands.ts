/**
 * [UNVERIFIED] ブランド検索クエリ (指示書17項)。実Schema確認後に調整すること。
 */
export const PRODUCT_BRANDS_QUERY = /* GraphQL */ `
  query ProductBrands($query: String) {
    productBrands(query: $query) {
      id
      name
    }
  }
`;

export interface ProductBrandsResponse {
  productBrands: { id: string; name: string }[];
}

export interface ProductBrandsVariables {
  query?: string;
}
