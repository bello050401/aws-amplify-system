"use client";

import { useState } from "react";
import Link from "next/link";
import type { MasterOption } from "@/lib/inventory/queries";

interface CategoryFilterListProps {
  categories: MasterOption[];
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

/** Client-only piece of InventorySidebar (spec §19's カテゴリ検索欄) — narrows the *visible list*, navigation on click still applies the real filter server-side. */
export function CategoryFilterList({ categories, activeCategoryId, activeLocationId, q }: CategoryFilterListProps) {
  const [search, setSearch] = useState("");
  const visible = search.trim()
    ? categories.filter((c) => c.name.toLowerCase().includes(search.trim().toLowerCase()))
    : categories;

  return (
    <div>
      <input
        type="text"
        placeholder="カテゴリを検索"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="mb-1 w-full border border-gray-200 px-2 py-1 text-[12px] focus:border-gray-400 focus:outline-none"
      />
      <ul>
        {visible.length === 0 && <li className="px-2 py-1 text-[12px] text-gray-300">該当なし</li>}
        {visible.map((cat) => (
          <li key={cat.id}>
            <Link
              href={buildHref({ q, categoryId: cat.id, locationId: activeLocationId })}
              className={`block truncate px-2 py-1 text-[13px] ${
                activeCategoryId === cat.id ? "bg-gray-100 font-bold text-gray-900" : "text-gray-700 hover:bg-gray-50"
              }`}
              title={cat.name}
            >
              {cat.name}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
