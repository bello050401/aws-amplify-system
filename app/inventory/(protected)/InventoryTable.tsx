"use client";

import Link from "next/link";
import type { InventoryListRow, MasterOption, StatusOption } from "@/lib/inventory/queries";
import { INVENTORY_LIST_COLUMNS } from "@/lib/inventory/listColumns";
import { useInventoryListColumns } from "../useInventoryListColumns";
import { InventoryThumbnail } from "../InventoryThumbnail";

interface InventoryTableProps {
  rows: InventoryListRow[];
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

const numCell = "px-2 py-1 text-right tabular-nums";
const cell = "px-2 py-1";

/** Header label + width for each optional column — kept next to the cell renderer below rather than folded into lib/inventory/listColumns.ts, since column width is a layout detail of this one table, not shared with the settings screen's toggle list. */
const COLUMN_META: Record<string, { className: string; align?: "right" }> = {
  image: { className: "w-[76px]" },
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
};

function renderCell(
  key: string,
  row: InventoryListRow,
  categoriesById: Record<string, MasterOption>,
  locationsById: Record<string, MasterOption>,
  statusesById: Record<string, StatusOption>,
): React.ReactNode {
  switch (key) {
    case "image":
      return <InventoryThumbnail storageKey={row.mainImageStorageKey} alt={row.name} size="medium" />;
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
    default:
      return null;
  }
}

/**
 * High-density table (spec §20/§32) — deliberately not a card grid.
 * Every data cell's content is its own block-level Link into the detail
 * page, so the whole row reads as clickable without extra onClick
 * wiring. The checkbox column is the one exception, on purpose: it's for
 * the future bulk-select / 直接編集モード entry point (spec §26/§20) and
 * must never trigger navigation once that lands.
 *
 * Which of the other columns actually render is driven by
 * useInventoryListColumns (a per-browser localStorage preference set
 * from /inventory/settings) — the exact same component/props/sizing
 * either way, so the plain list and a 詳細検索-filtered result set can
 * never visually diverge: this is the only place either one renders a
 * row. A Client Component so it can read that preference; see that
 * hook's own comment for why its initial (pre-hydration) render always
 * matches the defaults the server would have rendered, avoiding a
 * hydration mismatch.
 */
export function InventoryTable({ rows, categoriesById, locationsById, statusesById }: InventoryTableProps) {
  const { visibility } = useInventoryListColumns();
  const visibleColumns = INVENTORY_LIST_COLUMNS.filter((c) => visibility[c.key]);

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
            return (
              <tr key={row.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-2 py-1 text-center">
                  <input type="checkbox" className="align-middle" aria-label={`${row.name} を選択`} />
                </td>
                {visibleColumns.map((col) => (
                  <td key={col.key} className={COLUMN_META[col.key]?.align === "right" ? numCell : cell}>
                    <Link href={href} className="block">
                      {renderCell(col.key, row, categoriesById, locationsById, statusesById)}
                    </Link>
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
