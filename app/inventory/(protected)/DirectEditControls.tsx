"use client";

import { useDirectEdit } from "./DirectEditProvider";

/**
 * The 直接編集 toolbar controls (統合改善指示書 §11/§12) — rendered
 * inside InventoryToolbar, ADMIN/EDITOR only (VIEWER never sees this at
 * all, per canEditInventory gating at the call site). Which buttons show
 * depends on state:
 * - off: a single "直接編集" button to enter the mode.
 * - on, nothing dirty: a single "直接編集を終了" button — nothing to
 *   lose, so no confirmation needed.
 * - on, dirty rows pending: the three explicit actions spec §11 asks
 *   for, plus a small pending-count/result summary. These are NOT the
 *   same as the generic navigation-guard dialog (spec §14, still handled
 *   separately by UnsavedChangesProvider for actual navigation attempts
 *   made while dirty) — they're this mode's own always-visible controls.
 */
export function DirectEditControls() {
  const { enabled, toggleEnabled, dirtyCount, saving, lastResult, saveDirty, saveAndExit, discardAndExit } = useDirectEdit();

  if (!enabled) {
    return (
      <button type="button" onClick={toggleEnabled} className="border border-gray-300 px-2 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50">
        直接編集
      </button>
    );
  }

  if (dirtyCount === 0) {
    return (
      <div className="flex items-center gap-2">
        {lastResult && (
          <span className="text-[11px] text-gray-500">
            {lastResult.successCount}件保存{lastResult.failCount > 0 ? `・${lastResult.failCount}件失敗` : ""}
          </span>
        )}
        <button type="button" onClick={toggleEnabled} className="border border-gray-300 px-2 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50">
          直接編集を終了
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-gray-500">{dirtyCount}件未保存</span>
      <button
        type="button"
        disabled={saving}
        onClick={() => saveDirty()}
        className="border border-gray-900 bg-gray-900 px-2 py-1.5 text-[12px] font-bold text-white disabled:opacity-50"
      >
        {saving ? "保存中…" : "保存する"}
      </button>
      <button
        type="button"
        disabled={saving}
        onClick={() => saveAndExit()}
        className="border border-gray-300 px-2 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-50"
      >
        保存して終了
      </button>
      <button
        type="button"
        disabled={saving}
        onClick={() => {
          if (window.confirm(`${dirtyCount}件の未保存の変更を破棄します。よろしいですか？`)) discardAndExit();
        }}
        className="text-[12px] text-red-500 hover:text-red-700 disabled:opacity-50"
      >
        変更を破棄して終了
      </button>
      {lastResult && lastResult.failCount > 0 && (
        <span className="text-[11px] text-red-600" title={lastResult.errors.map((e) => `${e.name}: ${e.error}`).join("\n")}>
          {lastResult.failCount}件失敗
        </span>
      )}
    </div>
  );
}
