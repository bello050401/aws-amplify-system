"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { MasterOption } from "@/lib/inventory/queries";
import { listFilterHref } from "@/lib/inventory/listFilterNavigation";
import { listNavigationStatus } from "@/lib/inventory/searchNavigationState";
import { useUnsavedChanges } from "../UnsavedChangesProvider";

interface CategoryFilterListProps {
  categories: MasterOption[]; activeCategoryIds: string[];
  activeLocationId?: string; q?: string; advanced?: string; adv?: string; limit?: string;
}

/** Apply each selection immediately; retain the latest intent while a previous
 * route response is in flight, so rapid checks do not lose earlier checks. */
export function CategoryFilterList({ categories, activeCategoryIds }: CategoryFilterListProps) {
  const router = useRouter(), params = useSearchParams();
  const { isDirty, guardedNavigate } = useUnsavedChanges();
  const [selected, setSelected] = useState(activeCategoryIds);
  const selectedRef = useRef(activeCategoryIds);
  const requested = useRef<string | null>(null);
  const [categoryQuery,setCategoryQuery]=useState('');
  const normalize=(value:string)=>value.normalize('NFKC').toLocaleLowerCase('ja').replace(/[ァ-ヶ]/g,c=>String.fromCharCode(c.charCodeAt(0)-0x60));
  const visibleCategories=categories.filter(cat=>normalize(cat.name).includes(normalize(categoryQuery.trim())));
  const [, startTransition] = useTransition();
  const [request, setRequest] = useState<{from:string;href:string}|null>(null);
  const [delayed, setDelayed] = useState(false);
  const navigationStatus = listNavigationStatus(params.toString(), request);
  const pending = navigationStatus === "waiting";
  useEffect(() => {
    if (navigationStatus === "complete" || navigationStatus === "superseded") setRequest(null);
  }, [navigationStatus]);
  useEffect(() => {
    setDelayed(false);
    if (!request) return;
    const timer = setTimeout(() => setDelayed(true), 15000);
    return () => clearTimeout(timer);
  }, [request]);
  const appliedKey = JSON.stringify(activeCategoryIds);
  useEffect(() => {
    if (requested.current !== null && requested.current !== appliedKey) return;
    requested.current = null;
    selectedRef.current = JSON.parse(appliedKey);
    setSelected(selectedRef.current);
  }, [appliedKey]);
  useEffect(() => {
    const pop = () => { requested.current=null; selectedRef.current=(new URLSearchParams(window.location.search).get('categoryIds')||'').split(',').filter(Boolean);setSelected(selectedRef.current);setRequest(null); };
    window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);
  }, []);
  function apply(next: string[]) {
    const href = listFilterHref(params.toString(), { categoryIds: next.join(",") });
    if (isDirty) { guardedNavigate(href); }
    else {
      selectedRef.current=next; setSelected(next); requested.current=JSON.stringify(next);
      setRequest({from:params.toString(),href});
      startTransition(() => router.push(href,{scroll:false}));
    }
  }
  return <div>
    <p className="mb-2 px-2 text-xs text-gray-500">複数選択可・いずれかに一致</p>
    <input type="search" aria-label="カテゴリを検索" placeholder="カテゴリを検索" value={categoryQuery} onChange={e=>setCategoryQuery(e.target.value)} className="mb-2 w-full rounded border border-gray-300 px-2 py-2 text-[13px]"/>
    {categoryQuery&&<p className="mb-1 px-2 text-xs text-gray-500">{visibleCategories.length}件表示・選択中{selected.length}件</p>}
    {categories.length === 0 && <p className="px-2 py-1 text-xs text-gray-500">未登録</p>}
    <ul>
      {visibleCategories.map(cat => <li key={cat.id}>
        <label className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-gray-50 ${selected.includes(cat.id) ? "bg-teal-50 font-semibold text-teal-900" : "text-gray-700"}`}>
          <input type="checkbox" checked={selected.includes(cat.id)}
            onChange={e => apply(e.target.checked ? [...new Set([...selectedRef.current, cat.id])] : selectedRef.current.filter(id => id !== cat.id))}
            className="h-4 w-4 shrink-0 accent-teal-800" />
          <span className="truncate" title={cat.name}>{cat.name}</span>
        </label>
      </li>)}
    </ul>
    {!!categories.length&&!visibleCategories.length&&<p className="px-2 py-2 text-xs text-gray-500">該当するカテゴリがありません。</p>}
    <div className="sticky bottom-0 space-y-1 border-t bg-white px-1 py-2">
      {pending&&<p role="status" className="px-1 text-xs text-gray-500">絞り込み中…</p>}
      {pending&&delayed&&<button type="button" onClick={()=>apply(selectedRef.current)} className="text-sm underline">絞り込みを再試行</button>}
      {pending && delayed && <p role="status" className="px-1 text-xs text-amber-800">検索に時間がかかっています。選択を保ったまま再試行できます。</p>}
      <div className="flex items-center justify-between px-1 text-xs">
        <span className="text-gray-500">選択するとすぐに絞り込みます</span>
        {selected.length > 0 && <button type="button" onClick={() => apply([])} className="py-1 text-gray-600 underline">解除</button>}
      </div>
    </div>
  </div>;
}
