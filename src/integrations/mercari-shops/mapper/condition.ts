import type { ProductConditionCode } from "@prisma/client";

/**
 * 内部の商品状態コード ⇔ 日本語ラベル ⇔ Mercari API `ProductCondition` enum値。
 *
 * [UNVERIFIED] `mercariValue` はネットワーク制約により実Schemaから確認できていない
 * 暫定値（docs/mercari-api.md 5節）。Sandbox接続確立後に実際の enum 値へ更新すること。
 * UI側はこのテーブルの `label` のみを参照し、enum文字列を直接扱わない。
 */
export const PRODUCT_CONDITIONS: {
  code: ProductConditionCode;
  label: string;
  mercariValue: string;
}[] = [
  { code: "NEW", label: "新品、未使用", mercariValue: "NEW" },
  { code: "LIKE_NEW", label: "未使用に近い", mercariValue: "LIKE_NEW" },
  { code: "NO_NOTABLE_DAMAGE", label: "目立った傷や汚れなし", mercariValue: "NO_NOTABLE_DAMAGE" },
  { code: "SLIGHT_DAMAGE", label: "やや傷や汚れあり", mercariValue: "SLIGHT_DAMAGE" },
  { code: "DAMAGE", label: "傷や汚れあり", mercariValue: "DAMAGE" },
  { code: "BAD", label: "全体的に状態が悪い", mercariValue: "BAD" },
];

export function conditionLabel(code: ProductConditionCode): string {
  return PRODUCT_CONDITIONS.find((c) => c.code === code)?.label ?? code;
}

export function conditionToMercariValue(code: ProductConditionCode): string {
  const found = PRODUCT_CONDITIONS.find((c) => c.code === code);
  if (!found) throw new Error(`Unknown ProductConditionCode: ${code}`);
  return found.mercariValue;
}
