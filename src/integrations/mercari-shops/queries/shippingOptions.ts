/**
 * [UNVERIFIED] 配送方法(ShippingMethod)の選択肢を動的取得するクエリ。
 * 指示書26項「ハードコードだけに依存せず、API仕様変更時に修正しやすい構造」に対応するため、
 * まずAPIからの動的取得を試み、失敗時のみ最小限のフォールバックを使う
 * （`ShippingService` 側で制御。 docs/mercari-api.md 5節参照）。
 */
export const SHIPPING_METHODS_QUERY = /* GraphQL */ `
  query ShippingMethods {
    __type(name: "ShippingMethod") {
      enumValues {
        name
        description
      }
    }
  }
`;

export interface ShippingMethodsResponse {
  __type: {
    enumValues: { name: string; description: string | null }[];
  } | null;
}
