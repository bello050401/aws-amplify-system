"use client";

import Link from "next/link";
import type { MasterOption } from "@/lib/inventory/queries";
import { useUnsavedChanges } from "../UnsavedChangesProvider";

interface CategoryFilterListProps {
  categories: MasterOption[];
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
 * カテゴリの複数選択ORフィルタ (統合改善指示書 §9)。「カテゴリを検索」
 * inputは廃止 — カテゴリ数が絞り込みを要するほど多い場合は将来的な課
 * 題とし、今回は単純な複数選択チェックボックスリストのみ。
 *
 * 各行はチェックボックスの見た目を持つ<Link>（実際にトグルするのは
 * href — クリックでこのカテゴリをactiveCategoryIdsへ追加/削除した新
 * しいURLへ遷移する、既存の「フィルタ行＝Link」パターンをそのまま踏
 * 襲）。実際の絞り込みはサーバー側(lib/inventory/queries.ts)のOR条件
 * で行われ、ここは見た目のトグルではない。
 */
export function CategoryFilterList({ categories, activeCategoryIds, activeLocationId, q }: CategoryFilterListProps) {
  const { isDirty, guardedNavigate } = useUnsavedChanges();

  function toggledIds(id: string): string[] {
    return activeCategoryIds.includes(id) ? activeCategoryIds.filter((x) => x !== id) : [...activeCategoryIds, id];
  }

  function handleClick(e: React.MouseEvent, href: string) {
    if (!isDirty) return;
    e.preventDefault();
    guardedNavigate(href);
  }

  const clearHref = buildHref({ q, categoryIds: [], locationId: activeLocationId });

  return (
    <div>
      {categories.length === 0 && <p className="px-2 py-1 text-[12px] text-gray-300">未登録</p>}
      <ul>
        {categories.map((cat) => {
          const checked = activeCategoryIds.includes(cat.id);
          const href = buildHref({ q, categoryIds: toggledIds(cat.id), locationId: activeLocationId });
          return (
            <li key={cat.id}>
              <Link
                href={href}
                onClick={(e) => handleClick(e, href)}
                className={`flex items-center gap-1.5 truncate px-2 py-1 text-[13px] ${
                  checked ? "bg-gray-100 font-bold text-gray-900" : "text-gray-700 hover:bg-gray-50"
                }`}
                title={cat.name}
              >
                <input type="checkbox" checked={checked} readOnly tabIndex={-1} className="pointer-events-none h-3 w-3 shrink-0" />
                <span className="truncate">{cat.name}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      {activeCategoryIds.length > 0 && (
        <Link href={clearHref} onClick={(e) => handleClick(e, clearHref)} className="mt-1 block px-2 py-1 text-[11px] text-gray-400 hover:text-gray-700">
          すべて解除
        </Link>
      )}
    </div>
  );
}
