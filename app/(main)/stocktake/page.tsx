"use client";

import { useState } from "react";
import { MobileHeader } from "@/components/layout/MobileHeader";
import { BarcodeScanner } from "@/components/common/BarcodeScanner";
import { NumberInput } from "@/components/common/NumberInput";
import { InlineSpinner } from "@/components/common/LoadingOverlay";
import { toErrorMessage } from "@/components/common/ErrorState";
import { getInventoryService } from "@/lib/api";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useMasterData } from "@/lib/hooks/useMasterData";
import { todayDateOnlyJST } from "@/lib/utils/date";
import type { Item } from "@/lib/types";
import { ScanIcon, SearchIcon } from "@/components/icons";
import { formatQuantity } from "@/lib/utils/format";

/**
 * 棚卸画面(指示書 §19)。
 * スキャン→商品表示→実数量入力→差分表示→確定→棚卸日更新→履歴記録、
 * を1商品ずつ連続して行える導線にする(現場で家具を連続確認しやすくする)。
 */
export default function StocktakePage() {
  const { user } = useAuth();
  const { locations } = useMasterData();
  const [keyword, setKeyword] = useState("");
  const [candidates, setCandidates] = useState<Item[]>([]);
  const [selected, setSelected] = useState<Item | null>(null);
  const [counted, setCounted] = useState<number | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function selectItem(item: Item) {
    setSelected(item);
    setCounted(item.quantity);
    setResult(null);
  }

  async function search(k: string) {
    setKeyword(k);
    if (!k.trim()) {
      setCandidates([]);
      return;
    }
    const res = await getInventoryService().searchItems({ keyword: k, pageSize: 10 });
    setCandidates(res.items);
  }

  async function handleScanned(code: string) {
    setScannerOpen(false);
    const matches = await getInventoryService().searchByScannedCode(code);
    if (matches.length === 1) {
      selectItem(matches[0]);
    } else if (matches.length > 1) {
      setCandidates(matches);
    } else {
      setError(`コード「${code}」に一致する在庫が見つかりませんでした`);
    }
  }

  const diff = selected && counted != null ? counted - selected.quantity : null;

  async function confirm() {
    if (!selected || counted == null) return;
    setBusy(true);
    setError(null);
    try {
      const { diff: appliedDiff } = await getInventoryService().applyStocktake(
        selected.id,
        counted,
        user?.email ?? "unknown",
        todayDateOnlyJST()
      );
      setResult(
        `「${selected.name}」の棚卸を記録しました(差分: ${appliedDiff >= 0 ? "+" : ""}${appliedDiff}${selected.unit})`
      );
      setSelected(null);
      setCounted(null);
      setKeyword("");
      setCandidates([]);
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pb-24">
      <MobileHeader title="棚卸" />

      <div className="space-y-4 px-4 py-4 md:px-0">
        {result && <p className="rounded-2xl bg-bello-100 px-4 py-3 text-sm font-medium text-bello-800">{result}</p>}
        {error && <p className="rounded-2xl bg-danger-50 px-4 py-3 text-sm text-danger-600">{error}</p>}

        {!selected && (
          <>
            <div className="flex gap-2">
              <div className="flex flex-1 items-center gap-2 rounded-full border border-bello-200 bg-white px-4 py-3">
                <SearchIcon className="h-5 w-5 text-bello-300" />
                <input
                  value={keyword}
                  onChange={(e) => search(e.target.value)}
                  placeholder="物品名・IDで検索"
                  className="w-full bg-transparent text-base outline-none"
                />
              </div>
              <button
                onClick={() => setScannerOpen(true)}
                className="tap-target flex items-center gap-1 rounded-full bg-bello-800 px-4 text-sm font-semibold text-white"
              >
                <ScanIcon className="h-5 w-5" />
                スキャン
              </button>
            </div>
            <div className="space-y-2">
              {candidates.map((c) => (
                <button
                  key={c.id}
                  onClick={() => selectItem(c)}
                  className="tap-target flex w-full items-center justify-between rounded-2xl bg-white p-3 text-left shadow-card"
                >
                  <span className="text-sm font-semibold text-bello-900">{c.name}</span>
                  <span className="text-xs text-bello-400">
                    システム在庫 {formatQuantity(c.quantity)}
                    {c.unit}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {selected && (
          <div className="space-y-4 rounded-2xl bg-white p-4 shadow-card">
            <div>
              <p className="text-xs text-bello-400">{locations.find((l) => l.id === selected.locationId)?.name}</p>
              <p className="text-base font-bold text-bello-900">{selected.name}</p>
              <p className="text-xs text-bello-400">
                システム在庫: {formatQuantity(selected.quantity)}
                {selected.unit}
              </p>
            </div>
            <NumberInput label="実数量" value={counted} onChange={setCounted} suffix={selected.unit} min={0} required />
            {diff !== null && diff !== 0 && (
              <p className={`text-sm font-semibold ${diff > 0 ? "text-bello-600" : "text-danger-600"}`}>
                差分: {diff > 0 ? "+" : ""}
                {diff}
                {selected.unit}
              </p>
            )}
            <div className="flex gap-3">
              <button
                onClick={() => setSelected(null)}
                className="tap-target flex-1 rounded-full border border-bello-200 py-3 text-sm font-semibold text-bello-700"
              >
                選び直す
              </button>
              <button
                onClick={confirm}
                disabled={busy}
                className="tap-target flex flex-1 items-center justify-center gap-2 rounded-full bg-bello-800 py-3 text-sm font-bold text-white disabled:opacity-60"
              >
                {busy && <InlineSpinner />}
                確定して次へ
              </button>
            </div>
          </div>
        )}
      </div>

      {scannerOpen && <BarcodeScanner onDetected={handleScanned} onClose={() => setScannerOpen(false)} />}
    </div>
  );
}
