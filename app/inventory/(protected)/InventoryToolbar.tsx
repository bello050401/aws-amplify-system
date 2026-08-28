"use client";

import { useState } from "react";
import Link from "next/link";
import type { InventoryRole } from "@/lib/amplify/requireInventoryUser";
import { useUnsavedChanges } from "../UnsavedChangesProvider";
import { DirectEditControls } from "./DirectEditControls";
import { ExportMenu } from "./ExportMenu";
import { ImportWizard } from "./ImportWizard";

interface InventoryToolbarProps {
  role: InventoryRole;
  q?: string;
  categoryIds: string[];
  locationId?: string;
  statusId?: string;
  advancedOpen: boolean;
  totalLabel: string;
}

/**
 * List-page controls, rendered as InventoryHeader's `center` content
 * (see that component's file comment) — this component supplies three
 * visually distinct roles within that one row (統合改善指示書 §3-§5):
 * 1. ページタイトル「在庫一覧」+ 件数バッジ — a clear page-title
 *    hierarchy (larger/bolder than everything beside it), not just text
 *    sitting next to a search box.
 * 2. 商品検索 — one bordered "search tool" group (icon + input + a
 *    tight-coupled 詳細検索 toggle), not a bare unlabeled `<input>`.
 * 3. 主要操作（新規登録/直接編集/インポート/エクスポート） — kept
 *    visually separate from both of the above via spacing/a divider.
 *
 * A Client Component (rather than the plain server component this used
 * to be) because 商品検索/詳細検索/新規登録 now all need to go through
 * the shared 未保存変更ガード when 一覧直接編集 has dirty rows pending
 * (統合改善指示書 §13) — see each one's onClick/onSubmit below. When
 * nothing is dirty these are functionally identical to a plain
 * Link/native form GET submit; guardedNavigate degrades to a plain
 * `router.push` in that case (see UnsavedChangesProvider).
 */
export function InventoryToolbar({ role, q, categoryIds, locationId, statusId, advancedOpen, totalLabel }: InventoryToolbarProps) {
  const canEdit = role === "ADMIN" || role === "EDITOR";
  const { isDirty, guardedNavigate } = useUnsavedChanges();
  const [importOpen, setImportOpen] = useState(false);

  function buildHref(overrides: Partial<{ q: string; advanced: string }> = {}) {
    const sp = new URLSearchParams();
    const nextQ = overrides.q ?? q;
    if (nextQ) sp.set("q", nextQ);
    if (categoryIds.length > 0) sp.set("categoryIds", categoryIds.join(","));
    if (locationId) sp.set("locationId", locationId);
    if (statusId) sp.set("statusId", statusId);
    if (overrides.advanced) sp.set("advanced", overrides.advanced);
    const qs = sp.toString();
    return qs ? `/inventory?${qs}` : "/inventory";
  }

  const advancedHref = buildHref({ advanced: advancedOpen ? undefined : "1" });

  function handleGuardedLinkClick(e: React.MouseEvent, href: string) {
    if (!isDirty) return; // let the plain <Link> navigate normally
    e.preventDefault();
    guardedNavigate(href);
  }

  function handleSearchSubmit(e: React.FormEvent<HTMLFormElement>) {
    if (!isDirty) return; // let the native GET form submission proceed normally
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const sp = new URLSearchParams();
    for (const [key, value] of fd.entries()) {
      if (typeof value === "string" && value) sp.set(key, value);
    }
    const qs = sp.toString();
    guardedNavigate(qs ? `/inventory?${qs}` : "/inventory");
  }

  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-4">
        {/* 1. ページタイトル — 「在庫一覧＋件数」を薄いborderで囲み、1つ
            のタイトル領域として認識できるようにする。カードUI(角丸・
            shadow・塗りつぶし背景)にはせず、細い罫線1本だけで区切る
            (統合改善指示書 §1: 過度なカードUIにしない)。 */}
        <div className="flex items-center gap-2 border border-gray-200 px-2.5 py-1">
          <h1 className="text-[15px] font-bold tracking-tight text-gray-900">在庫一覧</h1>
          <span className="text-[11px] font-medium text-gray-400">{totalLabel}</span>
        </div>

        <div className="h-6 w-px bg-gray-200" aria-hidden />

        {/* 2. 商品検索 — アイコン+input+詳細検索を1つの検索ツールとして
            まとめる。検索対象・ロジックは既存のまま(name/skuのcontains)
            — 「SKU」という言葉自体をUI上に出さないだけで、SKUでの検索
            は引き続き内部的に機能する(統合改善指示書 §2)。 */}
        <div className="flex items-center gap-1.5">
          <form action="/inventory" method="get" onSubmit={handleSearchSubmit} className="flex items-center border border-gray-300 bg-white focus-within:border-gray-500 focus-within:ring-1 focus-within:ring-gray-300">
            {categoryIds.length > 0 && <input type="hidden" name="categoryIds" value={categoryIds.join(",")} />}
            {locationId && <input type="hidden" name="locationId" value={locationId} />}
            {statusId && <input type="hidden" name="statusId" value={statusId} />}
            <svg viewBox="0 0 16 16" aria-hidden className="ml-1.5 h-3.5 w-3.5 shrink-0 text-gray-400">
              <path
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                d="M11 11 L14.5 14.5 M12 7 A5 5 0 1 1 2 7 A5 5 0 0 1 12 7 Z"
              />
            </svg>
            <label className="sr-only" htmlFor="inventory-search-q">
              商品検索
            </label>
            <input
              id="inventory-search-q"
              type="text"
              name="q"
              defaultValue={q}
              placeholder="商品を検索"
              className="w-48 border-none px-1.5 py-1 text-[13px] outline-none placeholder:text-gray-400"
            />
          </form>
          <Link
            href={advancedHref}
            onClick={(e) => handleGuardedLinkClick(e, advancedHref)}
            className={`border px-2 py-1 text-[12px] ${advancedOpen ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}
          >
            詳細検索
          </Link>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {/* 3. 主要操作 — 検索グループとは間隔で分ける。 */}
        {canEdit ? (
          <>
            <Link
              href="/inventory/new"
              onClick={(e) => handleGuardedLinkClick(e, "/inventory/new")}
              className="bg-gray-900 px-3 py-1.5 text-[13px] font-bold text-white hover:bg-gray-800"
            >
              + 新規登録
            </Link>
            <DirectEditControls />
          </>
        ) : null}
        {/* インポートはADMIN/EDITORのみ(spec §16: VIEWERは不可・ボタン
            非表示)。エクスポートは既存の閲覧権限モデルに合わせ、
            VIEWERも含め全ロールが利用可能(ExportMenu参照)。 */}
        {canEdit && (
          <button type="button" onClick={() => setImportOpen(true)} className="border border-gray-300 px-2 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50">
            インポート
          </button>
        )}
        <ExportMenu currentFilterParams={{ q, categoryIds: categoryIds.length > 0 ? categoryIds.join(",") : undefined, locationId, statusId }} />
      </div>
      {importOpen && <ImportWizard onClose={() => setImportOpen(false)} />}
    </div>
  );
}
