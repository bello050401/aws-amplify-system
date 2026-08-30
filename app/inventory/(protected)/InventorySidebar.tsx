"use client";

import { useEffect, useState } from "react";
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

/** すべての在庫/保管場所/カテゴリの中身 — デスクトップの常設サイドバーとモバイルのボトムシートで全く同じものを表示する。 */
function FilterContent({ categories, locations, activeCategoryIds, activeLocationId, q, onNavigate }: InventorySidebarProps & { onNavigate?: () => void }) {
  const isAll = activeCategoryIds.length === 0 && !activeLocationId;
  const { isDirty, guardedNavigate } = useUnsavedChanges();

  function handleClick(e: React.MouseEvent, href: string) {
    onNavigate?.();
    if (!isDirty) return;
    e.preventDefault();
    guardedNavigate(href);
  }

  return (
    <>
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
    </>
  );
}

/**
 * BELLO統合業務OS指示書(2026-08-30) §70/§73/§122: モバイル幅
 * (`md`未満)では常設サイドバー(第2層)を残さず、代わりに「フィルター」
 * トリガーボタン+ボトムシートに変える。中身(FilterContent)は
 * デスクトップ版と完全に同じもの — 見た目の入れ物だけを変える。
 *
 * シートを開いたままフィルタを選ぶと(=Linkでページ遷移すると)自動で
 * 閉じる: activeCategoryIds/activeLocationId/qはサーバー側から新しい
 * props として渡し直されるので、それらが変わったタイミングで
 * useEffectがsheetOpenをfalseに戻す(CategoryFilterList側のLinkの
 * onClickを個別に触る必要がない、既存コードへの変更を最小にするための
 * 設計)。
 */
export function InventorySidebar(props: InventorySidebarProps) {
  const { categories, locations, activeCategoryIds, activeLocationId, q } = props;
  const [sheetOpen, setSheetOpen] = useState(false);
  const filterKey = JSON.stringify({ activeCategoryIds, activeLocationId, q });

  useEffect(() => {
    setSheetOpen(false);
  }, [filterKey]);

  const activeFilterCount = activeCategoryIds.length + (activeLocationId ? 1 : 0);

  return (
    <>
      {/* デスクトップ(第2層、常設)。 */}
      <aside className="hidden w-52 shrink-0 flex-col overflow-y-auto border-r border-gray-200 bg-white text-sm md:flex">
        <FilterContent {...props} />
      </aside>

      {/* モバイル: トリガーボタン。一覧本体の直前に横並びで置けるよう
          shrink-0の細いバーにする(InventoryToolbar側は変更しない)。 */}
      <div className="flex shrink-0 items-center border-b border-gray-200 bg-white px-3 py-2 md:hidden">
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className="flex items-center gap-1.5 border border-gray-300 px-3 py-1.5 text-[12px] text-gray-700"
        >
          フィルター
          {activeFilterCount > 0 && <span className="rounded-full bg-gray-900 px-1.5 py-0.5 text-[10px] font-bold text-white">{activeFilterCount}</span>}
        </button>
      </div>

      {/* モバイル: ボトムシート本体。sheetOpenがfalseの間はDOMごと
          `hidden`にする(display:none) — 開いていないシートの中の
          <Link>群がタブ移動可能領域に残ってアクセシビリティ上の
          トラップにならないようにするため(単にopacity-0で隠すのでは
          不十分)。 */}
      <div className={`fixed inset-0 z-50 md:hidden ${sheetOpen ? "" : "hidden"}`} role="dialog" aria-modal="true" aria-label="絞り込みフィルター">
        <div className="absolute inset-0 bg-black/30" onClick={() => setSheetOpen(false)} />
        <div className="absolute inset-x-0 bottom-0 max-h-[75vh] overflow-y-auto rounded-t-lg bg-white pb-[env(safe-area-inset-bottom)] shadow-lg">
          <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2">
            <p className="text-[13px] font-bold text-gray-900">絞り込み</p>
            <button type="button" onClick={() => setSheetOpen(false)} className="px-2 py-1 text-[12px] text-gray-500">
              閉じる
            </button>
          </div>
          <FilterContent categories={categories} locations={locations} activeCategoryIds={activeCategoryIds} activeLocationId={activeLocationId} q={q} />
        </div>
      </div>
    </>
  );
}
