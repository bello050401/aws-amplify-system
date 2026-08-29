"use client";

import { useMemo } from "react";
import Link from "next/link";
import type { CustomFieldDefinitionRow, InventoryListRow, MasterOption, StatusOption } from "@/lib/inventory/queries";
import { INVENTORY_LIST_COLUMNS, MIN_COLUMN_WIDTH, dynamicColumnDefsFrom, type InventoryListColumnDef } from "@/lib/inventory/listColumns";
import { isInlineEditableColumn, type InlineEditFieldKey } from "@/lib/inventory/inlineEdit";
import { useInventoryListColumns } from "../useInventoryListColumns";
import { InventoryThumbnail } from "../InventoryThumbnail";
import { useDirectEdit } from "./DirectEditProvider";

interface InventoryTableProps {
  rows: InventoryListRow[];
  categories: MasterOption[];
  locations: MasterOption[];
  categoriesById: Record<string, MasterOption>;
  locationsById: Record<string, MasterOption>;
  statusesById: Record<string, StatusOption>;
  /** 追加項目(CustomFieldDefinition)を動的な一覧列として表示するため(夜間開発指示書 §11)。 */
  customFieldDefs: CustomFieldDefinitionRow[];
}

/** `cf:<fieldKey>`列(動的なCustomField列)の値をrow.customFieldsから読む — 静的列と混在した同じレンダリングループから、どちらの種類の列かをkeyの接頭辞だけで判定できる。 */
function customFieldValueFromRow(row: InventoryListRow, columnKey: string): string {
  const fieldKey = columnKey.slice(3);
  const v = row.customFields?.[fieldKey];
  return v === null || v === undefined ? "" : String(v);
}

function formatYen(value: number | null): string {
  if (value === null) return "-";
  return value.toLocaleString("ja-JP");
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ja-JP");
}

function formatAwsDate(value: string | null): string {
  return value ? value.replace(/-/g, "/") : "-";
}

const numCell = "px-2 py-1 text-right tabular-nums overflow-hidden";
const cell = "px-2 py-1 overflow-hidden";
/** 一覧直接編集で入力中のセルは<td>のpaddingを持たない — inputClass自身のpx-2 py-1がinsetを肩代わりする(二重padding防止、通常表示との密度統一)。 */
const editableCell = "overflow-hidden";

/** 右寄せ表示する列(数値系)。幅そのものはlib/inventory/listColumns.tsのdefaultWidth + ユーザーのドラッグ操作(useInventoryListColumns.widths)へ一本化した — 列幅の初期値・保存値を二重管理しない。 */
const RIGHT_ALIGN_COLUMNS = new Set(["quantity", "purchasePrice", "plannedSalePrice", "salePrice", "saleCommission"]);

/** チェックボックス列は固定幅でよい(spec §13)。 */
const CHECKBOX_COLUMN_WIDTH = 32;

