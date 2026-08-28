/**
 * The shared field registry for both CSV/Excel export and import —
 * one place mapping "internal Inventory field key" ↔ "column header",
 * reused by:
 * - lib/inventory/inventoryExport.ts (builds the header row + cell values)
 * - lib/inventory/inventoryImport.ts (auto-suggests a column mapping by
 *   matching an uploaded file's header text against these SAME labels)
 *
 * Not `server-only` — pure data, no Amplify/Data access, safe to import
 * from a client component (the import wizard's mapping UI needs these
 * labels too).
 *
 * ── ZAICO互換列順 (在庫ID体系の再設計) ──────────────────────────────
 * `STATIC_EXPORT_FIELDS`の先頭ブロック(ZAICO_COMPAT_FIELDS)は、旧
 * ZAICOのエクスポート列名・列順をそのまま再現する — 列名は原則として
 * ZAICOの表記そのもの(⚪︎/⚫︎/★/<<>>等の記号も含む)を使う。これは
 * extendedFields.ts のBELLO編集画面向けラベル(例:「コンディション評
 * 価」)とは別物として意図的に重複させている — 編集画面のラベルは
 * BELLOのUIとして分かりやすい表現を優先し、エクスポート列名はZAICOと
 * の継続性を最優先するという、異なる目的のための異なる文言であり、
 * 「Single Source of Truthに反する重複」ではなく意図的な分離。
 * `key`（内部フィールド名）はextendedFields.ts等の既存フィールドを
 * そのまま指す — データの実体は一切重複させていない。
 *
 * ZAICOに存在するがBELLOでは追跡していない列(棚卸日/グループタグ)は
 * 列自体は互換のため出力するが、値は常に空欄・インポート対象外
 * (`importable: false`)とする。
 *
 * ZAICOの⚪︎脚高/⚪︎座面寸法/⚪︎口金/⚪︎梱包サイズ/⚫︎古物の特徴は、
 * BELLOではCustomFieldDefinition(customFieldSeed.ts)で管理している
 * ため、その`fieldKey`をそのままexport keyとして使う — ZAICOの列順
 * 内の正しい位置に配置する必要があるため、他の管理者定義custom
 * fieldsのように末尾へ一括追加するのではなく、ここで個別に列挙する
 * (lib/inventory/inventoryExport.tsのコメント参照)。
 *
 * BELLO独自列（SKU/画像枚数/同期元システム/同期元ID/作成者/更新者/
 * 売却の優先度）はZAICO互換ブロックの「後ろ」にのみ追加し、途中へ
 * 挿入しない。
 */
import { ALL_EXTENDED_FIELDS, type ExtendedFieldKey } from "./extendedFields";

export type ExportFieldValueType = "string" | "number" | "date" | "datetime";

export interface ExportFieldDef {
  key: string;
  label: string;
  valueType: ExportFieldValueType;
  /** Importable = a real Inventory column (or CustomFieldDefinition value) the New/Edit forms can also set. `false` for 在庫ID/SKU(照合キーのみ・書き込み対象ではない)と、棚卸日/グループタグ(BELLO側に対応するフィールドがなく常に空欄)、system/derived metadata。 */
  importable: boolean;
}

/**
 * 「在庫ID」— ZAICO互換ブロックの先頭列。ユーザーに見せる表示用ID
 * (lib/inventory/inventoryId.ts の`resolveDisplayInventoryId`が返す
 * 値)であって、Inventoryモデルの実カラムではない — インポート時は
 * 照合キーとして使うのみで、書き込み対象にはしない
 * (`importable: false`)。SKUと同様の扱いだが別の値・別の意味を持つ。
 */
export const DISPLAY_ID_FIELD: ExportFieldDef = { key: "displayId", label: "在庫ID", valueType: "string", importable: false };

/** BELLO独自列の末尾に置く、SKU(BELLO内部管理番号)— 在庫IDとは別概念。こちらも照合キー専用で書き込み対象にはしない。 */
export const SKU_FIELD: ExportFieldDef = { key: "sku", label: "SKU", valueType: "string", importable: false };

