/**
 * The shared field registry for both CSV/Excel export and import
 * (統合改善指示書 §11/§14) — one place mapping "internal Inventory field
 * key" ↔ "Japanese column header", reused by:
 * - lib/inventory/inventoryExport.ts (builds the header row + cell values)
 * - lib/inventory/inventoryImport.ts (auto-suggests a column mapping by
 *   matching an uploaded file's header text against these SAME labels,
 *   so a file BELLO itself exported needs zero manual re-mapping to
 *   import — spec §14: "BELLOからエクスポートしたファイルを、そのまま
 *   BELLOへ再インポートしやすい形式にしてください")
 *
 * Not `server-only` — pure data, no Amplify/Data access, safe to import
 * from a client component (the import wizard's mapping UI needs these
 * labels too).
 *
 * Labels for the ~29 extendedFields.ts fields are reused verbatim from
 * that registry (Single Source of Truth — spec §1) rather than
 * redeclared here; only the handful of core Inventory columns
 * extendedFields.ts doesn't cover (sku/name/category/location/status/
 * quantity/unit/purchasePrice/salePrice/barcode/note) get their own
 * label here, matching the exact wording already used in the New/Edit
 * forms' hardcoded labels for those same fields.
 */
import { ALL_EXTENDED_FIELDS, type ExtendedFieldKey } from "./extendedFields";

export type ExportFieldValueType = "string" | "number" | "date" | "datetime";

export interface ExportFieldDef {
  key: string;
  label: string;
  valueType: ExportFieldValueType;
  /** Importable = a real Inventory column the New/Edit forms can also set. `false` for SKU (match key only, never a write target — see inventoryImport.ts) and for system/derived metadata (画像枚数/作成日時/etc.) that only ever comes from the database, never from a file. */
  importable: boolean;
}

/** SKU is listed separately (not in this array) — it's the one export column that is NEVER a mapping target on import, only the match key. See inventoryImport.ts. */
export const SKU_FIELD: ExportFieldDef = { key: "sku", label: "SKU", valueType: "string", importable: false };

export const CORE_EXPORT_FIELDS: ExportFieldDef[] = [
  { key: "name", label: "商品名", valueType: "string", importable: true },
  { key: "categoryName", label: "カテゴリ", valueType: "string", importable: true },
  { key: "locationName", label: "保管場所", valueType: "string", importable: true },
  { key: "statusLabel", label: "状態", valueType: "string", importable: true },
  { key: "quantity", label: "数量", valueType: "number", importable: true },
  { key: "unit", label: "単位", valueType: "string", importable: true },
  { key: "purchasePrice", label: "購入価格", valueType: "number", importable: true },
  { key: "salePrice", label: "販売価格", valueType: "number", importable: true },
  { key: "barcode", label: "バーコード", valueType: "string", importable: true },
  { key: "note", label: "備考", valueType: "string", importable: true },
];

/** extendedFields.ts's ~29 fields, reused as-is (label/valueType derived from that registry's own `label`/`type` — never redeclared by hand here). */
export const EXTENDED_EXPORT_FIELDS: ExportFieldDef[] = ALL_EXTENDED_FIELDS.map((f) => ({
  key: f.key,
  label: f.label,
  valueType: f.type === "number" ? "number" : f.type === "date" ? "date" : "string",
  importable: true,
}));

/** Read-only, system-derived — exported for completeness/backup (spec §11 explicitly names バックアップ as a use case) but never offered as an import mapping target. */
export const META_EXPORT_FIELDS: ExportFieldDef[] = [
  { key: "imageCount", label: "画像枚数", valueType: "number", importable: false },
  { key: "sourceSystem", label: "同期元システム", valueType: "string", importable: false },
  { key: "sourceInventoryId", label: "同期元ID", valueType: "string", importable: false },
  { key: "createdAt", label: "作成日時", valueType: "datetime", importable: false },
  { key: "updatedAt", label: "更新日時", valueType: "datetime", importable: false },
  { key: "createdBy", label: "作成者", valueType: "string", importable: false },
  { key: "updatedBy", label: "更新者", valueType: "string", importable: false },
];

/** Every static (non-custom-field) export column, in export column order. Custom fields (admin-defined, dynamic — see lib/inventory/customFieldSeed.ts) are appended separately at export/import time since they aren't known until CustomFieldDefinition is queried. */
export const STATIC_EXPORT_FIELDS: ExportFieldDef[] = [SKU_FIELD, ...CORE_EXPORT_FIELDS, ...EXTENDED_EXPORT_FIELDS, ...META_EXPORT_FIELDS];

/** Which extendedFields.ts key holds a JPY money value vs. a date-shaped AWSDate string — used by inventoryImport.ts's per-field parser dispatch. Re-derived from EXTENDED_EXPORT_FIELDS rather than hand-listed, so a future extendedFields.ts change can't silently fall out of sync here. */
export const EXTENDED_FIELD_VALUE_TYPE: Record<ExtendedFieldKey, ExportFieldValueType> = Object.fromEntries(
  EXTENDED_EXPORT_FIELDS.map((f) => [f.key, f.valueType]),
) as Record<ExtendedFieldKey, ExportFieldValueType>;
