import type { SearchField } from "@/lib/types";

/**
 * 詳細検索の検索対象フィールド一覧 (指示書 §13-2)。
 * PC版の詳細検索・在庫一覧の詳細検索・モバイル版はすべてこの1つの定義を共有する。
 */
export const SEARCH_FIELDS: SearchField[] = [
  { field: "name", label: "物品名", type: "string" },
  { field: "categoryId", label: "カテゴリ", type: "category" },
  { field: "locationId", label: "保管場所", type: "location" },
  { field: "status", label: "状態", type: "string" },
  { field: "barcode", label: "QRコード・バーコードの値", type: "string" },
  { field: "notes", label: "備考", type: "string" },
  { field: "quantity", label: "数量", type: "number" },
  { field: "stocktakeDate", label: "棚卸日", type: "date" },
  { field: "plannedPrice", label: "☆販売予定価格(送料別記載)", type: "number" },
  { field: "discountPrice30", label: "1回目値下げ時の金額(30日)", type: "number" },
  { field: "discountPrice60", label: "2回目値下げ時の金額(60日)", type: "number" },
  { field: "discountPrice90", label: "3回目値下げ時の金額(90日)", type: "number" },
  { field: "condition", label: "コンディション評価(1〜5)", type: "condition" },
  { field: "damageNotes", label: "傷汚れ箇所等メモ", type: "string" },
  { field: "widthCm", label: "幅(cm)", type: "number" },
  { field: "depthCm", label: "奥行(cm)", type: "number" },
  { field: "heightCm", label: "高さ(cm)", type: "number" },
  { field: "lengthCm", label: "全長(cm)", type: "number" },
  { field: "householdCategory", label: "家財区分", type: "string" },
  { field: "itemType", label: "品目", type: "string" },
  { field: "transactionDate", label: "取引の年月日", type: "date" },
  { field: "antiqueFeature", label: "古物の特徴", type: "string" },
];

export function getSearchField(field: SearchField["field"]): SearchField | undefined {
  return SEARCH_FIELDS.find((f) => f.field === field);
}

export const STRING_OPERATORS = [
  { value: "contains", label: "を含む" },
  { value: "exact", label: "と完全一致" },
  { value: "notContains", label: "を含まない" },
] as const;

export const NUMBER_OPERATORS = [
  { value: "eq", label: "=" },
  { value: "gt", label: ">" },
  { value: "gte", label: ">=" },
  { value: "lt", label: "<" },
  { value: "lte", label: "<=" },
  { value: "range", label: "範囲" },
] as const;

export const DATE_OPERATORS = [
  { value: "before", label: "以前" },
  { value: "after", label: "以降" },
  { value: "range", label: "範囲" },
] as const;
