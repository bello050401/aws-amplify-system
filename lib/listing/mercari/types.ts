/**
 * Mercari Shops APIの型定義(BELLO統合改修 master指示書 Phase D —
 * origin/claude/mercari-shops-auto-listing-ag0w6m branchの
 * integrations/mercari-shops/types/{common,CreateProductInput,limits}.ts
 * を1ファイルへ統合して移植)。
 *
 * [UNVERIFIED] このファイルの値・フィールド名は、そのブランチの調査時点
 * で実際のMercari Shops GraphQL Schemaへネットワーク到達できなかった
 * ため確定できていない暫定値(元ブランチのdocs/mercari-api.md参照)。
 * この環境でも同じくMercari APIへの到達手段がないため、[UNVERIFIED]の
 * マークは維持したまま移植している — 実際のSandbox接続が確立できた
 * 時点で、実Schemaに合わせて更新すること。
 */

export interface GraphQLErrorItem {
  message: string;
  extensions?: {
    code?: string;
    [key: string]: unknown;
  };
}

export interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLErrorItem[];
}

/** [UNVERIFIED] */
export interface MercariCategory {
  id: string;
  name: string;
  parentId: string | null;
  hasChildren: boolean;
}

/** [UNVERIFIED] */
export interface MercariProductImageInput {
  url: string;
  sortOrder: number;
}

/** [UNVERIFIED] */
export interface MercariProductVariantInput {
  skuCode: string;
  stockQuantity: number;
  janCode?: string | null;
}

/** [UNVERIFIED] createProductの入力型。実Schema確認後に更新すること。 */
export interface CreateProductInput {
  name: string;
  description: string;
  price: number;
  categoryId: string;
  brandId?: string | null;
  condition: string; // ProductCondition enum値 (lib/listing/mercari/mapper/condition.ts経由で変換)
  images: MercariProductImageInput[];
  shippingPayer: string; // ShippingPayer enum値
  shippingMethod: string; // ShippingMethod enum値
  shippingDuration: string; // ShippingDuration enum値
  shippingFromStateId: string;
  status: string; // Product Status enum値(公開/下書き)
  variants: MercariProductVariantInput[];
  janCode?: string | null;
}

// 移植時の修正: 元ブランチのCreateProductPayload型は`{ product: {...} }`
// (createProductでラップされていない)だったが、同ブランチ自身の
// CREATE_PRODUCT_MUTATION文字列は`createProduct(input: $input) { product { ... } }`
// を返す形になっており、型とGraphQL文字列が食い違っていた(実APIへ
// 到達できず一度も実行されていなかったため、この不整合は検出されずに
// 残っていたとみられる)。ここではミューテーション文字列の実際の形に
// 合わせて`createProduct`のラップを型にも反映している。
export interface CreateProductPayload {
  createProduct: {
    product: {
      id: string;
      status?: string | null;
      createdAt?: string | null;
      updatedAt?: string | null;
    };
  };
}

/**
 * メルカリShops APIの文字数制限などの定数。
 * [UNVERIFIED] NAME_MAXはネットワーク制約により実Schemaから直接確認
 * できていない暫定値。DESCRIPTION_MAXは元ブランチの指示書で確定値と
 * されていた値をそのまま踏襲。
 */
export const MERCARI_LIMITS = {
  NAME_MAX: 40,
  DESCRIPTION_MAX: 3000,
} as const;
