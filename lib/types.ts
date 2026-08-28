/**
 * ドメイン型定義。
 *
 * PC版・モバイル版・(将来の)React Native版はすべてこの型と
 * lib/api/* のリポジトリ層を共有する。UIごとに型を作り直さない。
 */

export type MovementType = "RECEIVE" | "SHIP" | "MOVE" | "ADJUST" | "STOCKTAKE";
export type HistoryAction = "CREATE" | "UPDATE" | "DELETE" | "DUPLICATE";

export interface Category {
  id: string;
  name: string;
  sortOrder: number;
}

export interface Location {
  id: string;
  name: string;
  code?: string | null;
}

/** 在庫物品。指示書 §7-3 / §11 のBELLO独自カスタム項目を含む。 */
export interface Item {
  id: string;
  name: string;
  barcode?: string | null;
  quantity: number;
  freeQuantity: number;
  reorderPoint?: number | null;
  unit: string;
  status?: string | null;
  notes?: string | null;

  categoryId?: string | null;
  locationId?: string | null;

  thumbnailKey?: string | null;
  imageKeys: string[];

  // BELLO独自カスタム項目
  plannedPrice?: number | null; // ☆販売予定価格(送料別記載)
  discountPrice30?: number | null;
  discountPrice60?: number | null;
  discountPrice90?: number | null;
  condition?: number | null; // 1-5
  damageNotes?: string | null;
  widthCm?: number | null;
  depthCm?: number | null;
  heightCm?: number | null;
  lengthCm?: number | null;
  householdCategory?: string | null;
  itemType?: string | null;
  transactionDate?: string | null; // YYYY-MM-DD (JST)
  antiqueFeature?: string | null;
  stocktakeDate?: string | null; // YYYY-MM-DD (JST)

  isDeleted: boolean;
  version: number;
  userGroup?: string | null;
  updatedBy?: string | null;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ItemInput = Omit<
  Item,
  "id" | "createdAt" | "updatedAt" | "version" | "isDeleted" | "imageKeys"
> & {
  imageKeys?: string[];
};

export interface StockMovement {
  id: string;
  itemId: string;
  type: MovementType;
  quantity: number;
  fromLocationId?: string | null;
  toLocationId?: string | null;
  note?: string | null;
  operatorId?: string | null;
  operatorName?: string | null;
  createdAt: string;
}

export interface FieldChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface ItemHistoryEntry {
  id: string;
  itemId: string;
  action: HistoryAction;
  changes: FieldChange[];
  changedBy?: string | null;
  changedAt: string;
}

// ---------------------------------------------------------------------------
// 詳細検索 (指示書 §13)
// ---------------------------------------------------------------------------

export type SearchFieldType =
  | "string"
  | "number"
  | "date"
  | "category"
  | "location"
  | "condition";

export type StringOperator = "contains" | "exact" | "notContains";
export type NumberOperator = "eq" | "gt" | "gte" | "lt" | "lte" | "range";
export type DateOperator = "before" | "after" | "range";

export interface SearchField {
  field: keyof Item | "categoryId" | "locationId";
  label: string;
  type: SearchFieldType;
}

export interface SearchCondition {
  id: string; // UI上でのブロック識別用
  field: SearchField["field"];
  label: string;
  type: SearchFieldType;
  operator: StringOperator | NumberOperator | DateOperator | "eq";
  value?: string | number | null;
  valueTo?: string | number | null; // range用
}

export interface AdvancedSearchQuery {
  combinator: "AND" | "OR";
  conditions: SearchCondition[];
}

export interface KeywordSearchParams {
  keyword?: string;
  categoryId?: string;
  advanced?: AdvancedSearchQuery;
  sort?: { field: string; direction: "asc" | "desc" };
  page?: number;
  pageSize?: number;
}

export interface SearchResult<T> {
  items: T[];
  totalCount: number;
  totalQuantity: number;
  nextToken?: string | null;
}

export interface CurrentUser {
  userId: string;
  email: string;
  displayName?: string;
  groups: string[];
}
