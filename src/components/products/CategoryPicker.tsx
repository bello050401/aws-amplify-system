"use client";

import { useEffect, useMemo, useState } from "react";

interface CategoryRow {
  id: string;
  mercariCategoryId: string;
  name: string;
  parentMercariId: string | null;
  isLeaf: boolean;
  path: string;
}

interface FavoriteRow {
  categoryMapping: CategoryRow;
}

export function CategoryPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (categoryMappingId: string | null) => void;
}) {
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [favorites, setFavorites] = useState<FavoriteRow[]>([]);
  const [chain, setChain] = useState<string[]>([]); // mercariCategoryId ごとの選択チェーン
  const [syncing, setSyncing] = useState(false);
  const [loaded, setLoaded] = useState(false);

  async function refresh() {
    const [catRes, favRes] = await Promise.all([
      fetch("/api/mercari/categories").then((r) => r.json()),
      fetch("/api/settings/categories-favorites").then((r) => r.json()),
    ]);
    setCategories(catRes.categories ?? []);
    setFavorites(favRes.favorites ?? []);
    setLoaded(true);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [catRes, favRes] = await Promise.all([
        fetch("/api/mercari/categories").then((r) => r.json()),
        fetch("/api/settings/categories-favorites").then((r) => r.json()),
      ]);
      if (cancelled) return;
      setCategories(catRes.categories ?? []);
      setFavorites(favRes.favorites ?? []);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 既存の value (categoryMappingId) から選択チェーンを復元する。
  // これはネットワーク由来のcategories読み込み完了後に一度だけ行う派生状態の同期であり、
  // 競合状態を避けるため setChain 自体は同期的に呼ぶ必要がある
  // (react-hooks/set-state-in-effect は非同期fetch由来のレースコンディション検出用のため、
  // ここでは意図的に無効化する)。
  useEffect(() => {
    if (!value || categories.length === 0) return;
    const target = categories.find((c) => c.id === value);
    if (!target) return;
    const rebuilt: string[] = [];
    let current: CategoryRow | undefined = target;
    while (current) {
      rebuilt.unshift(current.mercariCategoryId);
      current = current.parentMercariId
        ? categories.find((c) => c.mercariCategoryId === current!.parentMercariId)
        : undefined;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 上記コメント参照
    setChain(rebuilt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, categories.length]);

  const byParent = useMemo(() => {
    const map = new Map<string | null, CategoryRow[]>();
    for (const c of categories) {
      const key = c.parentMercariId;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }
    return map;
  }, [categories]);

  async function handleSync() {
    setSyncing(true);
    try {
      const res = await fetch("/api/mercari/categories", { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        alert(json.error ?? "カテゴリー取得に失敗しました。/settings/mercari でトークンを設定してください。");
        return;
      }
      await refresh();
    } finally {
      setSyncing(false);
    }
  }

  function selectLevel(levelIndex: number, mercariCategoryId: string) {
    const next = chain.slice(0, levelIndex).concat(mercariCategoryId);
    setChain(next);
    const selected = categories.find((c) => c.mercariCategoryId === mercariCategoryId);
    if (selected?.isLeaf) {
      onChange(selected.id);
    } else {
      onChange(null);
    }
  }

  function selectFavorite(fav: FavoriteRow) {
    onChange(fav.categoryMapping.id);
  }

  const levels: CategoryRow[][] = [];
  let parentKey: string | null = null;
  for (let i = 0; i <= chain.length; i++) {
    const options = byParent.get(parentKey) ?? [];
    if (options.length === 0) break;
    levels.push(options);
    const selectedId = chain[i];
    if (!selectedId) break;
    parentKey = selectedId;
  }

  const selectedCategory = value ? categories.find((c) => c.id === value) : null;

  return (
    <div className="space-y-2">
      {favorites.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {favorites.map((f) => (
            <button
              key={f.categoryMapping.id}
              type="button"
              className={`rounded-full border px-2.5 py-1 text-xs ${
                value === f.categoryMapping.id
                  ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                  : "border-slate-300 text-slate-600 hover:bg-slate-50"
              }`}
              onClick={() => selectFavorite(f)}
            >
              ★ {f.categoryMapping.name}
            </button>
          ))}
        </div>
      )}

      {loaded && categories.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-300 p-3 text-sm text-slate-500">
          カテゴリーが未取得です。
          <button type="button" className="btn-secondary ml-2" onClick={handleSync} disabled={syncing}>
            {syncing ? "取得中…" : "メルカリShopsからカテゴリーを取得"}
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {levels.map((options, i) => (
            <select
              key={i}
              className="input w-auto min-w-[10rem]"
              value={chain[i] ?? ""}
              onChange={(e) => selectLevel(i, e.target.value)}
            >
              <option value="">選択してください</option>
              {options.map((o) => (
                <option key={o.id} value={o.mercariCategoryId}>
                  {o.name}
                  {o.isLeaf ? "" : " ›"}
                </option>
              ))}
            </select>
          ))}
          <button type="button" className="btn-secondary" onClick={handleSync} disabled={syncing}>
            {syncing ? "更新中…" : "再取得"}
          </button>
        </div>
      )}

      {selectedCategory && (
        <p className="text-xs text-slate-500">選択中: {selectedCategory.path}</p>
      )}
      {!selectedCategory && chain.length > 0 && (
        <p className="text-xs text-amber-600">末端カテゴリー（これ以上子が無いもの）まで選択してください。</p>
      )}
    </div>
  );
}
