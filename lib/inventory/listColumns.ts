/**
 * Registry of the Inventory list table's optional columns (spec: 一覧表示
 *列を設定画面から表示/非表示できるようにする). Not `server-only` — this
 * is imported by both the settings screen's toggle UI and the list
 * table's client-side rendering, and carries no data of its own, just
 * column metadata.
 *
 * "画像"/"SKU"/… here are the actual data columns; the list table's
 * leading checkbox column is a separate UI affordance (future bulk-select
 * entry point, spec §26/§20) and always shows regardless of this
 * settings — it isn't in this registry at all.
 *
 * Phase C is expected to add roughly 40 more Inventory fields — extending
 * the list to show any of them as an optional column later is meant to
 * be exactly this: one more entry here, plus one more `case` in
 * InventoryTable.tsx's cell renderer. Nothing about the settings UI,
 * localStorage shape, or the table's rendering loop needs to change.
 */
export interface InventoryListColumnDef {
  key: string;
  label: string;
  defaultVisible: boolean;
}

/**
 * Default visibility (spec: "一覧では情報を詰め込みすぎない方向"):
 * on by default are the columns needed to identify and act on a row at a
 * glance (image / SKU / name / quantity / location / category / sale
 * price / updated date); off by default are ones that matter less for a
 * quick scan (status, cost price, notes) but that an ADMIN/EDITOR/VIEWER
 * can still turn on for themselves from /inventory/settings.
 */
export const INVENTORY_LIST_COLUMNS: InventoryListColumnDef[] = [
  { key: "image", label: "画像", defaultVisible: true },
  { key: "status", label: "ステータス", defaultVisible: false },
  { key: "sku", label: "在庫ID", defaultVisible: true },
  { key: "name", label: "物品名", defaultVisible: true },
  { key: "quantity", label: "数量", defaultVisible: true },
  { key: "location", label: "保管場所", defaultVisible: true },
  { key: "category", label: "カテゴリ", defaultVisible: true },
  { key: "purchasePrice", label: "仕入原価", defaultVisible: false },
  // Phase C added a real `plannedSalePrice` field distinct from
  // `salePrice` (the actual, post-sale price) — this column now shows
  // the former (spec §7/§8's "販売予定価格"); `salePrice` gets its own,
  // off-by-default column below rather than being repurposed, since it's
  // a different real value that existing records may already have set.
  { key: "plannedSalePrice", label: "販売予定価格", defaultVisible: true },
  { key: "salePrice", label: "販売価格（成約）", defaultVisible: false },
  { key: "note", label: "備考", defaultVisible: false },
  { key: "updatedAt", label: "更新日", defaultVisible: true },
];

export function defaultColumnVisibility(): Record<string, boolean> {
  return Object.fromEntries(INVENTORY_LIST_COLUMNS.map((c) => [c.key, c.defaultVisible]));
}

/**
 * Bumping this key (rather than mutating the shape stored under it) is
 * the intended way to force everyone back to the new defaults if the
 * column set ever changes in an incompatible way later — old browsers
 * just start fresh under a new key instead of trying to migrate
 * whatever they had stored under the old one.
 */
export const INVENTORY_LIST_COLUMNS_STORAGE_KEY = "bello-inventory-list-columns-v1";
