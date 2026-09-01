"use client";

import Link from "next/link";
import { useUnsavedChanges } from "../UnsavedChangesProvider";

interface InventoryPaginationProps {
  baseParams: Record<string, string | undefined>;
  limit: number;
  currentCount: number;
  offset: number;
  /**
   * 総件数。null = まだ集計していない（行の表示は件数を待たない）。
   * 「次へ」の可否はtotalではなくhasNextで判断する —— nextTokenの有無から
   * 分かるので、全件を数えなくても正しく出せる。
   */
  total: number | null;
  hasNext: boolean;
}

function hrefFor(baseParams: Record<string, string | undefined>, extra: Record<string, string | undefined>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...baseParams, ...extra })) {
    if (v) sp.set(k, v);
  }
  const qs = sp.toString();
  return qs ? `/inventory?${qs}` : "/inventory";
}

function PageSizeLinks({ baseParams, limit, extraReset }: { baseParams: Record<string, string | undefined>; limit: number; extraReset: Record<string, string | undefined> }) {
  const { isDirty, guardedNavigate } = useUnsavedChanges();
  function handleClick(e: React.MouseEvent, href: string) {
    if (!isDirty) return;
    e.preventDefault();
    guardedNavigate(href);
  }
  return (
    <div className="flex items-center gap-1">
      <span>表示件数:</span>
      {[50, 100].map((n) => {
        const href = hrefFor(baseParams, { limit: String(n), ...extraReset });
        return (
          <Link
            key={n}
            href={href}
            onClick={(e) => handleClick(e, href)}
            className={`border px-2 py-0.5 ${limit === n ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300 hover:bg-gray-50"}`}
          >
            {n}
          </Link>
        );
      })}
    </div>
  );
}

/**
 * Offset-based pagination — used by every list path (通常一覧/クイック
 * 検索/詳細検索すべて、lib/inventory/queries.tsのlistInventory/
 * listInventorySimpleSearch/listInventoryAdvancedが共通のfetchAllInventoryRecords
 * ベースの全件取得+updatedAt DESCソート+offsetページ分割を返す —
 * BELLO統合改修 master指示書(2026-08-29統合改修版) §8/§9)。
 *
 * この一本化以前は、通常一覧だけがAppSync cursor(nextToken)ベースの
 * 別実装だった。それには2つの実害があった: (1) ソート順を保証できな
 * かった、(2) 総件数を返せなかった(ページ内件数しか分からない)。
 * さらに「← 前へ」を再現するため訪れた全ページのnextTokenをURLへ蓄積
 * する実装が、実際に報告されたHTTP 431(Request Header Fields Too
 * Large)の直接の原因になっていた。offsetページングへ統一したことで、
 * 3つとも解消している — offsetは単なる数値なのでURLが肥大化しようが
 * ない。
 */
export function InventoryPagination({ baseParams, offset, total, limit, currentCount, hasNext }: InventoryPaginationProps) {
  const { isDirty, guardedNavigate } = useUnsavedChanges();
  const hasPrev = offset > 0;
  const rangeStart = currentCount === 0 ? 0 : offset + 1;
  const rangeEnd = offset + currentCount;

  function handleClick(e: React.MouseEvent, href: string) {
    if (!isDirty) return;
    e.preventDefault();
    guardedNavigate(href);
  }

  return (
    <div className="flex items-center justify-between border-t border-gray-200 px-3 py-1.5 text-[12px] text-gray-600">
      <span>
        {total === null ? "" : `${total.toLocaleString("ja-JP")}件中 `}
        {rangeStart.toLocaleString("ja-JP")}–{rangeEnd.toLocaleString("ja-JP")}件表示
      </span>
      <div className="flex items-center gap-3">
        {hasPrev ? (
          (() => {
            const href = hrefFor(baseParams, { offset: String(Math.max(0, offset - limit)) });
            return (
              <Link href={href} onClick={(e) => handleClick(e, href)} className="border border-gray-300 px-2 py-1 hover:bg-gray-50">
                ← 前へ
              </Link>
            );
          })()
        ) : (
          <span className="border border-gray-100 px-2 py-1 text-gray-300">← 前へ</span>
        )}
        {hasNext ? (
          (() => {
            const href = hrefFor(baseParams, { offset: String(offset + limit) });
            return (
              <Link href={href} onClick={(e) => handleClick(e, href)} className="border border-gray-300 px-2 py-1 hover:bg-gray-50">
                次へ →
              </Link>
            );
          })()
        ) : (
          <span className="border border-gray-100 px-2 py-1 text-gray-300">次へ →</span>
        )}
      </div>
      <PageSizeLinks baseParams={baseParams} limit={limit} extraReset={{ offset: undefined }} />
    </div>
  );
}
