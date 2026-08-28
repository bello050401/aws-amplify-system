/**
 * ZAICO同等の汎用詳細検索エンジン(夜間開発指示書 §7)。
 *
 * 純粋なロジックのみ — Amplify/Dataアクセスは一切ない(server-onlyでは
 * ない)。DBから全件取得してこのモジュールでフィルタするオーケストレー
 * ションはlib/inventory/queries.tsのlistInventoryAdvanced/
 * listInventorySimpleSearchが担当する(そちらはserver-only)。この分離
 * により、検索条件の判定ロジック単体をユニットテストしやすい形に保つ。
 *
 * ── 大文字小文字を区別しない検索(spec §6)について ──────────────────
 * DynamoDBの`contains`はcase-sensitiveで、保存値をlowercase化すること
 * も禁止されている。フロントだけ`.toLowerCase()`する見かけだけの実装
 * も禁止。そこでこのシステムでは、
 *   1. カテゴリ/保管場所/状態/日付/数値の条件はAppSyncのfilter(DynamoDB
 *      のFilterExpression)へ実際に渡し、サーバー側で絞り込む
 *      (queries.ts側)。
 *   2. 文字列演算子(含む/含まない/完全一致/前方一致)の判定は、絞り込み
 *      済みの候補集合に対してこのモジュールがcase-insensitiveに評価
 *      する(ciEquals/ciIncludes/ciStartsWith — String.prototype
 *      .toLocaleLowerCase()で比較するだけで、保存値そのものは一切変更
 *      しない)。
 * という2段構成で、「見かけだけ」ではなく実際にDynamoDBレベルの絞り込
 * みと組み合わせた実装にしている。既存のlistInventory(サイドバー等の
 * カテゴリ/保管場所/状態のみのシンプルな一覧)はこの全件走査を経由しな
 * い、従来通り安価なcursorページングのまま(queries.tsのlistInventory
 * は無変更)。
 */

export type SearchOperator =
  | "contains"
  | "notContains"
  | "equals"
  | "startsWith"
  | "isEmpty"
  | "isNotEmpty"
  | "eq"
  | "ge"
  | "le"
  | "gt"
  | "lt"
  | "between"
  | "on"
  | "before"
  | "after"
  | "dateBetween";

export type SearchFieldValueType = "string" | "number" | "date" | "datetime" | "category" | "location" | "status" | "select";

export interface SearchFieldDef {
  /** Inventory field key. Dynamic CustomFieldDefinitionはIDと衝突しないよう "cf:<fieldKey>" 形式。 */
  key: string;
  label: string;
  group: string;
  valueType: SearchFieldValueType;
  /** valueType "select"のみ — 選択肢一覧({value,label})。static fieldはここに直接書ける(lengthAdjustable等)。CustomField(SELECT型)は実行時にCustomFieldDefinition.optionsから生成する。 */
  options?: { value: string; label: string }[];
}

export const STRING_OPERATORS: { value: SearchOperator; label: string }[] = [
  { value: "contains", label: "含む" },
  { value: "notContains", label: "含まない" },
  { value: "equals", label: "完全一致" },
  { value: "startsWith", label: "前方一致" },
  { value: "isEmpty", label: "空欄" },
  { value: "isNotEmpty", label: "空欄ではない" },
];

export const NUMBER_OPERATORS: { value: SearchOperator; label: string }[] = [
  { value: "eq", label: "等しい" },
  { value: "ge", label: "以上" },
  { value: "le", label: "以下" },
  { value: "gt", label: "より大きい" },
  { value: "lt", label: "より小さい" },
  { value: "between", label: "範囲" },
  { value: "isEmpty", label: "空欄" },
  { value: "isNotEmpty", label: "空欄ではない" },
];

export const DATE_OPERATORS: { value: SearchOperator; label: string }[] = [
  { value: "on", label: "指定日" },
  { value: "dateBetween", label: "期間" },
  { value: "after", label: "指定日以降" },
  { value: "before", label: "指定日以前" },
  { value: "isEmpty", label: "空欄" },
  { value: "isNotEmpty", label: "空欄ではない" },
];

export const SELECT_OPERATORS: { value: SearchOperator; label: string }[] = [
  { value: "equals", label: "一致" },
  { value: "isEmpty", label: "空欄" },
  { value: "isNotEmpty", label: "空欄ではない" },
];

export function operatorsForType(valueType: SearchFieldValueType): { value: SearchOperator; label: string }[] {
  switch (valueType) {
    case "number":
      return NUMBER_OPERATORS;
    case "date":
    case "datetime":
      return DATE_OPERATORS;
    case "category":
    case "location":
    case "status":
    case "select":
      return SELECT_OPERATORS;
    default:
      return STRING_OPERATORS;
  }
}