/** ZAICO互換ブロック — 列名・列順はZAICOのエクスポート形式そのもの。 */
export const ZAICO_COMPAT_FIELDS: ExportFieldDef[] = [
  DISPLAY_ID_FIELD,
  { key: "name", label: "物品名", valueType: "string", importable: true },
  { key: "categoryName", label: "カテゴリ", valueType: "string", importable: true },
  { key: "locationName", label: "保管場所", valueType: "string", importable: true },
  { key: "statusLabel", label: "状態", valueType: "string", importable: true },
  { key: "quantity", label: "数量", valueType: "number", importable: true },
  { key: "unit", label: "単位", valueType: "string", importable: true },
  { key: "barcode", label: "QRコード・バーコードの値", valueType: "string", importable: true },
  { key: "note", label: "備考", valueType: "string", importable: true },
  { key: "updatedAt", label: "更新日", valueType: "datetime", importable: false },
  { key: "createdAt", label: "作成日", valueType: "datetime", importable: false },
  // BELLOでは追跡していない列 — 列自体は互換性のため出力するが常に空欄。
  { key: "stocktakeDate", label: "棚卸日", valueType: "string", importable: false },
  { key: "groupTag", label: "グループタグ", valueType: "string", importable: false },
  { key: "plannedSalePrice", label: "☆販売予定価格（送料別大原記載）", valueType: "number", importable: true },
  { key: "firstMarkdownPrice", label: "1回目値下げ時の金額（30日）", valueType: "string", importable: true },
  { key: "secondMarkdownPrice", label: "2回目値下げ時の金額（60日）", valueType: "string", importable: true },
  { key: "thirdMarkdownPrice", label: "3回目値下げ金額（90日）", valueType: "string", importable: true },
  { key: "conditionRating", label: "⚪︎コンディション評価(1～5の5段階で)", valueType: "string", importable: true },
  { key: "damageNotes", label: "⚪︎傷汚れ箇所等メモ", valueType: "string", importable: true },
  { key: "width", label: "⚪︎幅（cm）", valueType: "string", importable: true },
  { key: "depth", label: "⚪︎奥行（cm）", valueType: "string", importable: true },
  { key: "height", label: "⚪︎高さ（cm）", valueType: "string", importable: true },
  { key: "overallLength", label: "⚪︎全長（cm）", valueType: "string", importable: true },
  { key: "lengthAdjustable", label: "⚪︎全長調節可否", valueType: "string", importable: true },
  // CustomFieldDefinition(customFieldSeed.ts)由来 — ZAICO列順内の正しい位置に配置。
  { key: "legHeight", label: "⚪︎脚高", valueType: "string", importable: true },
  { key: "seatDimensions", label: "⚪︎座面寸法", valueType: "string", importable: true },
  { key: "mountType", label: "⚪︎取付タイプ", valueType: "string", importable: true },
  { key: "socketType", label: "⚪︎口金", valueType: "string", importable: true },
  { key: "packageSize", label: "⚪︎梱包サイズ", valueType: "string", importable: true },
  { key: "usedGoodsItemType", label: "⚫︎品目", valueType: "string", importable: true },
  { key: "transactionDate", label: "⚫︎取引の年月日", valueType: "date", importable: true },
  { key: "usedGoodsFeature", label: "⚫︎古物の特徴", valueType: "string", importable: true }, // CustomFieldDefinition
  { key: "purchaseQuantity", label: "⚫︎数量", valueType: "number", importable: true },
  { key: "transactionType", label: "⚫︎取引区分", valueType: "string", importable: true },
  { key: "identityVerificationMethod", label: "⚫︎取引相手の真偽の確認のためにとった措置の区分および方法", valueType: "string", importable: true },
  { key: "counterpartyName", label: "⚫︎相手氏名", valueType: "string", importable: true },
  { key: "counterpartyOccupation", label: "⚫︎職業", valueType: "string", importable: true },
  { key: "counterpartyAddress", label: "⚫︎住所", valueType: "string", importable: true },
  { key: "purchasePrice", label: "⚫︎購入価格", valueType: "number", importable: true },
  { key: "shippingCost", label: "⚫︎送料", valueType: "number", importable: true },
  { key: "dailyPurchaseTotal", label: "⚫︎その日の仕入れ合計金額（他商品含む）", valueType: "number", importable: true },
  { key: "saleStartDate", label: "⚫︎販売開始日", valueType: "date", importable: true },
  { key: "saleEndDate", label: "⚫︎販売終了日", valueType: "date", importable: true },
  { key: "market", label: "⚫︎市場", valueType: "string", importable: true },
  { key: "salePrice", label: "⚫︎販売価格", valueType: "number", importable: true },
  { key: "externalProductId", label: "⚫︎商品ID", valueType: "string", importable: true },
  { key: "adminMemo", label: "★市川メモ", valueType: "string", importable: true },
  { key: "saleCommission", label: "⚫︎販売手数料", valueType: "number", importable: true },
  { key: "listingNotes", label: "<<出品情報>>", valueType: "string", importable: true },
];

