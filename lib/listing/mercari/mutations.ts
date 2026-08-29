/**
 * [UNVERIFIED] 商品作成ミューテーション(BELLO統合改修 master指示書
 * Phase D — origin/claude/mercari-shops-auto-listing-ag0w6m branchの
 * integrations/mercari-shops/mutations/createProduct.tsから移植、
 * GraphQL文字列は無変更)。実Schema確認後、CreateProductInputの実
 * フィールド名に合わせて更新すること。
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
