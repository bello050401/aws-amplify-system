"use client";

import Link from "next/link";
import { useUnsavedChanges } from "../UnsavedChangesProvider";

interface CommonProps {
  baseParams: Record<string, string | undefined>;
  limit: number;
  currentCount: number;
}

interface CursorPaginationProps extends CommonProps {
  mode: "cursor";
  /** Present iff this isn't the first page — the AppSync nextToken used to fetch it. */
  cursor?: string;
  nextToken: string | null;
}

interface OffsetPaginationProps extends CommonProps {
  mode: "offset";
  offset: number;
  total: number;
}

type InventoryPaginationProps = CursorPaginationProps | OffsetPaginationProps;

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
 * Cursor-based (AppSync nextToken) pagination — a DynamoDB-backed native
 * list has no "page 6" concept without scanning the whole table up
 * front, so this keeps 前へ/次へ + a page-size selector and drops
 * jump-to-page-N. Used only for the plain browse path (no free-text
 * search, no 詳細検索) — see lib/inventory/queries.ts's listInventory.
 *
 * BELLO統合改修 master指示書(2026-08-29統合改修版) §7根本修正:
 * これ以前は「← 前へ」を再現するため、これまで訪れた全ページの
 * nextTokenを`stack` URLクエリパラメータへカンマ区切りで蓄積していた
 * (page.tsxのsearchParams.stack)。AppSyncのnextTokenは(特にfilter付き
 * のExclusiveStartKeyを含むと)不透明かつ数百バイト〜1KB超になり得る
 * ため、「次へ」を数回押すだけでURL(すなわちリクエストラインそのもの
 * — Cookieとは別にHTTPリクエストヘッダ全体のサイズに数えられる)が
 * 際限なく肥大化し、実際に報告された`HTTP ERROR 431`(Request Header
 * Fields Too Large)を引き起こしていた — これが根本原因。
 *
 * 修正: 「次へ」のURLはそのページ1件分のnextTokenだけを常に運ぶ
 * (蓄積しない、O(1)のURLサイズ)。「← 前へ」は`router.back()`(ブラウザ
 * の実際のナビゲーション履歴)へ切り替え — これによりサーバー側で
 * 「前ページのcursorが何か」を再現する必要が無くなり、URL肥大化の根本
 * 原因そのものが消える。制約: 直接このURLを開いた(共有リンク等)場合
 * router.back()はアプリ内履歴の外へ戻る可能性があるが、これは内部業務
 * ツールとして許容範囲内のトレードオフであり、少なくとも431で完全に
 * 操作不能になる現状よりは明確に改善である。
 */
function CursorPagination({ baseParams, cursor, nextToken, limit, currentCount }: CursorPaginationProps) {
  const { isDirty, guardedNavigate, guardedBack } = useUnsavedChanges();
  const hasPrev = Boolean(cursor); // このページ自体がcursorで到達されたなら、前のページが存在する

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
          <button type="button" onClick={guardedBack} className="border border-gray-300 px-2 py-1 hover:bg-gray-50">
            ← 前へ
          </button>
        ) : (
          <span className="border border-gray-100 px-2 py-1 text-gray-300">← 前へ</span>
        )}
        {nextToken ? (
          (() => {
            const href = hrefFor(baseParams, { cursor: nextToken });
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
      <PageSizeLinks baseParams={baseParams} limit={limit} extraReset={{ cursor: undefined }} />
    </div>
  );
}

/**
 * Offset-based pagination — used by the search paths (クイック検索/
 * 詳細検索, lib/inventory/queries.tsのlistInventorySimpleSearch /
 * listInventoryAdvanced), which already compute the full filtered result
 * array server-side (case-insensitive text matching can't be pushed down
 * to DynamoDB — see advancedSearch.tsのファイルコメント), so a plain
 * numeric offset is both simpler and gives the total count that cursor
 * pagination never could.
 */
function OffsetPagination({ baseParams, offset, total, limit, currentCount }: OffsetPaginationProps) {
  const { isDirty, guardedNavigate } = useUnsavedChanges();
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = offset + currentCount;

  function handleClick(e: React.MouseEvent, href: string) {
    if (!isDirty) return;
    e.preventDefault();
    guardedNavigate(href);
  }

  return (
    <div className="flex items-center justify-between border-t border-gray-200 px-3 py-1.5 text-[12px] text-gray-600">
      <span>
        {total.toLocaleString("ja-JP")}件中 {rangeStart.toLocaleString("ja-JP")}–{rangeEnd.toLocaleString("ja-JP")}件表示
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

/**
 * A Client Component so page moves also go through the shared 未保存変
 * 更ガード when 一覧直接編集 has dirty rows pending (統合改善指示書
 * §13: ページ移動)。`mode`で内部実装をcursor/offsetの2通りへ振り分け
 * るだけの薄いラッパー — 呼び出し側(page.tsx)はlib/inventory/queries.ts
 * の返り値の形(nextTokenありcursor / totalありoffset)にそのまま対応
 * させるだけでよい。
 */
export function InventoryPagination(props: InventoryPaginationProps) {
  if (props.mode === "offset") return <OffsetPagination {...props} />;
  return <CursorPagination {...props} />;
}
