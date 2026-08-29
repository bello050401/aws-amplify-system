import type { ListingConditionCode } from "../../types";

/**
 * BELLO内部の商品状態コード(ListingConditionCode, amplify/data/resource.ts
 * のListingCondition enumと1対1) ⇔ 日本語ラベル ⇔ Mercari API
 * `ProductCondition` enum値(BELLO統合改修 master指示書 Phase D —
 * origin/claude/mercari-shops-auto-listing-ag0w6m branchのintegrations/
 * mercari-shops/mapper/condition.tsから移植、`@prisma/client`の
 * ProductConditionCode型をこのアプリのListingConditionCode型へ差し替え
 * ただけでロジックは無変更)。
 *
 * [UNVERIFIED] `mercariValue` はネットワーク制約により実Schemaから確認
 * できていない暫定値(元ブランチのdocs/mercari-api.md 5節)。Sandbox
 * 接続確立後に実際のenum値へ更新すること。UI側はこのテーブルの`label`
 * のみを参照し、enum文字列を直接扱わない。
 */
export const LISTING_CONDITIONS: { code: ListingConditionCode; label: string; mercariValue: string }[] = [
  { code: "NEW", label: "新品、未使用", mercariValue: "NEW" },
  { code: "LIKE_NEW", label: "未使用に近い", mercariValue: "LIKE_NEW" },
  { code: "NO_NOTABLE_DAMAGE", label: "目立った傷や汚れなし", mercariValue: "NO_NOTABLE_DAMAGE" },
  { code: "SLIGHT_DAMAGE", label: "やや傷や汚れあり", mercariValue: "SLIGHT_DAMAGE" },
  { code: "DAMAGE", label: "傷や汚れあり", mercariValue: "DAMAGE" },
  { code: "BAD", label: "全体的に状態が悪い", mercariValue: "BAD" },
];

export function conditionLabel(code: ListingConditionCode): string {
  return LISTING_CONDITIONS.find((c) => c.code === code)?.label ?? code;
}

export function conditionToMercariValue(code: ListingConditionCode): string {
  const found = LISTING_CONDITIONS.find((c) => c.code === code);
  if (!found) throw new Error(`Unknown ListingConditionCode: ${code}`);
  return found.mercariValue;
}