function renderReadOnlyCell(
  key: string,
  row: InventoryListRow,
  categoriesById: Record<string, MasterOption>,
  locationsById: Record<string, MasterOption>,
  statusesById: Record<string, StatusOption>,
): React.ReactNode {
  if (key.startsWith("cf:")) {
    const value = customFieldValueFromRow(row, key);
    return (
      <span className="block truncate text-gray-600" title={value || undefined}>
        {value || "-"}
      </span>
    );
  }
  switch (key) {
    case "image":
      // "list" (3:2, object-contain) — see InventoryThumbnail's own
      // comment. row.mainImageStorageKey is already the resolved top
      // image (see lib/inventory/queries.ts's toListRow), never just
      // "whichever image happens to sort first".
      return <InventoryThumbnail storageKey={row.mainImageStorageKey} alt={row.name} size="list" />;
    case "status": {
      const status = row.statusId ? statusesById[row.statusId] : undefined;
      return status ? (
        <span className="inline-block border border-gray-300 px-1.5 py-0.5 text-[11px] text-gray-700">{status.label}</span>
      ) : (
        <span className="text-gray-300">-</span>
      );
    }
    case "sku":
      return <span className="block truncate font-mono text-[12px] text-gray-700">{row.displayId}</span>;
    case "name":
      return (
        <span className="block truncate font-medium text-gray-900" title={row.name}>
          {row.name}
        </span>
      );
    case "quantity":
      return row.quantity;
    case "location": {
      const location = row.locationId ? locationsById[row.locationId] : undefined;
      return (
        <span className="block truncate text-gray-600" title={location?.name}>
          {location?.name ?? "-"}
        </span>
      );
    }
    case "category": {
      const category = row.categoryId ? categoriesById[row.categoryId] : undefined;
      return (
        <span className="block truncate text-gray-600" title={category?.name}>
          {category?.name ?? "-"}
        </span>
      );
    }
    case "purchasePrice":
      return formatYen(row.purchasePrice);
    case "plannedSalePrice":
      return formatYen(row.plannedSalePrice);
    case "salePrice":
      return formatYen(row.salePrice);
    case "note":
      return (
        <span className="block truncate text-gray-500" title={row.note ?? undefined}>
          {row.note ?? ""}
        </span>
      );
    case "updatedAt":
      return formatDate(row.updatedAt);
    case "barcode":
      return <span className="block truncate font-mono text-[12px] text-gray-600">{row.barcode ?? "-"}</span>;
    case "saleCommission":
      return formatYen(row.saleCommission);
    case "market":
      return row.market ?? "-";
    case "saleStartDate":
      return formatAwsDate(row.saleStartDate);
    case "saleEndDate":
      return formatAwsDate(row.saleEndDate);
    case "width":
      return row.width ?? "-";
    case "depth":
      return row.depth ?? "-";
    case "height":
      return row.height ?? "-";
    case "conditionRating":
      return (
        <span className="block truncate text-gray-600" title={row.conditionRating ?? undefined}>
          {row.conditionRating ?? "-"}
        </span>
      );
    case "damageNotes":
      return (
        <span className="block truncate text-gray-600" title={row.damageNotes ?? undefined}>
          {row.damageNotes ?? "-"}
        </span>
      );
    case "transactionDate":
      return formatAwsDate(row.transactionDate);
    case "transactionType":
      return row.transactionType ?? "-";
    case "adminMemo":
      return (
        <span className="block truncate text-gray-600" title={row.adminMemo ?? undefined}>
          {row.adminMemo ?? "-"}
        </span>
      );
    default:
      return null;
  }
}

/**
 * The editable-cell counterpart to renderReadOnlyCell, used only while
 * 一覧直接編集 is active (統合改善指示書 §11) — only for the whitelisted
 * columns lib/inventory/inlineEdit.ts declares safe for quick inline
 * edits. Every input is *uncontrolled-looking* but backed by
 * DirectEditProvider's edits map: `value` always falls back to the row's
 * current saved value when there's no pending edit, so an untouched cell
 * shows exactly what renderReadOnlyCell would.
 */
