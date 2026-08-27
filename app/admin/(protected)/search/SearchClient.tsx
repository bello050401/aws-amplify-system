"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Image from "next/image";
import type { BaseItem } from "@/lib/base";
import { resolveBaseItemsFromUrls, searchBaseItems } from "@/app/actions/base";
import { generateFeature } from "@/app/actions/features";

const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" });

export function SearchClient() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BaseItem[]>([]);
  const [manuallyAdded, setManuallyAdded] = useState<BaseItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searching, setSearching] = useState(false);
  const [urlText, setUrlText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isGenerating, startGenerate] = useTransition();

  // Debounced search-as-you-type.
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const items = await searchBaseItems(query);
        setResults(items);
        setError(null);
      } catch (err) {
        // Surfaces the real reason (e.g. "BASEに接続されていません…", or the
        // actual BASE API error) instead of a generic message that hides
        // it — the server-side cause is also logged in the `npm run dev`
        // terminal by searchBaseItems() itself.
        setError(err instanceof Error ? err.message : "検索に失敗しました。時間をおいて再度お試しください。");
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [query]);

  const itemsById = useMemo(() => {
    const map = new Map<string, BaseItem>();
    for (const item of [...results, ...manuallyAdded]) map.set(item.itemId, item);
    return map;
  }, [results, manuallyAdded]);

  const visibleItems = useMemo(() => {
    // Manually-added items always show, even outside the current search.
    const seen = new Set(results.map((i) => i.itemId));
    return [...results, ...manuallyAdded.filter((i) => !seen.has(i.itemId))];
  }, [results, manuallyAdded]);

  function toggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllVisible() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const item of visibleItems) next.add(item.itemId);
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  async function handleAddUrls() {
    let items: BaseItem[];
    try {
      items = await resolveBaseItemsFromUrls(urlText);
    } catch (err) {
      setError(err instanceof Error ? err.message : "商品の取得に失敗しました。");
      return;
    }
    if (items.length === 0) {
      setError("有効な商品URLが見つかりませんでした。");
      return;
    }
    setManuallyAdded((prev) => {
      const seen = new Set(prev.map((i) => i.itemId));
      return [...prev, ...items.filter((i) => !seen.has(i.itemId))];
    });
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const item of items) next.add(item.itemId);
      return next;
    });
    setUrlText("");
    setError(null);
  }

  function handleGenerate() {
    const ids = Array.from(selectedIds);
    startGenerate(async () => {
      try {
        await generateFeature(ids);
      } catch (err) {
        setError(err instanceof Error ? err.message : "特集の生成に失敗しました。");
      }
    });
  }

  return (
    <div className="pb-28">
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="例: Softshell / vitra / Cassina / CAB / HAY / USM / Artek"
          className="w-full max-w-md border border-line px-4 py-2 text-sm focus:border-ink focus:outline-none"
        />
        {searching && <span className="text-xs text-muted">検索中…</span>}
      </div>

      <details className="mt-4 text-sm">
        <summary className="cursor-pointer text-xs uppercase tracking-label text-muted">
          商品URLから追加する(補助機能)
        </summary>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <textarea
            value={urlText}
            onChange={(e) => setUrlText(e.target.value)}
            placeholder={"https://bellointeri.base.shop/items/123456789\n(複数行貼り付け可)"}
            rows={3}
            className="w-full max-w-md border border-line px-3 py-2 text-sm focus:border-ink focus:outline-none"
          />
          <button
            onClick={handleAddUrls}
            className="self-start border border-ink px-4 py-2 text-xs uppercase tracking-label text-ink hover:bg-ink hover:text-white"
          >
            追加
          </button>
        </div>
      </details>

      {error && <p className="mt-4 text-xs text-red-600">{error}</p>}

      {visibleItems.length > 0 && (
        <div className="mt-8 flex items-center gap-4 text-xs uppercase tracking-label text-muted">
          <button onClick={selectAllVisible} className="underline hover:text-ink">
            全選択
          </button>
          <button onClick={clearSelection} className="underline hover:text-ink">
            選択解除
          </button>
          <span>{selectedIds.size}商品選択中</span>
        </div>
      )}

      <div className="mt-6 grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
        {visibleItems.map((item) => {
          const checked = selectedIds.has(item.itemId);
          return (
            <button
              key={item.itemId}
              onClick={() => toggle(item.itemId)}
              className={`block text-left ${checked ? "" : "opacity-90"}`}
            >
              <div
                className={`relative aspect-square overflow-hidden bg-stone ring-2 ${
                  checked ? "ring-ink" : "ring-transparent"
                }`}
              >
                {item.images[0] && (
                  <Image
                    src={item.images[0].url}
                    alt={item.title}
                    fill
                    sizes="(min-width: 1024px) 20vw, 45vw"
                    className="object-cover"
                  />
                )}
                <span
                  className={`absolute right-2 top-2 flex h-6 w-6 items-center justify-center border text-xs ${
                    checked ? "border-ink bg-ink text-white" : "border-line bg-white text-transparent"
                  }`}
                >
                  ✓
                </span>
                {!item.isPublished && (
                  <span className="absolute left-2 top-2 bg-white px-2 py-0.5 text-[10px] uppercase tracking-label text-muted">
                    非公開
                  </span>
                )}
              </div>
              <p className="mt-2 line-clamp-2 text-xs text-ink">{item.title}</p>
              <p className="text-xs font-light text-muted">{yen.format(item.price)}</p>
              <p className="text-xs text-muted">在庫{item.stock}</p>
            </button>
          );
        })}
      </div>

      {itemsById.size > 0 && selectedIds.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 border-t border-line bg-white/95 px-6 py-4 backdrop-blur">
          <div className="mx-auto flex max-w-content items-center justify-between">
            <span className="text-sm text-ink">{selectedIds.size}商品選択中</span>
            <button
              onClick={handleGenerate}
              disabled={isGenerating}
              className="bg-ink px-6 py-3 text-xs uppercase tracking-label text-white disabled:opacity-50"
            >
              {isGenerating ? "生成中…" : `選択した${selectedIds.size}商品で特集を生成`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