/** operatorがvalue2(範囲の終端)を必要とするか。 */
export function operatorNeedsSecondValue(operator: SearchOperator): boolean {
  return operator === "between" || operator === "dateBetween";
}

/** operatorが値の入力欄自体を必要としないか(空欄/空欄ではない)。 */
export function operatorNeedsNoValue(operator: SearchOperator): boolean {
  return operator === "isEmpty" || operator === "isNotEmpty";
}

export interface AdvancedSearchCondition {
  id: string;
  field: string;
  operator: SearchOperator;
  value?: string;
  value2?: string;
}

export interface AdvancedSearchQuery {
  combinator: "AND" | "OR";
  conditions: AdvancedSearchCondition[];
}

export function emptyAdvancedQuery(): AdvancedSearchQuery {
  return { combinator: "AND", conditions: [] };
}

/** 条件が判定可能な状態か(値が必要な演算子で値が空、など不完全な条件を検索実行前に弾く)。 */
export function isConditionComplete(condition: AdvancedSearchCondition): boolean {
  if (!condition.field || !condition.operator) return false;
  if (operatorNeedsNoValue(condition.operator)) return true;
  if (operatorNeedsSecondValue(condition.operator)) return Boolean(condition.value?.trim()) && Boolean(condition.value2?.trim());
  return Boolean(condition.value?.trim());
}

/** 送信前フィルタ — 空欄のまま追加されただけの行(値未入力)は検索条件として送らない。 */
export function completeConditions(query: AdvancedSearchQuery): AdvancedSearchCondition[] {
  return query.conditions.filter(isConditionComplete);
}

// ── 大文字小文字を区別しない文字列比較 ──────────────────────────────
// 保存値・表示値は一切変更しない。比較の瞬間だけtoLocaleLowerCase。
function ciEquals(a: string, b: string): boolean {
  return a.toLocaleLowerCase() === b.toLocaleLowerCase();
}
function ciIncludes(haystack: string, needle: string): boolean {
  return haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}
function ciStartsWith(haystack: string, needle: string): boolean {
  return haystack.toLocaleLowerCase().startsWith(needle.toLocaleLowerCase());
}

function toStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

function matchString(raw: unknown, operator: SearchOperator, value?: string): boolean {
  const field = toStr(raw).trim();
  switch (operator) {
    case "isEmpty":
      return field === "";
    case "isNotEmpty":
      return field !== "";
    case "contains":
      return value !== undefined && ciIncludes(field, value);
    case "notContains":
      return field !== "" && value !== undefined ? !ciIncludes(field, value) : field === "";
    case "equals":
      return value !== undefined && ciEquals(field, value);
    case "startsWith":
      return value !== undefined && ciStartsWith(field, value);
    default:
      return false;
  }
}

function matchNumber(raw: unknown, operator: SearchOperator, value?: string, value2?: string): boolean {
  if (operator === "isEmpty") return raw === null || raw === undefined || raw === "";
  if (operator === "isNotEmpty") return !(raw === null || raw === undefined || raw === "");
  const n = typeof raw === "number" ? raw : raw === null || raw === undefined || raw === "" ? null : Number(raw);
  if (n === null || Number.isNaN(n)) return false;
  const v = value !== undefined ? Number(value) : NaN;
  if (Number.isNaN(v)) return false;
  switch (operator) {
    case "eq":
      return n === v;
    case "ge":
      return n >= v;
    case "le":
      return n <= v;
    case "gt":
      return n > v;
    case "lt":
      return n < v;
    case "between": {
      const v2 = value2 !== undefined ? Number(value2) : NaN;
      if (Number.isNaN(v2)) return false;
      const [lo, hi] = v <= v2 ? [v, v2] : [v2, v];
      return n >= lo && n <= hi;
    }
    default:
      return false;
  }
}

/** AWSDate("YYYY-MM-DD")・AWSDateTime(ISO)どちらも受け付ける。日付だけの比較にしたい場合はYYYY-MM-DD部分だけ切り出す。 */
function toDateOnly(raw: unknown): string | null {
  const s = toStr(raw).trim();
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
}

function matchDate(raw: unknown, operator: SearchOperator, value?: string, value2?: string): boolean {
  if (operator === "isEmpty") return toDateOnly(raw) === null;
  if (operator === "isNotEmpty") return toDateOnly(raw) !== null;
  const d = toDateOnly(raw);
  if (!d) return false;
  switch (operator) {
    case "on":
      return value !== undefined && d === value;
    case "after":
      return value !== undefined && d >= value;
    case "before":
      return value !== undefined && d <= value;
    case "dateBetween": {
      if (value === undefined || value2 === undefined) return false;
      const [lo, hi] = value <= value2 ? [value, value2] : [value2, value];
      return d >= lo && d <= hi;
    }
    default:
      return false;
  }
}

