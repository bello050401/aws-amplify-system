/**
 * [UNVERIFIED] 単一商品取得クエリ（Phase 2の商品同期機能で使用、指示書42項）。
 * Phase 1では `MercariShopsAdapter.getProduct` の実装のみ用意し、UIからは呼び出さない。
 */
export const PRODUCT_QUERY = /* GraphQL */ `
  query Product($id: ID!) {
    product(id: $id) {
      id
      status
      name
      price
    }
  }
`;

export interface ProductQueryResponse {
  product: {
    id: string;
    status: string | null;
    name: string;
    price: number;
  } | null;
}
