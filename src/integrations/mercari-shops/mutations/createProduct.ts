/**
 * [UNVERIFIED] 商品作成ミューテーション。指示書36項の想定項目に基づく暫定版。
 * 実Schema確認後、`CreateProductInput` の実フィールド名に合わせて更新すること。
 */
export const CREATE_PRODUCT_MUTATION = /* GraphQL */ `
  mutation CreateProduct($input: CreateProductInput!) {
    createProduct(input: $input) {
      product {
        id
        status
        createdAt
        updatedAt
      }
    }
  }
`;