function matchSelectLike(raw: unknown, operator: SearchOperator, value?: string): boolean {
  const field = toStr(raw).trim();
  if (operator === "isEmpty") return field === "";
  if (operator === "isNotEmpty") return field !== "";
  if (operator === "equals") return value !== undefined && field === value;
  return false;
}

/** レコードから読み出せるものであれば何でも良い最小限のインターフェース — queries.tsのInventorySearchRecordが実際に満たす形。この関数自体はDBの型に依存しない。 */
export interface SearchableRecord {
  [key: string]: unknown;
  customFields: Record<string, unknown> | null;
}

export function evaluateCondition(record: SearchableRecord, def: SearchFieldDef, condition: AdvancedSearchCondition): boolean {
  const raw = def.key.startsWith("cf:") ? record.customFields?.[def.key.slice(3)] : record[def.key];
  switch (def.valueType) {
    case "number":
      return matchNumber(raw, condition.operator, condition.value, condition.value2);
    case "date":
    case "datetime":
      return matchDate(raw, condition.operator, condition.value, condition.value2);
    case "category":
    case "location":
    case "status":
    case "select":
      return matchSelectLike(raw, condition.operator, condition.value);
    default:
      return matchString(raw, condition.operator, condition.value);
  }
}

export function evaluateQuery(
  record: SearchableRecord,
  query: AdvancedSearchQuery,
  fieldsByKey: Map<string, SearchFieldDef>,
): boolean {
  const conditions = query.conditions.filter(isConditionComplete);
  if (conditions.length === 0) return true;
  const results = conditions.map((c) => {
    const def = fieldsByKey.get(c.field);
    if (!def) return false;
    return evaluateCondition(record, def, c);
  });
  return query.combinator === "OR" ? results.some(Boolean) : results.every(Boolean);
}

/** クイック検索(商品検索ボックス)専用 — 在庫ID/SKU/物品名のいずれかにcase-insensitiveに部分一致。 */
export function matchesQuickSearch(record: SearchableRecord, q: string): boolean {
  const needle = q.trim();
  if (!needle) return true;
  return (
    ciIncludes(toStr(record.displayId), needle) ||
    ciIncludes(toStr(record.sku), needle) ||
    ciIncludes(toStr(record.name), needle)
  );
}

// ────────────────────────────────────────────────────────────────────
// 検索対象フィールドの登録(metadata-driven) — spec §7の最低限リストを
// 網羅する静的フィールドに、CustomFieldDefinition由来の動的フィールド
// を実行時に合成する。CustomFieldを追加してもこのファイルを直さなくて
// よい(§11: 「CustomField追加のたびにコード修正する設計は禁止」)。
// ────────────────────────────────────────────────────────────────────

const LENGTH_ADJUSTABLE_OPTIONS = [
  { value: "可", label: "可" },
  { value: "不可", label: "不可" },
];

