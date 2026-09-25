"use client";

import { useEffect, useState } from "react";
import { searchBrandsAction } from "@/app/actions/brands";

type BrandSuggestion = Awaited<ReturnType<typeof searchBrandsAction>>[number];

export function BrandPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [query, setQuery] = useState(value);
  const [matches, setMatches] = useState<BrandSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [searchedQuery, setSearchedQuery] = useState("");

  useEffect(() => { setQuery(value); }, [value]);
  useEffect(() => {
    if (!open || query.trim().length < 2) { setMatches([]); setSearchedQuery(""); return; }
    let active = true;
    const timer = setTimeout(() => {
      void searchBrandsAction(query).then((rows) => { if (active) { setMatches(rows); setSearchedQuery(query); } })
        .catch(() => { if (active) { setMatches([]); setSearchedQuery(""); } });
    }, 180);
    return () => { active = false; clearTimeout(timer); };
  }, [query, open]);

  const exactMatch = matches.some((brand) => brand.name.toLocaleLowerCase() === query.trim().toLocaleLowerCase());
  const canUseTypedName = open && query.trim().length >= 2 && searchedQuery === query && !exactMatch;

  return <div className="relative">
    <label className="block text-[12px] text-gray-600" htmlFor="inventory-brand">ブランド</label>
    <input id="inventory-brand" value={query} maxLength={100} onChange={(event) => { setQuery(event.target.value); setSearchedQuery(""); setOpen(true); if (value) onChange(""); }}
      onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
      placeholder="ブランド名・読みで検索" autoComplete="off"
      className="mt-0.5 w-full border border-gray-300 px-2.5 py-2.5 text-[16px] focus:border-gray-500 focus:outline-none" />
    {value && <p className="mt-1 text-xs text-green-700">選択中: {value} <button type="button" onClick={() => { onChange(""); setQuery(""); }} className="ml-2 underline">解除</button></p>}
    {open && (matches.length > 0 || canUseTypedName) && <ul className="absolute z-20 max-h-56 w-full overflow-auto border bg-white shadow-md">
      {matches.map((brand) => <li key={brand.id}><button type="button" onMouseDown={(event) => event.preventDefault()}
        onClick={() => { onChange(brand.name); setQuery(brand.name); setOpen(false); }} className="w-full px-3 py-2 text-left text-sm hover:bg-gray-100">
        {brand.name}{brand.reading && <span className="ml-2 text-gray-500">{brand.reading}</span>}
      </button></li>)}
      {canUseTypedName && <li><button type="button" onMouseDown={(event) => event.preventDefault()}
        onClick={() => { const name = query.trim(); onChange(name); setQuery(name); setOpen(false); }} className="w-full border-t px-3 py-2 text-left text-sm hover:bg-gray-100">
        「{query.trim()}」をブランド名として保存<span className="ml-2 text-gray-500">参考説明・ロゴはありません</span>
      </button></li>}
    </ul>}
  </div>;
}
