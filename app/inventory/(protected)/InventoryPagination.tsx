import Link from "next/link";

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
 * Cursor-based (AppSync nextToken), not numbered-page pagination — spec
 * §27 asks for page numbers, but also explicitly rules out fetching every
 * Inventory row and paginating client-side (the only way to know how many
 * numbered pages exist without scanning the whole table up front). A
 * DynamoDB-backed list has no "page 6" concept without that scan, so this
 * keeps 前へ/次へ + a page-size selector and drops jump-to-page-N. See
 * queries.ts's listInventory for where this contract is produced.
 */
export function InventoryPagination({ baseParams, cursor, cursorStack, nextToken, limit, currentCount }: InventoryPaginationProps) {
  const hasPrev = cursorStack.length > 0;
  const prevStack = cursorStack.slice(0, -1);
  const prevCursor = cursorStack[cursorStack.length - 1] ?? "";

  const nextStack = [...cursorStack, cursor ?? ""].join(",");

  return (
    <div className="flex items-center justify-between border-t border-gray-200 px-3 py-1.5 text-[12px] text-gray-600">
      <span>{currentCount}件表示</span>
      <div className="flex items-center gap-3">
        {hasPrev ? (
          <Link
            href={hrefFor(baseParams, { cursor: prevCursor || undefined, stack: prevStack.join(",") || undefined })}
            className="border border-gray-300 px-2 py-1 hover:bg-gray-50"
          >
            ← 前へ
          </Link>
        ) : (
          <span className="border border-gray-100 px-2 py-1 text-gray-300">← 前へ</span>
        )}
        {nextToken ? (
          <Link
            href={hrefFor(baseParams, { cursor: nextToken, stack: nextStack })}
            className="border border-gray-300 px-2 py-1 hover:bg-gray-50"
          >
            次へ →
          </Link>
        ) : (
          <span className="border border-gray-100 px-2 py-1 text-gray-300">次へ →</span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <span>表示件数:</span>
        {[50, 100].map((n) => (
          <Link
            key={n}
            href={hrefFor(baseParams, { limit: String(n), cursor: undefined, stack: undefined })}
            className={`border px-2 py-0.5 ${limit === n ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300 hover:bg-gray-50"}`}
          >
            {n}
          </Link>
        ))}
      </div>
    </div>
  );
}
