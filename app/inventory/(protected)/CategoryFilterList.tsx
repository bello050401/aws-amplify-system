"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { MasterOption } from "@/lib/inventory/queries";
import { listFilterHref } from "@/lib/inventory/listFilterNavigation";
import { listNavigationStatus } from "@/lib/inventory/searchNavigationState";
import { useUnsavedChanges } from "../UnsavedChangesProvider";

interface CategoryFilterListProps {
  categories: MasterOption[]; activeCategoryIds: string[];
  activeLocationId?: string; q?: string; advanced?: string; adv?: string; limit?: string;
}

/** Keep the draft local until Apply: consecutive clicks cannot overwrite a
 * previous selection using stale server props. */
export function CategoryFilterList({ categories, activeCategoryIds }: CategoryFilterListProps) {
  const router = useRouter(), params = useSearchParams();
  const { isDirty, guardedNavigate } = useUnsavedChanges();
  const [selected, setSelected] = useState(activeCategoryIds);
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
  const locked = pending && !delayed;
  const appliedKey = JSON.stringify(activeCategoryIds);
  useEffect(() => { setSelected(JSON.parse(appliedKey)); }, [appliedKey]);
  const changed = JSON.stringify(selected) !== appliedKey;
  function apply() {
    const href = listFilterHref(params.toString(), { categoryIds: selected.join(",") });
    if (isDirty) guardedNavigate(href);
    else {
      setRequest({from:params.toString(),href});
      startTransition(() => router.push(href));
    }
  }
  return <div>
    <p className="mb-2 px-2 text-xs text-gray-500">複数選択可・いずれかに一致</p>
    {categories.length === 0 && <p className="px-2 py-1 text-xs text-gray-500">未登録</p>}
    <ul>
      {categories.map(cat => <li key={cat.id}>
        <label className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-gray-50 ${selected.includes(cat.id) ? "bg-teal-50 font-semibold text-teal-900" : "text-gray-700"}`}>
          <input type="checkbox" checked={selected.includes(cat.id)} disabled={locked}
            onChange={e => { const checked = e.target.checked; setSelected(prev => checked ? [...prev, cat.id] : prev.filter(id => id !== cat.id)); }}
            className="h-4 w-4 shrink-0 accent-teal-800" />
          <span className="truncate" title={cat.name}>{cat.name}</span>
        </label>
      </li>)}
    </ul>
    <div className="sticky bottom-0 space-y-1 border-t bg-white px-1 py-2">
      <button type="button" onClick={apply} disabled={locked}
        className="w-full rounded bg-teal-900 px-2 py-2 text-sm font-semibold text-white disabled:opacity-50">
        {pending ? delayed ? "検索を再試行" : "検索中…" : `カテゴリで検索${selected.length ? `（${selected.length}）` : ""}`}
      </button>
      {pending && delayed && <p role="status" className="px-1 text-xs text-amber-800">検索に時間がかかっています。選択を保ったまま再試行できます。</p>}
      <div className="flex items-center justify-between px-1 text-xs">
        <span role="status" className="text-gray-500">{changed && !pending ? "選択を変更中・検索で反映" : ""}</span>
        {selected.length > 0 && <button type="button" disabled={locked} onClick={() => setSelected([])} className="py-1 text-gray-600 underline">選択解除</button>}
      </div>
    </div>
  </div>;
}
