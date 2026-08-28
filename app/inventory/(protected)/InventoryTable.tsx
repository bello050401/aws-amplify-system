import Link from "next/link";
import type { InventoryListRow, MasterOption, StatusOption } from "@/lib/inventory/queries";
import { InventoryThumbnail } from "../InventoryThumbnail";

interface InventoryTableProps {
  rows: InventoryListRow[];
  categoriesById: Map<string, MasterOption>;
  locationsById: Map<string, MasterOption>;
  statusesById: Map<string, StatusOption>;
}

function formatYen(value: number | null): string {
  if (value === null) return "-";
  return value.toLocaleString("ja-JP");
}

const numCell = "px-2 py-1 text-right tabular-nums";
const cell = "px-2 py-1";

/**
 * High-density table (spec §20/§32) — deliberately not a card grid.
 * Every data cell's content is its own block-level Link into the detail
 * page, so the whole row reads as clickable without a client component
 * (no onClick needed on a Server Component). The checkbox column is the
 * one exception, on purpose: it's for the future bulk-select /
 * 直接編集モード entry point (spec §26/§20) and must never trigger
 * navigation once that lands.
 */
export function InventoryTable({ rows, categoriesById, locationsById, statusesById }: InventoryTableProps) {
  if (rows.length === 0) {
    return <p className="p-6 text-sm text-gray-400">該当する在庫がありません。</p>;
  }

  return (
    <div className="h-full overflow-auto">
      <table className="w-full min-w-[1100px] border-collapse text-[13px]">
        <thead className="sticky top-0 z-10 bg-gray-50 text-[11px] text-gray-500">
          <tr className="border-b border-gray-200">
            <th className="w-8 px-2 py-1.5"></th>
            <th className="w-[76px] px-2 py-1.5 text-left">画像</th>
            <th className="w-24 px-2 py-1.5 text-left">ステータス</th>
            <th className="w-32 px-2 py-1.5 text-left">SKU</th>
            <th className="min-w-[220px] px-2 py-1.5 text-left">商品名</th>
            <th className="w-16 px-2 py-1.5 text-right">数量</th>
            <th className="w-28 px-2 py-1.5 text-left">保管場所</th>
            <th className="w-28 px-2 py-1.5 text-left">カテゴリ</th>
            <th className="w-24 px-2 py-1.5 text-right">仕入単価</th>
            <th className="w-24 px-2 py-1.5 text-right">販売価格</th>
            <th className="min-w-[200px] px-2 py-1.5 text-left">備考</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const href = `/inventory/${row.id}`;
            const status = row.statusId ? statusesById.get(row.statusId) : undefined;
            const category = row.categoryId ? categoriesById.get(row.categoryId) : undefined;
            const location = row.locationId ? locationsById.get(row.locationId) : undefined;
            return (
              <tr key={row.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-2 py-1 text-center">
                  <input type="checkbox" className="align-middle" aria-label={`${row.name} を選択`} />
                </td>
                <td className={cell}>
                  <Link href={href} className="block">
                    <InventoryThumbnail storageKey={row.mainImageStorageKey} alt={row.name} size="medium" />
                  </Link>
                </td>
                <td className={cell}>
                  <Link href={href} className="block">
                    {status ? (
                      <span className="inline-block border border-gray-300 px-1.5 py-0.5 text-[11px] text-gray-700">
                        {status.label}
                      </span>
                    ) : (
                      <span className="text-gray-300">-</span>
                    )}
                  </Link>
                </td>
                <td className={cell}>
                  <Link href={href} className="block truncate font-mono text-[12px] text-gray-700">
                    {row.sku}
                  </Link>
                </td>
                <td className={cell}>
                  <Link href={href} className="block truncate font-medium text-gray-900" title={row.name}>
                    {row.name}
                  </Link>
                </td>
                <td className={numCell}>
                  <Link href={href} className="block">
                    {row.quantity}
                  </Link>
                </td>
                <td className={cell}>
                  <Link href={href} className="block truncate text-gray-600" title={location?.name}>
                    {location?.name ?? "-"}
                  </Link>
                </td>
                <td className={cell}>
                  <Link href={href} className="block truncate text-gray-600" title={category?.name}>
                    {category?.name ?? "-"}
                  </Link>
                </td>
                <td className={numCell}>
                  <Link href={href} className="block">
                    {formatYen(row.purchasePrice)}
                  </Link>
                </td>
                <td className={numCell}>
                  <Link href={href} className="block">
                    {formatYen(row.salePrice)}
                  </Link>
                </td>
                <td className={cell}>
                  <Link href={href} className="block truncate text-gray-500" title={row.note ?? undefined}>
                    {row.note ?? ""}
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
