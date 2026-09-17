"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { InventoryThumbnail } from "@/app/inventory/InventoryThumbnail";
import { linkPhotoBatchToInventoryAction, searchInventoryCandidatesAction, type InventoryCandidateRow } from "@/app/actions/photoRegistration";

const SEARCH_DEBOUNCE_MS = 180;

export function InventoryLinkPanel({ batchId, batchStatus, currentInventoryId, hasOpenRevision }: {
  batchId: string; batchStatus: string; currentInventoryId: string | null; hasOpenRevision: boolean;
}) {
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<InventoryCandidateRow[]>([]);
  const [searching, setSearching] = useState(true);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<InventoryCandidateRow | null>(null);
  const [linking, setLinking] = useState(false);
  const [linked, setLinked] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestRef.current;
    const timer = setTimeout(async () => {
      setSearching(true);
      const result = await searchInventoryCandidatesAction(query);
      if (requestId !== requestRef.current) return;
      if (!result.ok) { setSearchError(result.message); setCandidates([]); }
      else {
        setSearchError(null); setCandidates(result.items);
        setSelected((current) => current && result.items.some((item) => item.id === current.id) ? current : result.items[0] ?? null);
      }
      setSearching(false);
    }, query.trim() ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [query]);

  if (currentInventoryId || linked) return (
    <div className="rounded border border-green-300 bg-green-50 p-4 text-sm text-green-900">
      <p className="font-bold">在庫への紐付けが完了しました。</p>
      <Link href="/inventory/photo-registration" className="mt-2 inline-block underline">未登録バッチ一覧へ戻る</Link>
    </div>
  );
  if (batchStatus !== "READY_FOR_REVIEW") return <Notice>確認待ちになってから在庫へ紐付けられます。</Notice>;
  if (hasOpenRevision) return <Notice>追加アップロードの完了後に在庫へ紐付けられます。</Notice>;

  async function handleConfirmLink() {
    if (linking || !selected) return;
    setLinking(true); setLinkError(null);
    const result = await linkPhotoBatchToInventoryAction(batchId, selected.id);
    setLinking(false);
    if (!result.ok) return setLinkError(result.message);
    setLinked(true);
  }

  return (
    <div className="rounded border border-gray-200 bg-white p-4">
      <label htmlFor="photo-registration-inventory-search" className="mb-1 block text-xs font-medium text-gray-700">在庫を検索（在庫ID・SKU・商品名）</label>
      <input id="photo-registration-inventory-search" value={query} onChange={(event) => { setQuery(event.target.value); setLinkError(null); }}
        placeholder="入力前は 撮影待ち → 出品待ち → 補修待ち の順に表示" className="w-full rounded border border-gray-300 px-3 py-2 text-sm" />
      <p aria-live="polite" className="mt-1 min-h-5 text-xs text-gray-500">
        {searching ? "検索中…" : searchError ? <span className="text-red-600">{searchError}</span> : `${candidates.length}件を表示`}
      </p>

      <div className="mt-2 grid min-h-[22rem] gap-3 lg:grid-cols-2">
        <div className="max-h-[30rem] overflow-y-auto rounded border border-gray-200">
          {candidates.length === 0 && !searching ? <p className="p-4 text-sm text-gray-500">該当する在庫がありません。</p> : null}
          {candidates.map((candidate) => (
            <button key={candidate.id} type="button" onClick={() => { setSelected(candidate); setLinkError(null); }}
              className={`flex w-full gap-3 border-b border-gray-100 p-3 text-left hover:bg-gray-50 ${selected?.id === candidate.id ? "bg-blue-50 ring-1 ring-inset ring-blue-300" : ""}`}>
              <InventoryThumbnail storageKey={candidate.imageStorageKey} alt={candidate.name} size="list" loading="lazy" />
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold text-gray-900">{candidate.name}</span>
                <span className="block text-xs text-gray-600">{candidate.displayId} ・ {candidate.statusLabel}</span></span>
            </button>
          ))}
        </div>

        <div className="rounded border border-gray-200 bg-gray-50 p-4">
          {selected ? <>
            <InventoryThumbnail storageKey={selected.imageStorageKey} alt={selected.name} size="hero" loading="eager" />
            <div className="mt-3">
              <div className="min-w-0"><h3 className="text-base font-bold text-gray-900">{selected.name}</h3>
                <p className="mt-1 text-sm text-gray-600">在庫ID {selected.displayId}</p><p className="text-sm text-gray-600">SKU {selected.sku}</p>
                <span className="mt-2 inline-block rounded bg-white px-2 py-1 text-xs font-bold text-gray-700">{selected.statusLabel}</span></div>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-gray-500">数量</dt><dd>{selected.quantity}{selected.unit ?? ""}</dd>
              <dt className="text-gray-500">予定販売価格</dt><dd>{selected.plannedSalePrice == null ? "未設定" : `${selected.plannedSalePrice.toLocaleString()}円`}</dd>
              <dt className="text-gray-500">商品画像</dt><dd>{selected.imageStorageKey ? "登録あり" : "未登録"}</dd>
              <dt className="text-gray-500">備考</dt><dd className="break-words">{selected.note || "なし"}</dd>
            </dl>
            {linkError ? <p role="alert" className="mt-3 text-sm text-red-600">{linkError}</p> : null}
            <button type="button" onClick={handleConfirmLink} disabled={linking}
              className="mt-4 min-h-10 w-full rounded bg-blue-700 px-4 text-sm font-bold text-white hover:bg-blue-800 disabled:opacity-50">
              {linking ? "バックエンドで紐付け中…" : "この商品へ紐付ける"}
            </button>
          </> : <p className="text-sm text-gray-500">左の検索結果から商品を選択してください。</p>}
        </div>
      </div>
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return <div className="rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{children}</div>;
}
