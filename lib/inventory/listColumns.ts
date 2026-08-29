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
  /** 初期の列幅(px)。夜間開発指示書 §13: マウスドラッグでのリサイズに対応するための基準値 — InventoryTable.tsxのリサイズハンドルはこの値を下回れない(minWidth)。 */
  defaultWidth: number;
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
  { key: "image", label: "画像", defaultVisible: true, defaultWidth: 106 },
  { key: "status", label: "ステータス", defaultVisible: false, defaultWidth: 96 },
  { key: "sku", label: "在庫ID", defaultVisible: true, defaultWidth: 128 },
  // 追加修正指示 §1: 120px(前回の「約50%縮小」後の値)はSKU/保管場所等
  // と比べても物品名が読み取りづらいとのフィードバックを受け、約1.5倍の
  // 180pxへ拡大。他列(image/quantity/location/category/plannedSalePrice/
  // updatedAt等)のdefaultWidthは一切変更していない — 可視列合計
  // (totalWidth, InventoryTable.tsx)が広がった分は外側のoverflow-auto
  // コンテナの横スクロールが吸収するため、他列を圧迫しない。列幅の
  // マウスドラッグリサイズ機能自体は撤回・削除済み(InventoryTable.tsx
  // 参照)で、この値が表示設定「初期設定に戻す」でも使われる唯一の基準
  // 値であることに変わりはない。
  { key: "name", label: "物品名", defaultVisible: true, defaultWidth: 180 },
  { key: "quantity", label: "数量", defaultVisible: true, defaultWidth: 64 },
  { key: "location", label: "保管場所", defaultVisible: true, defaultWidth: 112 },
  { key: "category", label: "カテゴリ", defaultVisible: true, defaultWidth: 112 },
  // 追加修正指示 §9-§11: 「原価」は今後purchasePriceを唯一のデータソー
  // スとする運用方針(送料等を含めた最終仕入原価を直接入力)に変更した
  // ため、一覧列のラベルも実態に合わせて「仕入原価」から「原価」へ変更
  // した(キー/データ自体は不変 — 表示ラベルのみの変更)。
  { key: "purchasePrice", label: "原価", defaultVisible: false, defaultWidth: 96 },
  // Phase C added a real `plannedSalePrice` field distinct from
  // `salePrice` (the actual, post-sale price) — this column now shows
  // the former (spec §7/§8's "販売予定価格"); `salePrice` gets its own,
  // off-by-default column below rather than being repurposed, since it's
  // a different real value that existing records may already have set.
  { key: "plannedSalePrice", label: "販売予定価格", defaultVisible: true, defaultWidth: 100 },
  { key: "salePrice", label: "販売価格（成約）", defaultVisible: false, defaultWidth: 100 },
  { key: "note", label: "備考", defaultVisible: false, defaultWidth: 200 },
  { key: "updatedAt", label: "更新日", defaultVisible: true, defaultWidth: 96 },
  // 統合改善指示書 §10で追加された列候補 — すべて既存のInventoryフィー
  // ルド(extendedFields.ts経由)をそのまま列として公開するだけで、
  // schema変更は伴わない。一覧を情報過多にしないため、既定は非表示。
  { key: "barcode", label: "バーコード", defaultVisible: false, defaultWidth: 128 },
  { key: "saleCommission", label: "販売手数料", defaultVisible: false, defaultWidth: 96 },
  { key: "market", label: "市場", defaultVisible: false, defaultWidth: 96 },
  { key: "saleStartDate", label: "販売開始日", defaultVisible: false, defaultWidth: 96 },
  { key: "saleEndDate", label: "販売終了日", defaultVisible: false, defaultWidth: 96 },
  { key: "width", label: "幅", defaultVisible: false, defaultWidth: 72 },
  { key: "depth", label: "奥行", defaultVisible: false, defaultWidth: 72 },
  { key: "height", label: "高さ", defaultVisible: false, defaultWidth: 72 },
  { key: "conditionRating", label: "コンディション評価", defaultVisible: false, defaultWidth: 160 },
  { key: "damageNotes", label: "傷・汚れメモ", defaultVisible: false, defaultWidth: 160 },
  { key: "transactionDate", label: "取引年月日", defaultVisible: false, defaultWidth: 96 },
  { key: "transactionType", label: "取引区分", defaultVisible: false, defaultWidth: 96 },
  { key: "adminMemo", label: "管理メモ", defaultVisible: false, defaultWidth: 160 },
];

