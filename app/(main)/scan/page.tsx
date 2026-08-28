"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MobileHeader } from "@/components/layout/MobileHeader";
import { BarcodeScanner } from "@/components/common/BarcodeScanner";
import { getInventoryService } from "@/lib/api";
import { useSearchState } from "@/lib/hooks/useSearchState";

/**
 * スキャン検索画面(指示書 §21)。
 * 1件一致→物品詳細へ直接遷移 / 複数一致→在庫一覧へ / 0件→新規登録へ誘導。
 * 編集画面と同じBarcodeScannerコンポーネント・同じsearchByScannedCodeロジックを再利用。
 */
export default function ScanSearchPage() {
  const router = useRouter();
  const { update } = useSearchState();
  const [noMatchCode, setNoMatchCode] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(true);

  async function handleDetected(code: string) {
    setScannerOpen(false);
    const matches = await getInventoryService().searchByScannedCode(code);
    if (matches.length === 1) {
      router.replace(`/inventory/${matches[0].id}`);
    } else if (matches.length > 1) {
      update({ keyword: code, categoryId: null, advanced: null });
      router.replace("/inventory");
    } else {
      setNoMatchCode(code);
    }
  }

  return (
    <div>
      <MobileHeader title="スキャン検索" />

      {!scannerOpen && noMatchCode && (
        <div className="space-y-4 px-4 py-8 text-center">
          <p className="text-4xl">🔍</p>
          <p className="text-sm font-semibold text-bello-800">該当する在庫がありません</p>
          <p className="text-xs text-bello-400">読み取ったコード: {noMatchCode}</p>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => {
                setNoMatchCode(null);
                setScannerOpen(true);
              }}
              className="tap-target rounded-full border border-bello-200 py-3 text-sm font-semibold text-bello-700"
            >
              もう一度スキャンする
            </button>
            <Link
              href={`/inventory/new?barcode=${encodeURIComponent(noMatchCode)}`}
              className="tap-target rounded-full bg-bello-800 py-3 text-sm font-bold text-white"
            >
              このコードで新規登録する
            </Link>
          </div>
        </div>
      )}

      {scannerOpen && <BarcodeScanner onDetected={handleDetected} onClose={() => router.push("/")} />}
    </div>
  );
}
