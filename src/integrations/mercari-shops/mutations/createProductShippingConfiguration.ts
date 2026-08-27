/**
 * [UNVERIFIED] 配送設定作成ミューテーション（指示書27, 29項、2026年6月以降提供とされる）。
 * 実Schema確認後にフィールド名を調整すること。
 */
export const CREATE_PRODUCT_SHIPPING_CONFIGURATION_MUTATION = /* GraphQL */ `
  mutation CreateProductShippingConfiguration($input: CreateProductShippingConfigurationInput!) {
    createProductShippingConfiguration(input: $input) {
      shippingConfiguration {
        id
        name
      }
    }
  }
`;

export interface CreateProductShippingConfigurationInput {
  name: string;
  rates: { destination: string; fee: number }[];
}

export interface CreateProductShippingConfigurationPayload {
  createProductShippingConfiguration: {
    shippingConfiguration: { id: string; name: string };
  };
}
