"use client";

import Link from "next/link";
import type { MasterOption } from "@/lib/inventory/queries";
import { useUnsavedChanges } from "../UnsavedChangesProvider";
import { CategoryFilterList } from "./CategoryFilterList";

interface InventorySidebarProps {
  categories: MasterOption[];
  locations: MasterOption[];
  activeCategoryIds: string[];
  activeLocationId?: string;
  q?: string;
}

function buildHref(params: { q?: string; categoryIds?: string[]; locationId?: string }) {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.categoryIds && params.categoryIds.length > 0) sp.set("categoryIds", params.categoryIds.join(","));
  if (params.locationId) sp.set("locationId", params.locationId);
  const qs = sp.toString();
  return qs ? `/inventory?${qs}` : "/inventory";
}

/**
 * Second of the three layers: 保管場所 / カテゴリ facets, independent of
 * each other (picking a location keeps whatever category filter was
 * already active, and vice versa) so they combine rather than override.
 * 保管場所 stays single-select (統合改善指示書 §9: 保管場所は現状単一
 * 選択で構わない); カテゴリ is multi-select OR (see CategoryFilterList).
 *
 * A Client Component (was a server component) because every link here
 * now needs to go through the shared 未保存変更ガード when 一覧直接編
 * 集 has dirty rows pending (統合改善指示書 §13) — see handleClick.
 */
export function InventorySidebar({ categories, locations, activeCategoryIds, activeLocationId, q }: InventorySidebarProps) {
  const isAll = activeCategoryIds.length === 0 && !activeLocationId;
  const { isDirty, guardedNavigate } = useUnsavedChanges();

  function handleClick(e: React.MouseEvent, href: string) {
    if (!isDirty) return;
    e.preventDefault();
    guardedNavigate(href);
  }

  return (
    <aside className="flex w-52 shrink-0 flex-col overflow-y-auto border-r border-gray-200 bg-white text-sm">
      <div className="border-b border-gray-100 p-2">
        <Link
          href={buildHref({ q })}
          onClick={(e) => handleClick(e, buildHref({ q }))}
          className={`block px-2 py-1.5 text-[13px] ${isAll ? "bg-gray-100 font-bold text-gray-900" : "text-gray-700 hover:bg-gray-50"}`}
        >
          すべての在庫
        </Link>
      </div>

      <div className="border-b border-gray-100 p-2">
        <p className="px-2 py-1 text-[11px] font-bold text-gray-400">保管場所</p>
        <ul>
          {locations.length === 0 && <li className="px-2 py-1 text-[12px] text-gray-300">未登録</li>}
          {locations.map((loc) => {
            const href = buildHref({ q, categoryIds: activeCategoryIds, locationId: loc.id });
            return (
              <li key={loc.id}>
                <Link
                  href={href}
                  onClick={(e) => handleClick(e, href)}
                  className={`block truncate px-2 py-1 text-[13px] ${
                    activeLocationId === loc.id ? "bg-gray-100 font-bold text-gray-900" : "text-gray-700 hover:bg-gray-50"
                  }`}
                  title={loc.name}
                >
                  {loc.name}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="p-2">
        <p className="px-2 py-1 text-[11px] font-bold text-gray-400">カテゴリ</p>
        <CategoryFilterList categories={categories} activeCategoryIds={activeCategoryIds} activeLocationId={activeLocationId} q={q} />
      </div>
    </aside>
  );
}
