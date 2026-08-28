"use client";

import Link from "next/link";
import { useUnsavedChanges } from "../UnsavedChangesProvider";

interface InventoryPaginationProps {
  baseParams: Record<string, string | undefined>;
  cursor?: string;
  cursorStack: string[]; // previous page cursors, most recent last; "" represents "first page (no cursor)"
  nextToken: string | null;
  limit: number;
  currentCount: number;
}

function hrefFor(baseParams: Record<string, string | undefined>, extra: Record<string, string | undefined>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...baseParams, ...extra })) {
    if (v) sp.set(k, v);
  }
  const qs = sp.toString();
  return qs ? `/inventory?${qs}` : "/inventory";
}

/**
 * Cursor-based (AppSync nextToken), not numbered-page pagination — a
 * DynamoDB-backed list has no "page 6" concept without scanning the
 * whole table up front, so this keeps 前へ/次へ + a page-size selector
 * and drops jump-to-page-N. See queries.ts's listInventory for where
 * this contract is produced.
 *
 * A Client Component (was a server component) so page moves also go
 * through the shared 未保存変更ガード when 一覧直接編集 has dirty rows
 * pending (統合改善指示書 §13: ページ移動).
 */
export function InventoryPagination({ baseParams, cursor, cursorStack, nextToken, limit, currentCount }: InventoryPaginationProps) {
  const { isDirty, guardedNavigate } = useUnsavedChanges();
  const hasPrev = cursorStack.length > 0;
  const prevStack = cursorStack.slice(0, -1);
  const prevCursor = cursorStack[cursorStack.length - 1] ?? "";

  const nextStack = [...cursorStack, cursor ?? ""].join(",");

  function handleClick(e: React.MouseEvent, href: string) {
    if (!isDirty) return;
    e.preventDefault();
    guardedNavigate(href);
  }

  return (
    <div className="flex items-center justify-between border-t border-gray-200 px-3 py-1.5 text-[12px] text-gray-600">
      <span>{currentCount}件表示</span>
      <div className="flex items-center gap-3">
        {hasPrev ? (
          (() => {
            const href = hrefFor(baseParams, { cursor: prevCursor || undefined, stack: prevStack.join(",") || undefined });
            return (
              <Link href={href} onClick={(e) => handleClick(e, href)} className="border border-gray-300 px-2 py-1 hover:bg-gray-50">
                ← 前へ
              </Link>
            );
          })()
        ) : (
          <span className="border border-gray-100 px-2 py-1 text-gray-300">← 前へ</span>
        )}
        {nextToken ? (
          (() => {
            const href = hrefFor(baseParams, { cursor: nextToken, stack: nextStack });
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
      <div className="flex items-center gap-1">
        <span>表示件数:</span>
        {[50, 100].map((n) => {
          const href = hrefFor(baseParams, { limit: String(n), cursor: undefined, stack: undefined });
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
    </div>
  );
}
