/**
 * 一覧直接編集 (統合改善指示書 §11) — which list columns are safely
 * inline-editable, and how. Deliberately a small, explicit whitelist
 * rather than "every visible column" — spec §11-1 lists exactly which
 * fields are safe for quick inline edits (simple scalars with no
 * multi-step workflow of their own); anything touching images, NORMAL/
 * DAMAGE, custom fields, history, or ZAICO sync metadata stays
 * detail-edit-only (`/inventory/[id]/edit`), matching this app's
 * existing role split between 一覧 (find fast) and 詳細編集 (edit
 * everything).
 *
 * Keyed by the SAME `key` lib/inventory/listColumns.ts's registry uses
 * (name/quantity/location/category/plannedSalePrice/salePrice/
 * purchasePrice/market/note/conditionRating/damageNotes) — a column is
 * inline-editable in the table only when it's ALSO currently visible
 * (統合改善指示書 §11: 表示設定と連動させる), so InventoryTable checks
 * both registries together rather than this one alone.
 *
 * Not `server-only`: read by the client-side table (which input to
 * render) and imported by the Server Action for its own whitelist check
 * (never trust the client's payload shape alone — see
 * app/actions/inventoryBulkEdit.ts).
 */
export type InlineEditFieldKey =
  | "name"
  | "quantity"
  | "location"
  | "category"
  | "plannedSalePrice"
  | "salePrice"
  | "purchasePrice"
  | "market"
  | "note"
  | "conditionRating"
  | "damageNotes";

export type InlineEditInputType = "text" | "number" | "select-category" | "select-location" | "textarea";

export const INLINE_EDIT_FIELDS: Record<InlineEditFieldKey, { inputType: InlineEditInputType }> = {
  name: { inputType: "text" },
  quantity: { inputType: "number" },
  location: { inputType: "select-location" },
  category: { inputType: "select-category" },
  plannedSalePrice: { inputType: "number" },
  salePrice: { inputType: "number" },
  purchasePrice: { inputType: "number" },
  market: { inputType: "text" },
  note: { inputType: "textarea" },
  conditionRating: { inputType: "textarea" },
  damageNotes: { inputType: "textarea" },
};

export function isInlineEditableColumn(key: string): key is InlineEditFieldKey {
  return Object.prototype.hasOwnProperty.call(INLINE_EDIT_FIELDS, key);
}

/**
 * One row's pending inline edits — every value already in the shape
 * `Inventory.update()` expects for that field (categoryId/locationId as
 * an id string or `null` to clear, prices/quantity as `number | null`,
 * the rest as `string | null`). `undefined`/absent key = "not edited,
 * leave alone"; present with `null` = "explicitly cleared".
 */
export interface InlineEditChanges {
  name?: string;
  quantity?: number | null;
  locationId?: string | null;
  categoryId?: string | null;
  plannedSalePrice?: number | null;
  salePrice?: number | null;
  purchasePrice?: number | null;
  market?: string | null;
  note?: string | null;
  conditionRating?: string | null;
  damageNotes?: string | null;
}

/** InventoryHistory rows written for 一覧直接編集 get this suffix on every field name, so they read distinctly from a 詳細編集 save in the same history list (spec §12: 「一覧直接編集」であることが分かる形で記録). */
export const INLINE_EDIT_HISTORY_SUFFIX = "（一覧直接編集）";
