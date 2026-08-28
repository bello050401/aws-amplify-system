"use client";

import { useState } from "react";

interface ExportMenuProps {
  /** Current list filters, used to build the "現在の検索・絞り込み結果" export URL — the exact same q/categoryIds/locationId/statusId the list page itself is showing. */
  currentFilterParams: Record<string, string | undefined>;
}

/**
 * エクスポート操作 (統合改善指示書 §11-2/§11-3): 「エクスポート」を押
 * す→小さなメニュー→CSV/Excel×現在の検索結果/全在庫を選ぶ、というシ
 * ンプルな操作。実際のファイル生成はapp/api/inventory/export/route.ts
 * (Route Handler)が行う — このコンポーネントはそのURLを組み立てて
 * `window.location.href`で遷移させるだけ(通常のダウンロードとして
 * ブラウザに任せる。fetch+Blobのような追加の仕組みは不要)。
 */
export function ExportMenu({ currentFilterParams }: ExportMenuProps) {
  const [open, setOpen] = useState(false);

  function buildUrl(format: "csv" | "xlsx", scope: "filtered" | "all") {
    const sp = new URLSearchParams();
    sp.set("format", format);
    sp.set("scope", scope);
    if (scope === "filtered") {
      for (const [k, v] of Object.entries(currentFilterParams)) {
        if (v) sp.set(k, v);
      }
    }
    return `/api/inventory/export?${sp.toString()}`;
  }

  function download(format: "csv" | "xlsx", scope: "filtered" | "all") {
    window.location.href = buildUrl(format, scope);
    setOpen(false);
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="border border-gray-300 px-2 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50"
      >
        エクスポート
      </button>
      {open && (
        <>
          {/* Click-outside to close — a plain full-screen invisible layer under the popover, the same lightweight pattern used nowhere else in this app yet but standard for a small menu like this. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-56 border border-gray-300 bg-white p-2 shadow-sm">
            <p className="mb-1 px-1 text-[11px] font-bold text-gray-400">現在の検索・絞り込み結果</p>
            <button type="button" onClick={() => download("csv", "filtered")} className="block w-full px-1 py-1 text-left text-[13px] text-gray-700 hover:bg-gray-50">
              CSVでダウンロード
            </button>
            <button type="button" onClick={() => download("xlsx", "filtered")} className="block w-full px-1 py-1 text-left text-[13px] text-gray-700 hover:bg-gray-50">
              Excelでダウンロード
            </button>
            <p className="mb-1 mt-2 border-t border-gray-100 px-1 pt-2 text-[11px] font-bold text-gray-400">全在庫</p>
            <button type="button" onClick={() => download("csv", "all")} className="block w-full px-1 py-1 text-left text-[13px] text-gray-700 hover:bg-gray-50">
              CSVでダウンロード
            </button>
            <button type="button" onClick={() => download("xlsx", "all")} className="block w-full px-1 py-1 text-left text-[13px] text-gray-700 hover:bg-gray-50">
              Excelでダウンロード
            </button>
          </div>
        </>
      )}
    </div>
  );
}
