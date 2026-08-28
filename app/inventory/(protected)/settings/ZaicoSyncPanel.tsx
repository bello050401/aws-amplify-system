"use client";

import { useState } from "react";
import { syncAllZaicoInventoriesAction, syncOneZaicoInventoryAction } from "@/app/actions/zaicoSync";
import type { ZaicoSyncResult } from "@/lib/inventory/zaicoSync";

/**
 * ADMIN-only ZAICO→BELLO 手動同期パネル (spec §18/§27-29). Rendered only
 * for ADMIN by SettingsTabs (this component doesn't re-check the role
 * itself — the Server Actions it calls do that independently, so even a
 * stray render here could never actually perform a write). Never displays
 * the ZAICO API token — nothing here ever receives it in the first place,
 * see lib/zaico/client.ts.
 *
 * Phase 1 (spec's own required order): only the single-item sync (by
 * ZAICO ID) is meant to be exercised until it's fully verified — the
 * "全件同期" button is present per spec §11/§18 but stays a plainly
 * separate, explicitly-labeled action so it's never triggered by
 * accident while testing the single-item path.
 */
export function ZaicoSyncPanel() {
  const [zaicoId, setZaicoId] = useState("");
  const [busy, setBusy] = useState<"idle" | "one" | "all">("idle");
  const [result, setResult] = useState<ZaicoSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runOne() {
    const trimmed = zaicoId.trim();
    if (!trimmed) {
      setError("ZAICO在庫ID（例: 73638418）を入力してください。");
      return;
    }
    setError(null);
    setResult(null);
    setBusy("one");
    try {
      setResult(await syncOneZaicoInventoryAction(trimmed));
    } catch (err) {
      setError(err instanceof Error ? err.message : "同期に失敗しました。");
    } finally {
      setBusy("idle");
    }
  }

  async function runAll() {
    setError(null);
    setResult(null);
    setBusy("all");
    try {
      setResult(await syncAllZaicoInventoriesAction());
    } catch (err) {
      setError(err instanceof Error ? err.message : "同期に失敗しました。");
    } finally {
      setBusy("idle");
    }
  }

  return (
    <div className="max-w-2xl">
      <p className="mb-4 text-[12px] text-gray-500">
        ZAICOの在庫データをBELLOへ取り込みます（ZAICO → BELLOの一方向のみ。BELLOからZAICOへは一切書き込みません）。
      </p>

      <div className="border border-gray-200 p-4">
        <p className="mb-2 text-[12px] font-bold text-gray-700">1件同期（テスト用）</p>
        <div className="flex gap-2">
          <input
            value={zaicoId}
            onChange={(e) => setZaicoId(e.target.value)}
            placeholder="ZAICO在庫ID（例: 73638418）"
            disabled={busy !== "idle"}
            className="w-64 border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            onClick={runOne}
            disabled={busy !== "idle"}
            className="bg-gray-900 px-3 py-1 text-[13px] font-bold text-white disabled:opacity-50"
          >
            {busy === "one" ? "同期中…" : "同期する"}
          </button>
        </div>
      </div>

      <div className="mt-3 border border-gray-200 p-4">
        <p className="mb-2 text-[12px] font-bold text-gray-700">全件同期</p>
        <p className="mb-2 text-[11px] text-gray-500">ZAICOの全在庫を取得し、BELLOへ反映します。件数が多い場合、完了まで時間がかかります。</p>
        <button
          type="button"
          onClick={runAll}
          disabled={busy !== "idle"}
          className="border border-gray-900 px-3 py-1 text-[13px] font-bold text-gray-900 disabled:opacity-50"
        >
          {busy === "all" ? "同期中…" : "全件同期する"}
        </button>
      </div>

      {error && <p className="mt-3 text-[13px] text-red-600">{error}</p>}

      {result && (
        <div className="mt-4 border border-gray-200 p-4">
          <p className="mb-2 text-[12px] font-bold text-gray-700">同期結果</p>
          <dl className="grid grid-cols-4 gap-y-1 text-[12px] text-gray-700">
            <dt className="text-gray-500">対象件数</dt>
            <dd className="col-span-3">{result.total}</dd>
            <dt className="text-gray-500">新規作成</dt>
            <dd className="col-span-3">{result.created}</dd>
            <dt className="text-gray-500">更新</dt>
            <dd className="col-span-3">{result.updated}</dd>
            <dt className="text-gray-500">変更なし</dt>
            <dd className="col-span-3">{result.unchanged}</dd>
            <dt className="text-gray-500">エラー</dt>
            <dd className="col-span-3">{result.failed}</dd>
            <dt className="text-gray-500">画像取込</dt>
            <dd className="col-span-3">{result.imageImported}</dd>
            <dt className="text-gray-500">カテゴリ追加</dt>
            <dd className="col-span-3">{result.categoryCreated}</dd>
            <dt className="text-gray-500">保管場所追加</dt>
            <dd className="col-span-3">{result.locationCreated}</dd>
          </dl>

          {result.items.some((i) => i.warnings.length > 0 || i.status === "failed") && (
            <div className="mt-3 border-t border-gray-100 pt-3">
              <p className="mb-1 text-[11px] font-bold text-gray-500">エラー・警告のある項目</p>
              <ul className="space-y-1 text-[11px] text-gray-600">
                {result.items
                  .filter((i) => i.warnings.length > 0 || i.status === "failed")
                  .map((i) => (
                    <li key={i.zaicoId} className="border-l-2 border-gray-200 pl-2">
                      <span className="font-mono">{i.zaicoId}</span> {i.name}
                      {i.error && <span className="ml-1 text-red-600">— {i.error}</span>}
                      {i.warnings.map((w, idx) => (
                        <div key={idx} className="text-gray-500">
                          ・{w}
                        </div>
                      ))}
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
