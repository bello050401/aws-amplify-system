import type { ListingConditionCode } from "./types";

/**
 * 商品状態コード(ListingConditionCode, amplify/data/resource.tsの
 * ListingCondition enumと1対1) ⇔ 日本語ラベル。
 *
 * Mercari Shops API出品機能の撤去(2026-09-14)に伴い、
 * `lib/listing/mercari/mapper/condition.ts`から移植した——
 * 出品下書き(ListingDraft.condition)はチャネルに依存しない共通項目
 * (BASE出品や手動出品準備でも同じ選択肢を使う)であり、Mercari APIの
 * `ProductCondition` enum値への変換(`mercariValue`/
 * `conditionToMercariValue`、旧mapper/condition.ts)は実際にAPIへ送信
 * する経路と一緒に削除した——UI側はこのテーブルの`label`のみを参照し、
 * 外部APIの enum文字列を扱う必要はもともと無い。
 */
export const LISTING_CONDITIONS: { code: ListingConditionCode; label: string }[] = [
  { code: "NEW", label: "新品、未使用" },
  { code: "LIKE_NEW", label: "未使用に近い" },
  { code: "NO_NOTABLE_DAMAGE", label: "目立った傷や汚れなし" },
  { code: "SLIGHT_DAMAGE", label: "やや傷や汚れあり" },
  { code: "DAMAGE", label: "傷や汚れあり" },
  { code: "BAD", label: "全体的に状態が悪い" },
];

export function conditionLabel(code: ListingConditionCode): string {
  return LISTING_CONDITIONS.find((c) => c.code === code)?.label ?? code;
}
