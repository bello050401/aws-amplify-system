"use client";

import { useEffect, useState } from "react";

interface BrandRow {
  id: string;
  name: string;
}

export function BrandPicker({
  value,
  valueName,
  onChange,
}: {
  value: string | null;
  valueName?: string | null;
  onChange: (brandMappingId: string | null, name: string | null) => void;
}) {
  const [query, setQuery] = useState(valueName ?? "");
  const [results, setResults] = useState<BrandRow[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handle = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/mercari/brands?q=${encodeURIComponent(query)}`);
        const json = await res.json();
        setResults(json.brands ?? []);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [query, open]);

  return (
    <div className="relative">
      <input
        className="input"
        placeholder="ブランドを検索（例: Cassina, Herman Miller）"
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
      />
      {value && (
        <button
          type="button"
          className="mt-1 text-xs text-slate-500 hover:underline"
          onClick={() => {
            onChange(null, null);
            setQuery("");
          }}
        >
          ブランド指定を解除する
        </button>
      )}
      {open && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-slate-200 bg-white shadow-lg">
          {loading && <div className="p-2 text-xs text-slate-400">検索中…</div>}
          {!loading && results.length === 0 && (
            <div className="p-2 text-xs text-slate-400">該当するブランドがありません</div>
          )}
          {results.map((b) => (
            <button
              key={b.id}
              type="button"
              className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
              onClick={() => {
                onChange(b.id, b.name);
                setQuery(b.name);
                setOpen(false);
              }}
            >
              {b.name}
            </button>
          ))}
          <button
            type="button"
            className="block w-full border-t border-slate-100 px-3 py-2 text-left text-xs text-slate-400 hover:bg-slate-50"
            onClick={() => setOpen(false)}
          >
            閉じる
          </button>
        </div>
      )}
    </div>
  );
}
