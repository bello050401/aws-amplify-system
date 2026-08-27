/**
 * [UNVERIFIED] メルカリShops API `createProduct` の入力型。
 * docs/mercari-api.md 4節参照。実Schema確認後に更新すること。
 * 将来的には `npm run mercari:codegen` による自動生成型に置き換える。
 */

export interface MercariProductImageInput {
  url: string;
  sortOrder: number;
}

export interface MercariProductVariantInput {
  skuCode: string;
  stockQuantity: number;
  janCode?: string | null;
}

export interface CreateProductInput {
  name: string;
  description: string;
  price: number;
  categoryId: string;
  brandId?: string | null;
  condition: string; // ProductCondition enum値 (mapper経由で変換)
  images: MercariProductImageInput[];
  shippingPayer: string; // ShippingPayer enum値
  shippingMethod: string; // ShippingMethod enum値
  shippingDuration: string; // ShippingDuration enum値
  shippingFromStateId: string;
  shippingConfigurationId?: string | null;
  status: string; // Product Status enum値 (公開/下書き)
  variants: MercariProductVariantInput[];
  janCode?: string | null;
  catalogId?: string | null;
}

export interface CreateProductPayload {
  product: {
    id: string;
    status?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
  };
}
