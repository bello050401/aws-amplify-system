"use client";

import { useRef, useState } from "react";
import { advanceThumbnailBackfillAction } from "@/app/actions/thumbnailBackfill";

/**
 * BELLO統合改修 master指示書 Phase B優先度4(既存画像のバックグラウンド
 * バックフィル)。ADMIN専用 — 表示自体はSettingsTabs.tsx側のisAdminガー
 * ドで隠すのみで、実際の書き込み権限はServer Action側
 * (app/actions/thumbnailBackfill.ts)で独立に強制される。
 *
 * lib/inventory/zaicoBackgroundSync.tsのような永続ジョブ/ロックは持た
 * ない(この画面を閉じれば進行は止まる)— 同じスキャンを再度実行しても
 * 安全(既にサムネイルがある画像は毎回スキップされるだけ)なので、ZAICO
 * 全件同期ほどの再開保証は要らない。件数が多い場合は単に「続きから」
 * ボタンで前回のnextTokenから再開できる。
 */
export function ThumbnailBackfillPanel() {
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [scanned, setScanned] = useState(0);
  const [attempted, setAttempted] = useState(0);
  const [generated, setGenerated] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const nextTokenRef = useRef<string | null>(null);
  const stopRequestedRef = useRef(false);

  async function runLoop() {
    setError(null);
    setRunning(true);
    setDone(false);
    stopRequestedRef.current = false;
    setScanned(0);
    setAttempted(0);
    setGenerated(0);
    nextTokenRef.current = null;

    try {
      for (;;) {
        if (stopRequestedRef.current) break;
        const result = await advanceThumbnailBackfillAction(nextTokenRef.current);
        setScanned((n) => n + result.scanned);
        setAttempted((n) => n + result.attempted);
        setGenerated((n) => n + result.generated);
        nextTokenRef.current = result.nextToken;
        if (result.done) {
          setDone(true);
          break;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "サムネイル生成に失敗しました。");
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
        在庫一覧の画像を高速表示するため、各商品画像の小さいサムネイルを生成します（オリジナル画像はそのまま残ります・詳細画面は引き続きオリジナルの解像度で表示されます）。この機能が追加される前に登録・同期された画像だけが対象です — それ以降の新規登録・ZAICO同期では自動的にサムネイルが作られます。
      </p>

      <div className="border border-gray-200 p-4">
        <p className="mb-2 text-[12px] font-bold text-gray-700">既存画像のサムネイル一括生成</p>
        <p className="mb-2 text-[11px] text-gray-500">
          この画面を開いている間、少しずつ処理します。既にサムネイルがある画像は自動的にスキップされるため、何度実行しても安全です。画面を閉じた場合は「続きから実行」で前回の続きから再開できます。
        </p>

        <dl className="mb-3 grid grid-cols-4 gap-y-1 text-[12px] text-gray-700">
          <dt className="text-gray-500">確認した商品件数</dt>
          <dd className="col-span-3">{scanned}</dd>
          <dt className="text-gray-500">サムネイル生成を試行</dt>
          <dd className="col-span-3">{attempted}</dd>
          <dt className="text-gray-500">生成成功</dt>
          <dd className="col-span-3">{generated}</dd>
          {done && (
            <>
              <dt className="text-gray-500">状態</dt>
              <dd className="col-span-3 font-bold text-green-700">完了（対象の画像はすべて確認済みです）</dd>
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
            {running ? "実行中…" : nextTokenRef.current || done ? "続きから実行" : "サムネイル生成を開始"}
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
