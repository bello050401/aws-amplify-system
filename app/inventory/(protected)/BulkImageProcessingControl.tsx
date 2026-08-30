"use client";

import { useState } from "react";
import { bulkReprocessInventoryImagesAction } from "@/app/actions/imageProcessing";
import { useInventorySelection } from "./InventorySelectionProvider";

/**
 * 不具合修正・ZAICO同期重複根絶・EC出品UI改善・画像自動加工 完全自律
 * 実装指示書(2026-08-30) §7/§12.8: 在庫一覧のチェックボックス
 * (InventoryTable.tsx)へ与えた実際の用途——複数商品を横断選択して
 * まとめて画像の自動加工を予約する。DirectEditControls/ExportMenuと
 * 同じ「ツールバーの1機能を1コンポーネントに切り出す」既存方針に
 * 揃えている。選択が空の間は何も描画しない(ボタンの常設で誤操作を
 * 誘発しない)。
 */
export function BulkImageProcessingControl() {
  const { selected, clear } = useInventorySelection();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (selected.size === 0) return null;

  async function handleClick() {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const result = await bulkReprocessInventoryImagesAction(Array.from(selected));
      const parts = [`${result.itemsProcessed}件の商品を確認し、${result.enqueuedCount}枚の画像加工を予約しました`];
      // hash未計算はサーバー側で自動修復されるようになったため、ここへ
      // 計上されるのは元画像がS3に存在しないものだけ(ImageProcessingPanel
      // 側の同じ文言変更と対)。
      if (result.skippedNoHashCount > 0) parts.push(`${result.skippedNoHashCount}枚は元画像が見つからずスキップ`);
      if (result.itemsSkippedNotFound > 0) parts.push(`${result.itemsSkippedNotFound}件は見つかりませんでした`);
      setMessage(parts.join("。"));
      clear();
    } catch (err) {
      setError(err instanceof Error ? err.message : "画像加工の予約に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="whitespace-nowrap text-[12px] text-gray-600">{selected.size}件選択中</span>
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className="whitespace-nowrap border border-gray-900 px-2 py-1.5 text-[12px] font-bold text-gray-900 hover:bg-gray-50 disabled:opacity-50"
      >
        {busy ? "予約中…" : "選択した商品の画像を一括自動加工"}
      </button>
      {message && <span className="text-[11px] text-green-700">{message}</span>}
      {error && <span className="text-[11px] text-red-600">{error}</span>}
    </div>
  );
}
