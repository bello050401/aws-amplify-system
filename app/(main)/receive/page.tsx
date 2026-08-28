"use client";

import { useState } from "react";
import Link from "next/link";
import { MobileHeader } from "@/components/layout/MobileHeader";
import { BarcodeScanner } from "@/components/common/BarcodeScanner";
import { NumberInput } from "@/components/common/NumberInput";
import { InlineSpinner } from "@/components/common/LoadingOverlay";
import { toErrorMessage } from "@/components/common/ErrorState";
import { getInventoryService } from "@/lib/api";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useMasterData } from "@/lib/hooks/useMasterData";
import type { Item } from "@/lib/types";
import { ScanIcon, SearchIcon } from "@/components/icons";
import { formatQuantity } from "@/lib/utils/format";

/** 入庫画面(指示書 §17)。検索・スキャンで在庫を選び、数量を入力して入庫確定。 */
export default function ReceivePage() {
  const { user } = useAuth();
  const { categories } = useMasterData();
  const [keyword, setKeyword] = useState("");
  const [candidates, setCandidates] = useState<Item[]>([]);
  const [selected, setSelected] = useState<Item | null>(null);
  const [quantity, setQuantity] = useState<number | null>(1);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      setSelected(matches[0]);
    } else if (matches.length > 1) {
      setCandidates(matches);
    } else {
      setError(`コード「${code}」に一致する在庫が見つかりませんでした`);
    }
  }

  async function confirmReceive() {
    if (!selected || !quantity) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await getInventoryService().receiveStock(selected.id, quantity, user?.email ?? "unknown");
      setMessage(`「${selected.name}」を${quantity}${selected.unit}入庫しました(現在庫: ${formatQuantity(updated.quantity)})`);
      setSelected(null);
      setQuantity(1);
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
      <MobileHeader
        title="入庫"
        right={
          <Link href="/receive/history" className="tap-target text-xs font-semibold text-bello-700">
            履歴
          </Link>
        }
      />

      <div className="space-y-4 px-4 py-4 md:px-0">
        {message && <p className="rounded-2xl bg-bello-100 px-4 py-3 text-sm font-medium text-bello-800">{message}</p>}
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
                  onClick={() => setSelected(c)}
                  className="tap-target flex w-full items-center justify-between rounded-2xl bg-white p-3 text-left shadow-card"
                >
                  <span className="text-sm font-semibold text-bello-900">{c.name}</span>
                  <span className="text-xs text-bello-400">
                    在庫 {formatQuantity(c.quantity)}
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
              <p className="text-xs text-bello-400">
                {categories.find((c) => c.id === selected.categoryId)?.name ?? ""}
              </p>
              <p className="text-base font-bold text-bello-900">{selected.name}</p>
              <p className="text-xs text-bello-400">現在庫: {formatQuantity(selected.quantity)}{selected.unit}</p>
            </div>
            <NumberInput label="入庫数量" value={quantity} onChange={setQuantity} suffix={selected.unit} min={1} required />
            <div className="flex gap-3">
              <button
                onClick={() => setSelected(null)}
                className="tap-target flex-1 rounded-full border border-bello-200 py-3 text-sm font-semibold text-bello-700"
              >
                選び直す
              </button>
              <button
                onClick={confirmReceive}
                disabled={busy}
                className="tap-target flex flex-1 items-center justify-center gap-2 rounded-full bg-bello-800 py-3 text-sm font-bold text-white disabled:opacity-60"
              >
                {busy && <InlineSpinner />}
                入庫確定
              </button>
            </div>
          </div>
        )}
      </div>

      {scannerOpen && <BarcodeScanner onDetected={handleScanned} onClose={() => setScannerOpen(false)} />}
    </div>
  );
}
