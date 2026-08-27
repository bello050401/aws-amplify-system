import Link from "next/link";
import type { MasterOption, StatusOption } from "@/lib/inventory/queries";

interface InventoryAdvancedSearchPanelProps {
  categories: MasterOption[];
  locations: MasterOption[];
  statuses: StatusOption[];
  q?: string;
  categoryId?: string;
  locationId?: string;
  statusId?: string;
}

/**
 * Spec §25: opens beside the list, not a page navigation, and only needs
 * to cover a handful of AND conditions in Phase 3 — full AND/OR condition
 * building on inventory_id / price ranges / created-updated dates /
 * CustomField is future work. What matters now is that this is its own
 * component reading/writing the same query-string contract as the quick
 * search and sidebar (q / categoryId / locationId / statusId), so
 * upgrading it later doesn't force a rewrite of InventoryToolbar or
 * InventorySidebar — they'd keep working unchanged either way.
 */
export function InventoryAdvancedSearchPanel({
  categories,
  locations,
  statuses,
  q,
  categoryId,
  locationId,
  statusId,
}: InventoryAdvancedSearchPanelProps) {
  return (
    <div className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-gray-200 bg-gray-50 p-3 text-sm">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[12px] font-bold text-gray-700">詳細検索</h2>
        <Link href="/inventory" className="text-[11px] text-gray-400 hover:text-gray-700">
          閉じる
        </Link>
      </div>
      <form action="/inventory" method="get" className="space-y-3">
        <div>
          <label className="block text-[11px] text-gray-500">商品名 / SKU</label>
          <input
            type="text"
            name="q"
            defaultValue={q}
            className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-[11px] text-gray-500">カテゴリ</label>
          <select
            name="categoryId"
            defaultValue={categoryId ?? ""}
            className="mt-0.5 w-full border border-gray-300 bg-white px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
          >
            <option value="">すべて</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[11px] text-gray-500">保管場所</label>
          <select
            name="locationId"
            defaultValue={locationId ?? ""}
            className="mt-0.5 w-full border border-gray-300 bg-white px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
          >
            <option value="">すべて</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[11px] text-gray-500">ステータス</label>
          <select
            name="statusId"
            defaultValue={statusId ?? ""}
            className="mt-0.5 w-full border border-gray-300 bg-white px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
          >
            <option value="">すべて</option>
            {statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <input type="hidden" name="advanced" value="1" />
        <button type="submit" className="w-full bg-gray-900 py-1.5 text-[13px] text-white hover:bg-gray-800">
          検索
        </button>
      </form>
      <p className="mt-3 text-[11px] leading-relaxed text-gray-400">
        現在はすべての条件をAND(かつ)で組み合わせます。OR条件・数量や価格の範囲指定・追加項目での検索は今後のPhaseで対応します。
      </p>
    </div>
  );
}
