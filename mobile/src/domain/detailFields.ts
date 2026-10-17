import type { MobileFeatures } from "./access";
import type { ExtendedFieldKey } from "../../../lib/inventory/extendedFields";

interface DetailFieldPresentation {
  label: string;
  section: string;
  kind?: "money" | "integer" | "date" | "multiline";
  inputMode?: "numeric" | "decimal";
  options?: readonly string[];
  feature?: keyof MobileFeatures;
  readOnly?: boolean;
}
export type DetailField = DetailFieldPresentation & (
  { key: ExtendedFieldKey | "purchasePrice" | "salePrice"; custom?: false } |
  { key: string; custom: true }
);

// A mobile presentation of existing BELLO fields, not a new storage schema.
// Reuse the Web field-key type; custom keys are checked against the existing ZAICO mapping.
export const DETAIL_FIELDS: readonly DetailField[] = [
  { key: "firstMarkdownPrice", inputMode: "numeric", label: "1回目値下げ時の金額（30日）", section: "値下げ価格" },
  { key: "secondMarkdownPrice", inputMode: "numeric", label: "2回目値下げ時の金額（60日）", section: "値下げ価格" },
  { key: "thirdMarkdownPrice", inputMode: "numeric", label: "3回目値下げ金額（90日）", section: "値下げ価格" },
  { key: "conditionRating", inputMode: "decimal", label: "コンディション評価（1〜5の5段階で）", section: "状態・サイズ" },
  { key: "damageNotes", label: "傷汚れ箇所等メモ", section: "状態・サイズ", kind: "multiline" },
  { key: "width", inputMode: "decimal", label: "幅（cm）", section: "状態・サイズ" },
  { key: "depth", inputMode: "decimal", label: "奥行（cm）", section: "状態・サイズ" },
  { key: "height", inputMode: "decimal", label: "高さ（cm）", section: "状態・サイズ" },
  { key: "overallLength", inputMode: "decimal", label: "全長（cm）", section: "状態・サイズ" },
  { key: "lengthAdjustable", label: "全長調節可否", section: "状態・サイズ", options: ["可", "不可"] },
  { key: "legHeight", inputMode: "decimal", label: "脚高", section: "状態・サイズ", custom: true },
  { key: "seatDimensions", label: "座面寸法", section: "状態・サイズ", custom: true },
  { key: "mountType", label: "取付タイプ", section: "状態・サイズ" },
  { key: "socketType", label: "口金", section: "状態・サイズ", custom: true },
  { key: "packageSize", label: "梱包サイズ", section: "状態・サイズ", custom: true },
  { key: "usedGoodsItemType", label: "品目", section: "仕入情報" },
  { key: "transactionDate", label: "取引の年月日", section: "仕入情報", kind: "date" },
  { key: "usedGoodsFeature", label: "古物の特徴", section: "仕入情報", custom: true },
  { key: "purchaseQuantity", label: "数量（仕入）", section: "仕入情報", kind: "integer" },
  { key: "transactionType", label: "取引区分", section: "仕入情報" },
  { key: "identityVerificationMethod", label: "取引相手の真偽の確認のためにとった措置の区分および方法", section: "仕入情報", kind: "multiline" },
  { key: "counterpartyName", label: "相手氏名", section: "仕入情報" },
  { key: "counterpartyOccupation", label: "職業", section: "仕入情報" },
  { key: "counterpartyAddress", label: "住所", section: "仕入情報", kind: "multiline" },
  { key: "purchasePrice", label: "購入価格", section: "仕入情報", kind: "money" },
  // Existing BELLO policy includes costs in purchasePrice; preserve legacy shipping separately.
  { key: "shippingCost", label: "送料（保存済みの参考値）", section: "仕入情報", kind: "money", readOnly: true },
  { key: "dailyPurchaseTotal", label: "その日の仕入れ合計金額（他商品含む）", section: "仕入情報", kind: "money" },
  { key: "saleStartDate", label: "販売開始日", section: "販売情報", kind: "date", feature: "sales" },
  { key: "saleEndDate", label: "販売終了日", section: "販売情報", kind: "date", feature: "sales" },
  { key: "market", label: "市場", section: "販売情報", feature: "sales" },
  { key: "externalProductId", label: "商品ID", section: "販売情報", feature: "ecListing" },
  { key: "salePrice", label: "販売価格", section: "販売情報", kind: "money", feature: "sales" },
  { key: "listingNotes", label: "出品情報", section: "販売情報", kind: "multiline", feature: "ecListing" },
  { key: "saleCommission", label: "販売手数料", section: "販売情報", kind: "money", feature: "sales" },
  { key: "adminMemo", label: "市川メモ", section: "メモ", kind: "multiline" },
];

export type DetailValues = Record<string, string>;
export function visibleDetailFields(features: MobileFeatures): readonly DetailField[] {
  return DETAIL_FIELDS.filter(field => !field.feature || features[field.feature] === true);
}
export function copyDetailValues(value: unknown): DetailValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: DetailValues = {};
  for (const field of DETAIL_FIELDS) {
    const content = source[field.key];
    if (typeof content === "string") result[field.key] = content;
  }
  return result;
}
export function isDetailValues(value: unknown): value is DetailValues {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.entries(value).every(([key, content]) => DETAIL_FIELDS.some(field => field.key === key) && typeof content === "string");
}
export function validCalendarDate(raw: string): boolean {
  const match = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(raw);
  if (!match) return false;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) && date.getUTCDate() === Number(match[3]);
}
export function validateDetailValues(values: DetailValues): string | null {
  for (const field of DETAIL_FIELDS) {
    const value = values[field.key]?.trim();
    if (!value || field.readOnly) continue;
    if ((field.kind === "money" || field.kind === "integer") && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) return `${field.label}は0以上の整数で入力してください。`;
    if (field.kind === "date" && !validCalendarDate(value)) return `${field.label}を実在する日付（年/月/日）で入力してください。`;
  }
  return null;
}
