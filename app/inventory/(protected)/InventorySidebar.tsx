import Link from "next/link";
import type { MasterOption } from "@/lib/inventory/queries";
import { CategoryFilterList } from "./CategoryFilterList";

interface InventorySidebarProps {
  categories: MasterOption[];
  locations: MasterOption[];
  activeCategoryId?: string;
  activeLocationId?: string;
  q?: string;
}

function buildHref(params: { q?: string; categoryId?: string; locationId?: string }) {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.categoryId) sp.set("categoryId", params.categoryId);
  if (params.locationId) sp.set("locationId", params.locationId);
  const qs = sp.toString();
  return qs ? `/inventory?${qs}` : "/inventory";
}

/**
 * Second of the three layers (spec §17/§19): 保管場所 / カテゴリ facets,
 * independent of each other (picking a location keeps whatever category
 * filter was already active, and vice versa) so they combine rather than
 * override. Both lists are rendered flat — Category/Location.parentId
 * exists in the data model for future hierarchy (see amplify/data/resource.ts)
 * but Phase 3 doesn't need a tree UI to be useful; a flat list some day
 * with a handful of parentId-having rows just reads as a slightly odd
 * flat list, not a structure that needs rework to become a real tree.
 */
export function InventorySidebar({ categories, locations, activeCategoryId, activeLocationId, q }: InventorySidebarProps) {
  const isAll = !activeCategoryId && !activeLocationId;

  return (
    <aside className="flex w-52 shrink-0 flex-col overflow-y-auto border-r border-gray-200 bg-white text-sm">
      <div className="border-b border-gray-100 p-2">
        <Link
          href={buildHref({ q })}
          className={`block px-2 py-1.5 text-[13px] ${isAll ? "bg-gray-100 font-bold text-gray-900" : "text-gray-700 hover:bg-gray-50"}`}
        >
          すべての在庫
        </Link>
      </div>

      <div className="border-b border-gray-100 p-2">
        <p className="px-2 py-1 text-[11px] font-bold text-gray-400">保管場所</p>
        <ul>
          {locations.length === 0 && <li className="px-2 py-1 text-[12px] text-gray-300">未登録</li>}
          {locations.map((loc) => (
            <li key={loc.id}>
              <Link
                href={buildHref({ q, categoryId: activeCategoryId, locationId: loc.id })}
                className={`block truncate px-2 py-1 text-[13px] ${
                  activeLocationId === loc.id ? "bg-gray-100 font-bold text-gray-900" : "text-gray-700 hover:bg-gray-50"
                }`}
                title={loc.name}
              >
                {loc.name}
              </Link>
            </li>
          ))}
        </ul>
      </div>

      <div className="p-2">
        <p className="px-2 py-1 text-[11px] font-bold text-gray-400">カテゴリ</p>
        <CategoryFilterList
          categories={categories}
          activeCategoryId={activeCategoryId}
          activeLocationId={activeLocationId}
          q={q}
        />
      </div>
    </aside>
  );
}