/** BELLO独自列 — ZAICO互換ブロックの「後ろ」にのみ追加する。 */
export const BELLO_ONLY_FIELDS: ExportFieldDef[] = [
  SKU_FIELD,
  { key: "imageCount", label: "画像枚数", valueType: "number", importable: false },
  { key: "sourceSystem", label: "同期元システム", valueType: "string", importable: false },
  { key: "sourceInventoryId", label: "同期元ID", valueType: "string", importable: false },
  { key: "createdBy", label: "作成者", valueType: "string", importable: false },
  { key: "updatedBy", label: "更新者", valueType: "string", importable: false },
  { key: "salePriority", label: "売却の優先度", valueType: "string", importable: true }, // CustomFieldDefinition
];

/** Every static (non-dynamic-custom-field) export column, in export column order — ZAICO互換ブロック → BELLO独自列。管理者が今後追加する可能性のある、上記に含まれないcustom fieldはlib/inventory/inventoryExport.ts/inventoryImport.tsが実行時に末尾へ追加する。 */
export const STATIC_EXPORT_FIELDS: ExportFieldDef[] = [...ZAICO_COMPAT_FIELDS, ...BELLO_ONLY_FIELDS];

/** 上記の中でCustomFieldDefinition(customFieldSeed.ts)由来の値であり、Inventoryモデルの実カラムではないキー — lib/inventory/inventoryExport.ts/inventoryImport.tsの行組み立てで「item[key]ではなくcustomFields[key]を読む」対象を機械的に判定するために使う。 */
export const KNOWN_CUSTOM_FIELD_KEYS = new Set(["legHeight", "seatDimensions", "socketType", "packageSize", "usedGoodsFeature", "salePriority"]);

/** レガシー互換 — extendedFields.tsの~29フィールドのみを指す(customFieldは含まない)。CORE_EXPORT_FIELDSは廃止し、ZAICO_COMPAT_FIELDS/BELLO_ONLY_FIELDSへ統合した。 */
export const EXTENDED_EXPORT_FIELDS: ExportFieldDef[] = ALL_EXTENDED_FIELDS.map((f) => ({
  key: f.key,
  label: f.label,
  valueType: f.type === "number" ? "number" : f.type === "date" ? "date" : "string",
  importable: true,
}));

/** Which extendedFields.ts key holds a JPY money value vs. a date-shaped AWSDate string — used by inventoryImport.ts's per-field parser dispatch. Re-derived from EXTENDED_EXPORT_FIELDS rather than hand-listed, so a future extendedFields.ts change can't silently fall out of sync here. */
export const EXTENDED_FIELD_VALUE_TYPE: Record<ExtendedFieldKey, ExportFieldValueType> = Object.fromEntries(
  EXTENDED_EXPORT_FIELDS.map((f) => [f.key, f.valueType]),
) as Record<ExtendedFieldKey, ExportFieldValueType>;
