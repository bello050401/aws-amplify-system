"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { linkPhotoBatchToInventoryAction, searchInventoryCandidatesAction, type InventoryCandidateRow } from "@/app/actions/photoRegistration";

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Inventory候補検索 + link確認。紐付けはPhase 1では解除できない
 * (docs/photo-registration-api-v1.md §3.5「紐付け解除… Phase 2」) ため、
 * 検索結果から選ぶ→選択内容を表示→もう一度明示的に押す、の2段階にして
 * 誤操作を防ぐ(ネイティブconfirm()は使わず、選んだ商品名を画面に出したまま
 * ボタン自体を確認操作にする)。
 */
export function InventoryLinkPanel({
  batchId,
  batchStatus,
  currentInventoryId,
  hasOpenRevision,
}: {
  batchId: string;
  batchStatus: string;
  currentInventoryId: string | null;
  hasOpenRevision: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<InventoryCandidateRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<InventoryCandidateRow | null>(null);
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length === 0) {
      setCandidates([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      const result = await searchInventoryCandidatesAction(query);
      if (!result.ok) {
        setSearchError(result.message);
        setCandidates([]);
      } else {
        setSearchError(null);
        setCandidates(result.items);
      }
      setSearching(false);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  if (currentInventoryId) {
    return (
      <div className="rounded border border-gray-200 bg-white p-4 text-sm text-gray-700">
        この撮影バッチは在庫 (ID: {currentInventoryId}) に紐付け済みです。紐付けの解除・付け替えは今後の機能で対応予定です。
      </div>
    );
  }

  if (batchStatus !== "READY_FOR_REVIEW") {
    return <div className="rounded border border-gray-200 bg-white p-4 text-sm text-gray-500">確認待ち(READY_FOR_REVIEW)状態になってから在庫へ紐付けられます。</div>;
  }

  if (hasOpenRevision) {
    return <div className="rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">追加アップロードが進行中のため、完了するまで在庫へ紐付けられません。</div>;
  }

  async function handleConfirmLink() {
    if (linking || !selected) return; // 二重送信防止
    setLinking(true);
    setLinkError(null);
    const result = await linkPhotoBatchToInventoryAction(batchId, selected.id);
    setLinking(false);
    if (!result.ok) {
      setLinkError(result.message);
      return;
    }
    router.refresh();
  }

  return (
    <div className="rounded border border-gray-200 bg-white p-4">
      <label htmlFor="photo-registration-inventory-search" className="mb-1 block text-xs font-medium text-gray-700">
        紐付け先の在庫を検索(SKU・在庫ID・商品名)
      </label>
      <input
        id="photo-registration-inventory-search"
        type="text"
        value={query}
        onChange={(e) => {
          setSelected(null);
          setLinkError(null);
          setQuery(e.target.value);
        }}
        placeholder="例: B000123 / ○○チェア"
        className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
      />
      <div aria-live="polite" className="mt-2 text-xs text-gray-500">
        {searching ? "検索中…" : searchError ? <span className="text-red-600">{searchError}</span> : null}
      </div>
      {!searching && query.trim().length > 0 && candidates.length === 0 && !searchError ? (
        <p className="mt-2 text-xs text-gray-500">該当する在庫が見つかりません。</p>
      ) : null}
      {candidates.length > 0 ? (
        <ul className="mt-2 max-h-64 divide-y divide-gray-100 overflow-y-auto rounded border border-gray-200">
          {candidates.map((candidate) => (
            <li key={candidate.id}>
              <button
                type="button"
                onClick={() => {
                  setSelected(candidate);
                  setLinkError(null);
                }}
                aria-pressed={selected?.id === candidate.id}
                className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-gray-50 ${
                  selected?.id === candidate.id ? "bg-blue-50" : ""
                }`}
              >
                <span className="truncate">
                  {candidate.displayId} ・ {candidate.name}
                </span>
                {selected?.id === candidate.id ? <span className="shrink-0 text-blue-700">選択中</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {selected ? (
        <div className="mt-3 rounded border border-blue-200 bg-blue-50 p-3">
          <p className="text-xs text-blue-900">
            選択中: {selected.displayId} ・ {selected.name}
          </p>
          {linkError ? (
            <p role="alert" className="mt-1 text-xs text-red-600">
              {linkError}
            </p>
          ) : null}
          <button
            type="button"
            onClick={handleConfirmLink}
            disabled={linking}
            className="mt-2 min-h-8 rounded bg-blue-700 px-4 text-xs font-bold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {linking ? "紐付け中…" : `この商品(${selected.displayId})へ紐付ける`}
          </button>
        </div>
      ) : null}
    </div>
  );
}
