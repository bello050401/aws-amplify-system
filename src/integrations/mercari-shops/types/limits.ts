/**
 * メルカリShops APIの文字数制限などの定数を1箇所に集約する。
 *
 * [UNVERIFIED] このファイルの値はネットワーク制約により公式GraphQL Schemaから
 * 直接確認できていない暫定値（docs/mercari-api.md 参照）。Sandbox接続確立後、
 * 実際のエラーメッセージ／Schemaディレクティブから確認し、ここを更新すること。
 * UI・バリデーションはすべてこの定数を参照しており、値を更新すれば全体に反映される。
 */
export const MERCARI_LIMITS = {
  /** 商品名の最大文字数 [UNVERIFIED] */
  NAME_MAX: 40,
  /** 商品説明の最大文字数（指示書9項に基づく確定値） */
  DESCRIPTION_MAX: 3000,
} as const;
