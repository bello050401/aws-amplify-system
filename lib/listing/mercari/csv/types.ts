/**
 * Mercari Shops CSV 1行分の「論理フィールド」表現。
 * 88列そのものではなく、名前付きフィールドとして持ち、
 * `mapRowToCells.ts`で列順へ変換する(列順の変更に強くするため)。
 *
 * §4の各コードは指示書に明記された値をそのまま使う:
 *  - condition: 1新品/2未使用に近い/3目立った傷汚れなし/4やや傷汚れ/
 *               5傷汚れ/6全体的状態悪
 *  - shippingMethod: 1未定(出品者手配)/2クール便/3らくらくメルカリ便/
 *               4クール冷蔵/5クール冷凍/6Biz
 *  - shippingDays: 1=1〜2/2=2〜3/3=4〜7/4=90日以内/5=8〜14
 *  - productStatus: 1非公開/2公開(このtaskではローカルCSV生成のみ)
 *  - shippingPayer: 1送料込/2送料別
 *  - bizCoolCategory: 1通常/2冷蔵/3冷凍(配送方法がBizの時のみ必須)
 */
export interface MercariCsvRowFields {
  inventoryId: string;
  /** 表示用(エラー文言に出す) — 在庫ID。 */
  displayId: string;
  images: string[]; // 商品画像名_1..20 に入れる画像URL。最大20件。
  productName: string;
  productDescription: string;
  skuType: string | null;
  quantity: number;
  managementCode: string;
  janCode: string | null;
  catalogId: string | null;
  brandId: string | null;
  salePrice: number;
  categoryId: string;
  condition: 1 | 2 | 3 | 4 | 5 | 6;
  shippingMethod: 1 | 2 | 3 | 4 | 5 | 6;
  shippingOriginArea: string;
  shippingDays: 1 | 2 | 3 | 4 | 5;
  productStatus: 1 | 2;
  shippingPayer: 1 | 2;
  shippingFeeId: string | null;
  bizCoolCategory: 1 | 2 | 3 | null;
}

export interface MercariCsvFieldError {
  field: keyof MercariCsvRowFields | "row";
  message: string;
}

export interface MercariCsvRowValidation {
  inventoryId: string;
  displayId: string;
  ok: boolean;
  errors: MercariCsvFieldError[];
}