/** 列幅の下限(px) — defaultWidth/保存済みwidthがどんな値でも、テキストや操作可能領域が潰れて使い物にならなくなるのを防ぐ安全弁。マウスドラッグでの列幅リサイズ機能自体は撤回・削除済み(InventoryTable.tsx参照)。 */
export const MIN_COLUMN_WIDTH = 48;

/** 動的なCustomFieldDefinitionを列定義へ変換する際の初期幅(px)。長めの自由記述もある程度読める幅を確保しつつ、既定では表示しない(defaultVisible: false)ため一覧を情報過多にしない。 */
const DYNAMIC_COLUMN_DEFAULT_WIDTH = 130;

/**
 * 追加項目(CustomFieldDefinition)を一覧の任意列として扱うための変換
 * (夜間開発指示書 §11: 「追加したCustomFieldがコード変更なしで…一覧
 * 表示設定…へ反映される」)。key は`cf:<fieldKey>`— lib/inventory/
 * advancedSearch.tsの詳細検索と同じ接頭辞にして、静的列のキー(英語の
 * 単語1つ)と衝突しないようにしている。呼び出し側(useInventoryListColumns
 * /ListColumnSettings.tsx/InventoryTable.tsx)は、実行時に取得した
 * CustomFieldDefinition一覧をこの関数に通すだけでよい。
 */
export function dynamicColumnDefsFrom(customFieldDefs: { fieldKey: string; label: string }[]): InventoryListColumnDef[] {
  return customFieldDefs.map((def) => ({
    key: `cf:${def.fieldKey}`,
    label: def.label,
    defaultVisible: false,
    defaultWidth: DYNAMIC_COLUMN_DEFAULT_WIDTH,
  }));
}

export function defaultColumnVisibility(dynamicColumns: InventoryListColumnDef[] = []): Record<string, boolean> {
  return Object.fromEntries([...INVENTORY_LIST_COLUMNS, ...dynamicColumns].map((c) => [c.key, c.defaultVisible]));
}

/** The registry's own array order — the default column order before any per-user reordering (統合改善指示書 §10: カラム順序)。動的列は末尾に追加される。 */
export function defaultColumnOrder(dynamicColumns: InventoryListColumnDef[] = []): string[] {
  return [...INVENTORY_LIST_COLUMNS, ...dynamicColumns].map((c) => c.key);
}

/** 夜間開発指示書 §13: 列幅(px)の初期値マップ。 */
export function defaultColumnWidths(dynamicColumns: InventoryListColumnDef[] = []): Record<string, number> {
  return Object.fromEntries([...INVENTORY_LIST_COLUMNS, ...dynamicColumns].map((c) => [c.key, c.defaultWidth]));
}

export interface ColumnPreferences {
  visibility: Record<string, boolean>;
  /** Every known column key, in display order. */
  order: string[];
  /** 列ごとの表示幅(px) — 夜間開発指示書 §13。既存(v2)のlocalStorage値にはこのキー自体が存在しないため、読み込み時はdefaultColumnWidths()から始めて保存済みの値だけ上書きする(readStoredのvisibility/orderと同じ後方互換パターン) — ストレージキーのバージョンを上げる必要はない。 */
  widths: Record<string, number>;
}

export function defaultColumnPreferences(dynamicColumns: InventoryListColumnDef[] = []): ColumnPreferences {
  return {
    visibility: defaultColumnVisibility(dynamicColumns),
    order: defaultColumnOrder(dynamicColumns),
    widths: defaultColumnWidths(dynamicColumns),
  };
}

/**
 * Bumping this key (rather than mutating the shape stored under it) is
 * the intended way to force everyone back to the new defaults if the
 * column set ever changes in an incompatible way later — old browsers
 * just start fresh under a new key instead of trying to migrate
 * whatever they had stored under the old one. Bumped v1→v2 when column
 * *order* (not just visibility) became a stored preference — v1's value
 * was a flat visibility map with no order field at all, so reading it as
 * v2's `{ visibility, order }` shape would need silent, fragile format
 * sniffing; a clean version bump is simpler and matches this file's own
 * documented migration strategy.
 */
export const INVENTORY_LIST_COLUMNS_STORAGE_KEY = "bello-inventory-list-columns-v2";