function renderEditableCell(
  column: InlineEditFieldKey,
  row: InventoryListRow,
  categories: MasterOption[],
  locations: MasterOption[],
  getValue: ReturnType<typeof useDirectEdit>["getValue"],
  setValue: ReturnType<typeof useDirectEdit>["setValue"],
): React.ReactNode {
  // 通常表示の読み取り専用セル(<td>のpx-2 py-1だけがinsetで、中身の
  // <span>自体は余白を持たない)と見た目の密度を揃える(夜間開発の
  // フォローアップ: 「通常一覧とDirect Editでヘッダー幅感が違う」) —
  // 編集モードの<td>はpaddingを0にし(下のnumCell/cellの分岐参照)、
  // その分をinput自身のpx-2 py-1が肩代わりする。<td>のpaddingとinputの
  // paddingが二重にならないため、同じ列幅で読み取り時と編集時の実効的
  // な余白が一致する。
  const inputClass = "block w-full border border-gray-300 bg-white px-2 py-1 text-[12px] focus:border-gray-500 focus:outline-none";

  switch (column) {
    case "name": {
      const value = getValue(row, "name") ?? row.name;
      return <input type="text" value={value} onChange={(e) => setValue(row.id, column, e.target.value)} className={inputClass} />;
    }
    case "quantity": {
      const value = getValue(row, "quantity") ?? row.quantity;
      return (
        <input
          type="number"
          value={value ?? ""}
          onChange={(e) => setValue(row.id, column, e.target.value === "" ? null : Number(e.target.value))}
          className={`${inputClass} text-right`}
        />
      );
    }
    case "location": {
      const value = getValue(row, "locationId") ?? row.locationId ?? "";
      return (
        <select value={value ?? ""} onChange={(e) => setValue(row.id, column, e.target.value || null)} className={inputClass}>
          <option value="">未選択</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      );
    }
    case "category": {
      const value = getValue(row, "categoryId") ?? row.categoryId ?? "";
      return (
        <select value={value ?? ""} onChange={(e) => setValue(row.id, column, e.target.value || null)} className={inputClass}>
          <option value="">未選択</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      );
    }
    case "plannedSalePrice":
    case "salePrice":
    case "purchasePrice": {
      const current = column === "plannedSalePrice" ? row.plannedSalePrice : column === "salePrice" ? row.salePrice : row.purchasePrice;
      const value = getValue(row, column) ?? current;
      return (
        <input
          type="number"
          value={value ?? ""}
          onChange={(e) => setValue(row.id, column, e.target.value === "" ? null : Number(e.target.value))}
          className={`${inputClass} text-right`}
        />
      );
    }
    case "market": {
      const value = getValue(row, "market") ?? row.market ?? "";
      return <input type="text" value={value ?? ""} onChange={(e) => setValue(row.id, column, e.target.value || null)} className={inputClass} />;
    }
    case "note":
    case "conditionRating":
    case "damageNotes": {
      const current = column === "note" ? row.note : column === "conditionRating" ? row.conditionRating : row.damageNotes;
      const value = getValue(row, column) ?? current;
      return (
        <textarea
          value={value ?? ""}
          onChange={(e) => setValue(row.id, column, e.target.value || null)}
          rows={1}
          className={`${inputClass} resize-y`}
        />
      );
    }
    default:
      // Every InlineEditFieldKey is handled above — this branch exists
      // only so TS sees a return on every path.
      return null;
  }
}

/**
 * High-density table — deliberately not a card grid. Every data cell's
 * content is its own block-level Link into the detail page, so the whole
 * row reads as clickable without extra onClick wiring — EXCEPT while
 * 一覧直接編集 (統合改善指示書 §11) is active, when navigation is
 * disabled entirely and inline-editable cells become real inputs
 * instead (spec §21: 商品詳細への遷移と一覧直接編集は混ぜない).
 *
 * Which columns render, and in what order, is driven by
 * useInventoryListColumns (a per-browser localStorage preference set
 * from /inventory/settings) — the exact same component/props/sizing
 * either way, so the plain list and a 詳細検索-filtered result set can
 * never visually diverge: this is the only place either one renders a
 * row.
 */
