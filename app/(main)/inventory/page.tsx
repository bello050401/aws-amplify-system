"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { MobileHeader } from "@/components/layout/MobileHeader";
import { InventoryListItem } from "@/components/inventory/InventoryListItem";
import { PickerSheet } from "@/components/common/PickerSheet";
import { SkeletonRow } from "@/components/common/LoadingOverlay";
import { EmptyState } from "@/components/common/EmptyState";
import { ErrorState, toErrorMessage } from "@/components/common/ErrorState";
import { SearchIcon } from "@/components/icons";
import { useMasterData } from "@/lib/hooks/useMasterData";
import { useSearchState } from "@/lib/hooks/useSearchState";
import { getInventoryService } from "@/lib/api";
import type { Item } from "@/lib/types";
import { formatQuantity } from "@/lib/utils/format";

const PAGE_SIZE = 20;

const SORT_OPTIONS = [
  { id: "updatedAt:desc", label: "更新日が新しい順", field: "updatedAt", direction: "desc" as const },
  { id: "name:asc", label: "物品名(あいうえお順)", field: "name", direction: "asc" as const },
  { id: "quantity:desc", label: "数量が多い順", field: "quantity", direction: "desc" as const },
  { id: "quantity:asc", label: "数量が少ない順", field: "quantity", direction: "asc" as const },
];

/** 在庫一覧画面 (指示書 §6)。 */
export default function InventoryListPage() {
  const { state, update } = useSearchState();
  const { categories } = useMasterData();
  const [keyword, setKeyword] = useState(state.keyword);
  const [items, setItems] = useState<Item[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalQuantity, setTotalQuantity] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [categorySheetOpen, setCategorySheetOpen] = useState(false);
  const [sortSheetOpen, setSortSheetOpen] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const activeCategory = categories.find((c) => c.id === state.categoryId);
  const activeSort = SORT_OPTIONS.find(
    (s) => s.field === state.sort?.field && s.direction === state.sort?.direction
  ) ?? SORT_OPTIONS[0];

  const searchParams = useMemo(
    () => ({
      keyword: state.keyword,
      categoryId: state.categoryId ?? undefined,
      advanced: state.advanced ?? undefined,
      sort: state.sort ?? undefined,
    }),
    [state.keyword, state.categoryId, state.advanced, state.sort]
  );

  const loadPage = useCallback(
    async (targetPage: number, replace: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const result = await getInventoryService().searchItems({
          ...searchParams,
          page: targetPage,
          pageSize: PAGE_SIZE,
        });
        setItems((prev) => (replace ? result.items : [...prev, ...result.items]));
        setTotalCount(result.totalCount);
        setTotalQuantity(result.totalQuantity);
        setHasMore(!!result.nextToken);
        setPage(targetPage);
      } catch (e) {
        setError(toErrorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [searchParams]
  );

  useEffect(() => {
    loadPage(1, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Infinite Scroll(指示書 §6-5: 5,000件以上でも実用的な性能を確保)
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading) {
          loadPage(page + 1, false);
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loading, page, loadPage]);

  function handleKeywordSubmit(e: React.FormEvent) {
    e.preventDefault();
    update({ keyword });
  }

  return (
    <div className="min-h-screen">
      <MobileHeader
        title="在庫一覧"
        hideBack
        right={
          <button onClick={() => setSortSheetOpen(true)} className="tap-target text-xs font-semibold text-bello-700">
            並替
          </button>
        }
      />

      <div className="space-y-3 px-4 py-3 md:px-0">
        <form onSubmit={handleKeywordSubmit} className="flex items-center gap-2 rounded-full border border-bello-200 bg-white px-4 py-3 shadow-card">
          <SearchIcon className="h-5 w-5 shrink-0 text-bello-300" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onBlur={() => update({ keyword })}
            placeholder="何をお探しですか?"
            className="w-full bg-transparent text-base outline-none"
          />
        </form>

        <div className="flex gap-2">
          <button
            onClick={() => setCategorySheetOpen(true)}
            className="tap-target flex-1 truncate rounded-full border border-bello-200 bg-white px-4 py-2 text-sm text-bello-700"
          >
            {activeCategory ? activeCategory.name : "カテゴリ"}
          </button>
          <Link
            href="/search/advanced"
            className={`tap-target flex-1 truncate rounded-full border px-4 py-2 text-center text-sm ${
              state.advanced && state.advanced.conditions.length > 0
                ? "border-bello-700 bg-bello-700 text-white"
                : "border-bello-200 bg-white text-bello-700"
            }`}
          >
            詳細検索{state.advanced?.conditions.length ? ` (${state.advanced.conditions.length})` : ""}
          </Link>
        </div>

        <div className="flex items-center justify-between text-sm text-bello-500">
          <span>
            {formatQuantity(totalCount)}件　合計{formatQuantity(totalQuantity)}
          </span>
          <span className="text-xs">{activeSort.label}</span>
        </div>
      </div>

      <div className="space-y-2 px-4 pb-24 md:px-0">
        {error && <ErrorState message={error} onRetry={() => loadPage(1, true)} />}
        {!error && items.length === 0 && !loading && (
          <EmptyState title="該当する在庫が見つかりません" description="検索条件を変更するか、新規登録してください。" />
        )}
        {items.map((item) => (
          <InventoryListItem key={item.id} item={item} />
        ))}
        {loading && Array.from({ length: 4 }).map((_, i) => <SkeletonRow key={i} />)}
        <div ref={sentinelRef} className="h-1" />
      </div>

      {categorySheetOpen && (
        <PickerSheet
          title="カテゴリを選択"
          options={categories.map((c) => ({ id: c.id, label: c.name }))}
          selectedId={state.categoryId}
          onSelect={(id) => {
            update({ categoryId: id });
            setCategorySheetOpen(false);
          }}
          onClose={() => setCategorySheetOpen(false)}
        />
      )}

      {sortSheetOpen && (
        <PickerSheet
          title="並び替え"
          options={SORT_OPTIONS.map((s) => ({ id: s.id, label: s.label }))}
          selectedId={activeSort.id}
          onSelect={(id) => {
            const opt = SORT_OPTIONS.find((s) => s.id === id);
            if (opt) update({ sort: { field: opt.field, direction: opt.direction } });
            setSortSheetOpen(false);
          }}
          onClose={() => setSortSheetOpen(false)}
        />
      )}
    </div>
  );
}
