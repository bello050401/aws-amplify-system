"use client";

import { useEffect, useState } from "react";

interface CategoryRow {
  id: string;
  name: string;
  isLeaf: boolean;
  path: string;
}

interface FavoriteRow {
  categoryMapping: CategoryRow;
}

export default function CategoryFavoritesPage() {
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [favorites, setFavorites] = useState<FavoriteRow[]>([]);
  const [query, setQuery] = useState("");
  const [syncing, setSyncing] = useState(false);

  async function refresh() {
    const [catRes, favRes] = await Promise.all([
      fetch("/api/mercari/categories").then((r) => r.json()),
      fetch("/api/settings/categories-favorites").then((r) => r.json()),
    ]);
    setCategories(catRes.categories ?? []);
    setFavorites(favRes.favorites ?? []);
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
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSync() {
    setSyncing(true);
    try {
      const res = await fetch("/api/mercari/categories", { method: "POST" });
      if (!res.ok) {
        const json = await res.json();
        alert(json.error ?? "カテゴリー取得に失敗しました。/settings/mercari でトークンを設定してください。");
        return;
      }
      await refresh();
    } finally {
      setSyncing(false);
    }
  }

  async function addFavorite(categoryMappingId: string) {
    await fetch("/api/settings/categories-favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ categoryMappingId }),
    });
    await refresh();
  }

  async function removeFavorite(categoryMappingId: string) {
    await fetch("/api/settings/categories-favorites", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ categoryMappingId }),
    });
    await refresh();
  }

  const favoriteIds = new Set(favorites.map((f) => f.categoryMapping.id));
  const leafCategories = categories.filter(
    (c) => c.isLeaf && (query === "" || c.name.includes(query) || c.path.includes(query)),
  );

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold">カテゴリーお気に入り</h1>
      <p className="text-sm text-slate-500">
        よく使うカテゴリー（例: ダイニングチェア、ソファ、サイドテーブル）を登録しておくと、
        商品登録画面でワンタップで選択できます（指示書16項）。
      </p>

      <div className="card p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            className="input max-w-xs"
            placeholder="カテゴリー名で検索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="btn-secondary" onClick={handleSync} disabled={syncing}>
            {syncing ? "取得中…" : "メルカリShopsからカテゴリーを再取得"}
          </button>
        </div>
        <div className="max-h-96 overflow-auto">
          <ul className="divide-y divide-slate-100">
            {leafCategories.map((c) => (
              <li key={c.id} className="flex items-center justify-between py-2 text-sm">
                <span>{c.path}</span>
                <button
                  className="btn-secondary"
                  disabled={favoriteIds.has(c.id)}
                  onClick={() => addFavorite(c.id)}
                >
                  {favoriteIds.has(c.id) ? "登録済み" : "お気に入りに追加"}
                </button>
              </li>
            ))}
            {leafCategories.length === 0 && (
              <li className="py-6 text-center text-slate-400">
                カテゴリーが未取得です。上のボタンから取得してください。
              </li>
            )}
          </ul>
        </div>
      </div>

      <div className="card p-5">
        <h2 className="section-title mb-3">現在のお気に入り</h2>
        <ul className="space-y-1.5">
          {favorites.map((f) => (
            <li key={f.categoryMapping.id} className="flex items-center justify-between text-sm">
              <span>★ {f.categoryMapping.path}</span>
              <button className="btn-danger" onClick={() => removeFavorite(f.categoryMapping.id)}>
                削除
              </button>
            </li>
          ))}
          {favorites.length === 0 && <li className="text-slate-400">お気に入りはまだありません。</li>}
        </ul>
      </div>
    </div>
  );
}