export function InventoryTable({ rows, categories, locations, categoriesById, locationsById, statusesById, customFieldDefs }: InventoryTableProps) {
  // 追加項目(CustomFieldDefinition)を動的な一覧列として扱う(夜間開発
  // 指示書 §11) — customFieldDefsが変わらない限りuseMemoで同じ配列参照
  // を保つ(useInventoryListColumns内のuseEffectの依存に使われるため)。
  const dynamicColumns: InventoryListColumnDef[] = useMemo(() => dynamicColumnDefsFrom(customFieldDefs), [customFieldDefs]);
  const { visibility, order, widths } = useInventoryListColumns(dynamicColumns);
  const columnByKey = new Map([...INVENTORY_LIST_COLUMNS, ...dynamicColumns].map((c) => [c.key, c]));
  const visibleColumns = order.map((key) => columnByKey.get(key)).filter((c): c is NonNullable<typeof c> => Boolean(c) && visibility[c!.key]);

  const { enabled: directEditEnabled, getValue, setValue, isRowDirty } = useDirectEdit();

  // 列幅はlib/inventory/listColumns.tsのdefaultWidth(表示設定の「初期
  // 設定に戻す」で使う既定値)を基準に、useInventoryListColumns経由の
  // 保存済み値があればそちらを優先する — 通常表示・一覧直接編集どちら
  // も同じこの1系統だけを参照するため、モード切替で幅が変わることは
  // ない。マウスドラッグでの列幅リサイズ機能は撤回・削除済み(spec:
  // 「カテゴリを含め、列幅リサイズ機能の追加・修正は行わなくて構いま
  // せん」) — 幅を変える唯一の手段は今後 defaultWidth の値そのものを
  // 変更することか、表示設定画面の「初期設定に戻す」のみ。
  function widthFor(key: string): number {
    return widths[key] ?? columnByKey.get(key)?.defaultWidth ?? 100;
  }

  if (rows.length === 0) {
    return <p className="p-6 text-sm text-gray-400">該当する在庫がありません。</p>;
  }

  const totalWidth = CHECKBOX_COLUMN_WIDTH + visibleColumns.reduce((sum, col) => sum + widthFor(col.key), 0);

  return (
    <div className="h-full overflow-auto">
      {/* table-layout: fixed + 明示的なtable幅(全可視列の合計) — これが
          ないとブラウザは内容量に応じて列幅を自動調整し直してしまい、
          設定した幅(物品名列を含む)が反映されない。合計がビューポート
          を超えた分は、外側のoverflow-autoコンテナが横スクロールで吸収
          する(物品名が長い場合でも他列や画像列を圧迫しない)。 */}
      <table className="border-collapse text-[13px]" style={{ tableLayout: "fixed", width: totalWidth }}>
        <thead className="sticky top-0 z-10 bg-gray-50 text-[11px] text-gray-500">
          <tr className="border-b border-gray-200">
            <th style={{ width: CHECKBOX_COLUMN_WIDTH }} className="px-2 py-1.5"></th>
            {visibleColumns.map((col) => {
              const w = widthFor(col.key);
              const align = RIGHT_ALIGN_COLUMNS.has(col.key) ? "text-right" : "text-left";
              return (
                <th key={col.key} style={{ width: w, minWidth: MIN_COLUMN_WIDTH }} className={`px-2 py-1.5 ${align}`}>
                  <span className="block truncate" title={col.label}>
                    {col.label}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const href = `/inventory/${row.id}`;
            const dirty = directEditEnabled && isRowDirty(row.id);
            return (
              <tr key={row.id} className={`border-b border-gray-100 ${dirty ? "bg-amber-50" : directEditEnabled ? "" : "hover:bg-gray-50"}`}>
                <td style={{ width: CHECKBOX_COLUMN_WIDTH }} className="px-2 py-1 text-center">
                  <input type="checkbox" className="align-middle" aria-label={`${row.name} を選択`} />
                </td>
                {visibleColumns.map((col) => {
                  const editable = directEditEnabled && isInlineEditableColumn(col.key);
                  const w = widthFor(col.key);
                  return (
                    <td
                      key={col.key}
                      style={{ width: w, minWidth: MIN_COLUMN_WIDTH }}
                      className={editable ? editableCell : RIGHT_ALIGN_COLUMNS.has(col.key) ? numCell : cell}
                    >
                      {editable ? (
                        // `editable` already confirmed col.key passes
                        // isInlineEditableColumn above — TS just can't
                        // track a type guard through an intermediate
                        // boolean variable, hence the assertion.
                        renderEditableCell(col.key as InlineEditFieldKey, row, categories, locations, getValue, setValue)
                      ) : directEditEnabled ? (
                        renderReadOnlyCell(col.key, row, categoriesById, locationsById, statusesById)
                      ) : (
                        <Link href={href} className="block">
                          {renderReadOnlyCell(col.key, row, categoriesById, locationsById, statusesById)}
                        </Link>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
