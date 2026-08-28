"use client";

import Link from "next/link";
import type { InventoryListRow, MasterOption, StatusOption } from "@/lib/inventory/queries";
import { INVENTORY_LIST_COLUMNS } from "@/lib/inventory/listColumns";
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

const numCell = "px-2 py-1 text-right tabular-nums";
const cell = "px-2 py-1";

/** Header label + width for each optional column — kept next to the cell renderer below rather than folded into lib/inventory/listColumns.ts, since column width is a layout detail of this one table, not shared with the settings screen's toggle list. */
const COLUMN_META: Record<string, { className: string; align?: "right" }> = {
  image: { className: "w-[106px]" }, // fits the 90px-wide "list" thumbnail with a little breathing room either side
  status: { className: "w-24" },
  sku: { className: "w-32" },
  name: { className: "min-w-[220px]" },
  quantity: { className: "w-16", align: "right" },
  location: { className: "w-28" },
  category: { className: "w-28" },
  purchasePrice: { className: "w-24", align: "right" },
  plannedSalePrice: { className: "w-24", align: "right" },
  salePrice: { className: "w-24", align: "right" },
  note: { className: "min-w-[200px]" },
  updatedAt: { className: "w-24" },
  barcode: { className: "w-32" },
  saleCommission: { className: "w-24", align: "right" },
  market: { className: "w-24" },
  saleStartDate: { className: "w-24" },
  saleEndDate: { className: "w-24" },
  width: { className: "w-16" },
  depth: { className: "w-16" },
  height: { className: "w-16" },
  conditionRating: { className: "min-w-[160px]" },
  damageNotes: { className: "min-w-[160px]" },
  transactionDate: { className: "w-24" },
  transactionType: { className: "w-24" },
  adminMemo: { className: "min-w-[160px]" },
};

function renderReadOnlyCell(
  key: string,
  row: InventoryListRow,
  categoriesById: Record<string, MasterOption>,
  locationsById: Record<string, MasterOption>,
  statusesById: Record<string, StatusOption>,
): React.ReactNode {
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
      return <span className="block truncate font-mono text-[12px] text-gray-700">{row.sku}</span>;
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
  const inputClass = "w-full border border-gray-300 bg-white px-1 py-0.5 text-[12px] focus:border-gray-500 focus:outline-none";

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
export function InventoryTable({ rows, categories, locations, categoriesById, locationsById, statusesById }: InventoryTableProps) {
  const { visibility, order } = useInventoryListColumns();
  const columnByKey = new Map(INVENTORY_LIST_COLUMNS.map((c) => [c.key, c]));
  const visibleColumns = order.map((key) => columnByKey.get(key)).filter((c): c is NonNullable<typeof c> => Boolean(c) && visibility[c!.key]);

  const { enabled: directEditEnabled, getValue, setValue, isRowDirty } = useDirectEdit();

  if (rows.length === 0) {
    return <p className="p-6 text-sm text-gray-400">該当する在庫がありません。</p>;
  }

  return (
    <div className="h-full overflow-auto">
      <table className="w-full min-w-[900px] border-collapse text-[13px]">
        <thead className="sticky top-0 z-10 bg-gray-50 text-[11px] text-gray-500">
          <tr className="border-b border-gray-200">
            <th className="w-8 px-2 py-1.5"></th>
            {visibleColumns.map((col) => (
              <th
                key={col.key}
                className={`${COLUMN_META[col.key]?.className ?? ""} px-2 py-1.5 ${COLUMN_META[col.key]?.align === "right" ? "text-right" : "text-left"}`}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const href = `/inventory/${row.id}`;
            const dirty = directEditEnabled && isRowDirty(row.id);
            return (
              <tr key={row.id} className={`border-b border-gray-100 ${dirty ? "bg-amber-50" : directEditEnabled ? "" : "hover:bg-gray-50"}`}>
                <td className="px-2 py-1 text-center">
                  <input type="checkbox" className="align-middle" aria-label={`${row.name} を選択`} />
                </td>
                {visibleColumns.map((col) => {
                  const editable = directEditEnabled && isInlineEditableColumn(col.key);
                  return (
                    <td key={col.key} className={COLUMN_META[col.key]?.align === "right" && !editable ? numCell : cell}>
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