/** 表示用「在庫ID」はsourceInventoryId/skuの導出値(lib/inventory/inventoryId.ts)そのままなので、queries.tsのInventorySearchRecordの`displayId`を直接文字列として検索する。 */
export const STATIC_SEARCH_FIELDS: SearchFieldDef[] = [
  { key: "displayId", label: "在庫ID", group: "基本情報", valueType: "string" },
  { key: "sku", label: "SKU", group: "基本情報", valueType: "string" },
  { key: "name", label: "商品名", group: "基本情報", valueType: "string" },
  { key: "categoryId", label: "カテゴリ", group: "基本情報", valueType: "category" },
  { key: "locationId", label: "保管場所", group: "基本情報", valueType: "location" },
  { key: "statusId", label: "状態", group: "基本情報", valueType: "status" },
  { key: "quantity", label: "数量", group: "基本情報", valueType: "number" },
  { key: "unit", label: "単位", group: "基本情報", valueType: "string" },
  { key: "barcode", label: "バーコード", group: "基本情報", valueType: "string" },
  { key: "note", label: "備考", group: "基本情報", valueType: "string" },

  { key: "purchasePrice", label: "購入価格", group: "価格", valueType: "number" },
  { key: "plannedSalePrice", label: "販売予定価格", group: "価格", valueType: "number" },
  { key: "salePrice", label: "販売価格", group: "価格", valueType: "number" },
  { key: "saleCommission", label: "販売手数料", group: "価格", valueType: "number" },
  { key: "shippingCost", label: "送料", group: "価格", valueType: "number" },
  { key: "dailyPurchaseTotal", label: "その日の仕入れ合計金額", group: "価格", valueType: "number" },
  { key: "market", label: "市場", group: "価格", valueType: "string" },
  { key: "externalProductId", label: "商品ID", group: "価格", valueType: "string" },
  { key: "listingNotes", label: "出品情報", group: "価格", valueType: "string" },

  { key: "width", label: "幅（cm）", group: "サイズ", valueType: "string" },
  { key: "depth", label: "奥行（cm）", group: "サイズ", valueType: "string" },
  { key: "height", label: "高さ（cm）", group: "サイズ", valueType: "string" },
  { key: "overallLength", label: "全長（cm）", group: "サイズ", valueType: "string" },
  { key: "lengthAdjustable", label: "全長調節可否", group: "サイズ", valueType: "select", options: LENGTH_ADJUSTABLE_OPTIONS },
  { key: "mountType", label: "取付タイプ", group: "サイズ", valueType: "string" },

  { key: "conditionRating", label: "コンディション評価", group: "コンディション", valueType: "string" },
  { key: "damageNotes", label: "傷汚れ箇所等メモ", group: "コンディション", valueType: "string" },

  { key: "saleStartDate", label: "販売開始日", group: "日付", valueType: "date" },
  { key: "saleEndDate", label: "販売終了日", group: "日付", valueType: "date" },
  { key: "transactionDate", label: "取引の年月日", group: "日付", valueType: "date" },
  { key: "createdAt", label: "作成日", group: "日付", valueType: "datetime" },
  { key: "updatedAt", label: "更新日", group: "日付", valueType: "datetime" },

  { key: "usedGoodsItemType", label: "品目", group: "古物台帳", valueType: "string" },
  { key: "purchaseQuantity", label: "数量（仕入台帳）", group: "古物台帳", valueType: "number" },
  { key: "transactionType", label: "取引区分", group: "古物台帳", valueType: "string" },
  { key: "identityVerificationMethod", label: "真偽確認の措置", group: "古物台帳", valueType: "string" },
  { key: "counterpartyName", label: "相手氏名", group: "古物台帳", valueType: "string" },
  { key: "counterpartyOccupation", label: "職業", group: "古物台帳", valueType: "string" },
  { key: "counterpartyAddress", label: "住所", group: "古物台帳", valueType: "string" },

  { key: "adminMemo", label: "管理メモ", group: "管理情報", valueType: "string" },
];

/** CustomFieldDefinition.fieldType → 検索エンジン上のvalueType。 */
function customFieldValueType(fieldType: string): SearchFieldValueType {
  if (fieldType === "NUMBER") return "number";
  if (fieldType === "DATE") return "date";
  if (fieldType === "SELECT") return "select";
  return "string"; // TEXT / TEXTAREA / URL
}

/** この最小限のシェイプだけをqueries.tsのCustomFieldDefinitionRowと共有する(型の直接importによるserver-onlyコードの巻き込みを避けるため、あえて構造的に定義)。 */
export interface CustomFieldDefLike {
  fieldKey: string;
  label: string;
  fieldType: string;
  options: string[];
}

export interface MasterOptionLike {
  id: string;
  name: string;
}
export interface StatusOptionLike {
  id: string;
  label: string;
}

/**
 * 静的フィールド + アクティブなCustomFieldDefinitionを合成した、検索
 * UIが実際に描画する対応先の全リスト。CustomFieldを設定画面から追加/
 * 変更してもこの関数を直す必要はない — 呼び出しのたびに現在の
 * CustomFieldDefinition一覧から動的に生成する。カテゴリ/保管場所/状態
 * は登録済みマスタから選択肢を都度差し込む(spec: 「登録済みマスタか
 * ら選択」)。
 */
export function buildSearchFieldDefs(
  customFieldDefs: CustomFieldDefLike[],
  masters: { categories: MasterOptionLike[]; locations: MasterOptionLike[]; statuses: StatusOptionLike[] },
): SearchFieldDef[] {
  const dynamic: SearchFieldDef[] = customFieldDefs.map((def) => ({
    key: `cf:${def.fieldKey}`,
    label: def.label,
    group: "追加項目",
    valueType: customFieldValueType(def.fieldType),
    options: def.fieldType === "SELECT" ? def.options.map((o) => ({ value: o, label: o })) : undefined,
  }));
  const withMasterOptions = STATIC_SEARCH_FIELDS.map((f) => {
    if (f.key === "categoryId") return { ...f, options: masters.categories.map((c) => ({ value: c.id, label: c.name })) };
    if (f.key === "locationId") return { ...f, options: masters.locations.map((l) => ({ value: l.id, label: l.name })) };
    if (f.key === "statusId") return { ...f, options: masters.statuses.map((s) => ({ value: s.id, label: s.label })) };
    return f;
  });
  return [...withMasterOptions, ...dynamic];
}
