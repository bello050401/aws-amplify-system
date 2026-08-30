"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface ExportMenuProps {
  /** Current list filters, used to build the "現在の検索・絞り込み結果" export URL — the exact same q/categoryIds/locationId/statusId the list page itself is showing. */
  currentFilterParams: Record<string, string | undefined>;
}

const PANEL_WIDTH = 360; // spec: 幅320〜420px程度

/**
 * エクスポート操作: 「エクスポート」を押す→メニュー→CSV/Excel×現在の
 * 検索結果/全在庫を選ぶ。実際のファイル生成はapp/api/inventory/export/
 * route.ts (Route Handler)が行う — このコンポーネントはそのURLを組み
 * 立てて`window.location.href`で遷移させるだけ。
 *
 * バグ修正: 以前はこのボタンの真下に`position: absolute`でパネルを直
 * 接描画していたが、InventoryHeader.tsxの`center`スロット
 * (`overflow-x-auto` — 狭い画面でツールバー内容がヘッダー行をはみ出
 * さないようにするためのもの)がその祖先にあり、absoluteなパネルの
 * ボックス自体はそのoverflowコンテナの中に積み上げられる形になって
 * いたため、パネル全体がその小さな枠でクリップされ、「小さなスクロー
 * ル領域だけが出る」という報告どおりの見た目になっていた。
 *
 * 修正方法: パネルをReact Portal (`createPortal`)で`document.body`直下
 * へ描画し、ボタンの`getBoundingClientRect()`から計算した座標へ
 * `position: fixed`で配置する — これでヘッダー側のoverflow-x-autoを
 * 含め、途中のどんな祖先のoverflow/clippingからも完全に独立する。
 * ウィンドウのresize/scroll時は位置を再計算し、右端がビューポート外
 * へはみ出さないようclampする。
 */
export function ExportMenu({ currentFilterParams }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  function computePosition() {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.min(Math.max(8, rect.right - PANEL_WIDTH), window.innerWidth - PANEL_WIDTH - 8);
    setPosition({ top: rect.bottom + 4, left });
  }

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    computePosition();
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", computePosition);
    // capture: true — 途中の任意のスクロール可能な祖先(例えばテーブル
    // 自体)がスクロールしても追従して再計算する。
    window.addEventListener("scroll", computePosition, true);
    return () => {
      window.removeEventListener("resize", computePosition);
      window.removeEventListener("scroll", computePosition, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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

  const optionButtonClass = "border border-gray-300 px-2.5 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50";

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        className="whitespace-nowrap border border-gray-300 px-2 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50"
      >
        エクスポート
      </button>
      {open &&
        position &&
        typeof document !== "undefined" &&
        createPortal(
          <>
            {/* Click-outside to close — a plain full-screen invisible layer under the panel. */}
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div
              className="fixed z-50 border border-gray-300 bg-white p-3 shadow-sm"
              style={{ top: position.top, left: position.left, width: PANEL_WIDTH }}
            >
              <p className="mb-2 text-[12px] font-bold text-gray-700">エクスポート範囲</p>
              <div className="flex flex-col gap-3">
                <div>
                  <p className="mb-1 text-[11px] text-gray-500">現在の検索・絞り込み結果</p>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => download("csv", "filtered")} className={optionButtonClass}>
                      CSV
                    </button>
                    <button type="button" onClick={() => download("xlsx", "filtered")} className={optionButtonClass}>
                      Excel
                    </button>
                  </div>
                </div>
                <div className="border-t border-gray-100 pt-3">
                  <p className="mb-1 text-[11px] text-gray-500">全在庫</p>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => download("csv", "all")} className={optionButtonClass}>
                      CSV
                    </button>
                    <button type="button" onClick={() => download("xlsx", "all")} className={optionButtonClass}>
                      Excel
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
