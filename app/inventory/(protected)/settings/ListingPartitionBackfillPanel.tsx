"use client";

import { useRef, useState } from "react";
import { advanceListingPartitionBackfillAction } from "@/app/actions/listingPartitionBackfill";

/**
 * 第六ラウンドP0-5(docs/inventory-cursor-pagination-20260830.md参照):
 * 真のサーバー側cursor pagination用GSI(listingPartition/listUpdatedAt)
 * を既存レコードへ適用する一度きりの移行 — ThumbnailBackfillPanel.tsx
 * と同じ理由でADMIN専用・永続ジョブ無しのbounded/idempotent設計。
 *
 * **この移行を実行しただけでは一覧の挙動は何も変わらない** —
 * lib/inventory/queries.tsのlistInventory()はこのラウンドではまだ
 * 新GSIへ切り替えていない(このパネル直下の注記、および
 * docs/inventory-cursor-pagination-20260830.mdの「本ラウンドで
 * 見送ったこと」参照)。この移行は将来切り替える際の前提条件を整える
 * ものであり、それ自体はユーザーに見える変化を起こさない。
 */
export function ListingPartitionBackfillPanel() {
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [scanned, setScanned] = useState(0);
  const [backfilled, setBackfilled] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const nextTokenRef = useRef<string | null>(null);
  const stopRequestedRef = useRef(false);

  async function runLoop() {
    setError(null);
    setRunning(true);
    setDone(false);
    stopRequestedRef.current = false;
    setScanned(0);
    setBackfilled(0);
    nextTokenRef.current = null;

    try {
      for (;;) {
        if (stopRequestedRef.current) break;
        const result = await advanceListingPartitionBackfillAction(nextTokenRef.current);
        setScanned((n) => n + result.scanned);
        setBackfilled((n) => n + result.backfilled);
        nextTokenRef.current = result.nextToken;
        if (result.done) {
          setDone(true);
          break;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "移行処理に失敗しました。");
    } finally {
      setRunning(false);
    }
  }

  function stop() {
    stopRequestedRef.current = true;
  }

  return (
    <div className="max-w-2xl">
      <p className="mb-4 text-[12px] text-gray-500">
        在庫一覧の並び順を将来より高速なサーバー側cursor方式へ移行するための下準備です（今回のバージョンではまだ一覧の動作自体は変わりません）。既存の商品データへ内部的な索引用フィールドを設定するだけで、商品名・数量・画像等の表示内容は一切変更しません。
      </p>

      <div className="border border-gray-200 p-4">
        <p className="mb-2 text-[12px] font-bold text-gray-700">一覧インデックス移行（listingPartition/listUpdatedAt）</p>
        <p className="mb-2 text-[11px] text-gray-500">
          この画面を開いている間、少しずつ処理します。既に移行済みの商品は自動的にスキップされるため、何度実行しても安全です。画面を閉じた場合は「続きから実行」で前回の続きから再開できます。
        </p>

        <dl className="mb-3 grid grid-cols-4 gap-y-1 text-[12px] text-gray-700">
          <dt className="text-gray-500">確認した商品件数</dt>
          <dd className="col-span-3">{scanned}</dd>
          <dt className="text-gray-500">移行済み</dt>
          <dd className="col-span-3">{backfilled}</dd>
          {done && (
            <>
              <dt className="text-gray-500">状態</dt>
              <dd className="col-span-3 font-bold text-green-700">完了（対象の商品はすべて確認済みです）</dd>
            </>
          )}
        </dl>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={runLoop}
            disabled={running}
            className="bg-gray-900 px-3 py-1 text-[13px] font-bold text-white disabled:opacity-50"
          >
            {running ? "実行中…" : nextTokenRef.current || done ? "続きから実行" : "移行を開始"}
          </button>
          {running && (
            <button type="button" onClick={stop} className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50">
              一時停止
            </button>
          )}
        </div>

        {error && <p className="mt-2 text-[12px] text-red-600">{error}</p>}
      </div>
    </div>
  );
}
