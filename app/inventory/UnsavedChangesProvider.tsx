"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Shared "don't lose unsaved work" guard (spec I-N), used by
 * /inventory/new and /inventory/[id]/edit today and built to be reused
 * by any future in-app navigation (spec N: "ロゴクリックだけに処理をベ
 * タ書きしない"). One instance, mounted once around the whole
 * /inventory/* route group (see layout.tsx) — every page/nav element
 * shares the same dirty flag and the same confirmation dialog, rather
 * than each guarded link reimplementing its own check.
 *
 * How a form participates:
 * - `setDirty(bool)` whenever its own dirty computation changes (see
 *   app/inventory/formDirtySnapshot.ts for the shared "did anything
 *   actually change from the initial value" logic both forms use).
 * - `registerSaveHandler(fn)` with a no-navigation save attempt
 *   (`createInventory`/`updateInventory` called with
 *   `{ skipRedirect: true }` — see app/actions/inventory.ts) that
 *   returns whether it succeeded. Only called when the user picks
 *   "保存して移動"; the guard itself does the actual navigation
 *   afterward, to wherever the user was originally headed — not
 *   wherever the form's own plain submit button would normally land.
 * - `registerDiscardHandler(fn)` with best-effort cleanup for
 *   "保存せず移動" (spec L: don't leave orphaned S3 objects from images
 *   that were uploaded this session but never actually saved).
 * - Both registrations, and the dirty flag, are cleared automatically on
 *   unmount (leaving the form page for ANY reason clears them) — a form
 *   never needs its own cleanup code for this.
 *
 * How a nav element participates: call `guardedNavigate(path)` instead
 * of `router.push(path)` (or wrap a plain `<Link>` in a small handler
 * that does the same) — see InventoryNavRail.tsx's logo/nav items.
 * When nothing is dirty this is exactly `router.push`, no dialog, no
 * behavioral difference from a plain Link.
 */

interface AttemptSaveResult {
  success: boolean;
}

interface UnsavedChangesContextValue {
  isDirty: boolean;
  setDirty: (dirty: boolean) => void;
  registerSaveHandler: (fn: (() => Promise<AttemptSaveResult>) | null) => void;
  registerDiscardHandler: (fn: (() => void) | null) => void;
  guardedNavigate: (path: string) => void;
  guardedAction: (action: () => void, cancelled?: () => void) => void;
  registerBlocker: (key: string, blocker: { discard: () => void } | null) => void;
}

const UnsavedChangesContext = createContext<UnsavedChangesContextValue | null>(null);

export function UnsavedChangesProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [isDirty, setIsDirtyState] = useState(false);
  const [blockers, setBlockers] = useState<Record<string, { discard: () => void }>>({});
  const hasBlockers = Object.keys(blockers).length > 0;
  const anyDirty = isDirty || hasBlockers;
  const registerBlocker = useCallback((key: string, blocker: { discard: () => void } | null) => {
    setBlockers(previous => {
      if (!blocker && !previous[key]) return previous;
      const next = { ...previous };
      if (blocker) next[key] = blocker; else delete next[key];
      return next;
    });
  }, []);
  const saveHandlerRef = useRef<(() => Promise<AttemptSaveResult>) | null>(null);
  const discardHandlerRef = useRef<(() => void) | null>(null);
  const [dialog, setDialog] = useState<{ targetPath?: string; action?: () => void; cancelled?: () => void; saving: boolean } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const setDirty = useCallback((dirty: boolean) => setIsDirtyState(dirty), []);
  const registerSaveHandler = useCallback((fn: (() => Promise<AttemptSaveResult>) | null) => {
    saveHandlerRef.current = fn;
  }, []);
  const registerDiscardHandler = useCallback((fn: (() => void) | null) => {
    discardHandlerRef.current = fn;
  }, []);

  // I-1/I-2: dirtyでなければ即座に遷移、dirtyなら3択ダイアログ。
  const guardedNavigate = useCallback(
    (path: string) => {
      if (!anyDirty) {
        router.push(path);
        return;
      }
      setDialog({ targetPath: path, saving: false });
    },
    [anyDirty, router],
  );
  const guardedAction = useCallback((action: () => void, cancelled?: () => void) => {
    if (!anyDirty) { action(); return; }
    setDialog({action, cancelled, saving: false});
  }, [anyDirty]);
  useEffect(() => { if (dialog) dialogRef.current?.focus(); }, [Boolean(dialog)]);

  // M: ブラウザ標準の離脱警告（更新/タブを閉じる/URL直接変更） — アプ
  // リ内ナビゲーションのguardedNavigateとは別経路。dirtyな間だけ登録。
  useEffect(() => {
    if (!anyDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [anyDirty]);

  // The staff app embeds this route. The close request must originate in its
  // same-origin parent; it must never silently discard an open bulk preview.
  useEffect(() => {
    if (window.parent === window) return;
    const closeRequest = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent ||
          event.data?.type !== "bello:inventory-close-request") return;
      const respond = (allowed: boolean) => window.parent.postMessage({type: "bello:inventory-close-response", requestId: event.data.requestId, allowed}, window.location.origin);
      window.parent.postMessage({type: "bello:inventory-close-pending", requestId: event.data.requestId}, window.location.origin);
      guardedAction(() => respond(true), () => respond(false));
    };
    window.addEventListener("message", closeRequest);
    return () => window.removeEventListener("message", closeRequest);
  }, [guardedAction]);

  async function handleSaveAndLeave() {
    if (!dialog || hasBlockers || !dialog.targetPath) return;
    setDialog((d) => (d ? { ...d, saving: true } : d));
    const fn = saveHandlerRef.current;
    let result: AttemptSaveResult;
    try {
      result = fn ? await fn() : { success: false };
    } catch {
      // 保存処理自体が例外を投げた場合(ネットワーク断など、フォーム側が
      // { success: false } を返す通常の失敗とは違い、そもそもawaitが
      // 完了しない経路)。ここでcatchしないとこの関数がrejectしたまま
      // 終わり、ダイアログがsaving:trueに固定され(3ボタンとも
      // disabled)、ユーザーがキャンセルすら押せなくなる。通常の保存
      // 失敗(I-3のコメント参照)と同じ扱い — 移動せずダイアログを
      // 閉じて現在画面に留まる。
      setDialog(null);
      return;
    }
    if (result.success) {
      // I-3: 保存成功 → dirty解除 → 元々向かっていた先へ移動。
      setIsDirtyState(false);
      const target = dialog.targetPath;
      setDialog(null);
      if (target) router.push(target);
    } else {
      // I-3: 保存失敗時は移動しない。フォーム自身の保存処理が既に自分の
      // エラーstateをセットしているはずなので（app/actions/inventory.ts
      // をskipRedirect:trueで呼ぶ各フォームのattemptSave参照）、ここで
      // 別のエラーUIを重ねて出さず、ダイアログを閉じて現在画面に留まる
      // だけでよい。
      setDialog(null);
    }
  }

  function handleDiscardAndLeave() {
    if (!dialog) return;
    // I-4/L: 未保存の画像アップロード等をベストエフォートで破棄してから
    // 移動。追加確認なし。
    discardHandlerRef.current?.();
    Object.values(blockers).forEach(blocker => blocker.discard());
    setBlockers({});
    setIsDirtyState(false);
    const target = dialog.targetPath;
    const action = dialog.action;
    setDialog(null);
    if (target) router.push(target); else action?.();
  }

  function handleCancel() {
    // I-5: ダイアログを閉じ、現在画面に留まり、入力内容はそのまま
    // （何もリセットしない）。
    dialog?.cancelled?.();
    setDialog(null);
  }

  const value = useMemo<UnsavedChangesContextValue>(
    () => ({ isDirty: anyDirty, setDirty, registerSaveHandler, registerDiscardHandler, guardedNavigate, guardedAction, registerBlocker }),
    [anyDirty, setDirty, registerSaveHandler, registerDiscardHandler, guardedNavigate, guardedAction, registerBlocker],
  );

  return (
    <UnsavedChangesContext.Provider value={value}>
      {children}
      {dialog && (
        <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="未保存の変更" className="fixed inset-0 z-[120] flex items-center justify-center bg-black/30 px-4" onKeyDown={event => {
          if (event.key === 'Escape' && !dialog.saving) { event.preventDefault(); handleCancel(); }
          if (event.key === 'Tab') {
            const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
            if (event.shiftKey && (document.activeElement === controls[0] || document.activeElement === dialogRef.current)) { event.preventDefault(); controls.at(-1)?.focus(); }
            else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
          }
        }}>
          <div className="w-full max-w-sm border border-gray-300 bg-white p-4 shadow-lg">
            <p className="text-[13px] font-bold text-gray-900">変更内容が保存されていません。</p>
            <div className="mt-4 flex flex-col gap-2">
              {!hasBlockers && dialog.targetPath && <button
                type="button"
                disabled={dialog.saving}
                onClick={handleSaveAndLeave}
                className="bg-gray-900 px-3 py-1.5 text-[13px] font-bold text-white disabled:opacity-50"
              >
                {dialog.saving ? "保存中…" : "保存して移動"}
              </button>}
              <button
                type="button"
                disabled={dialog.saving}
                onClick={handleDiscardAndLeave}
                className="border border-gray-300 px-3 py-1.5 text-[13px] text-gray-700 disabled:opacity-50"
              >
                保存せず移動
              </button>
              <button
                type="button"
                disabled={dialog.saving}
                onClick={handleCancel}
                className="px-1 py-1 text-center text-[12px] text-gray-500 hover:text-gray-900 disabled:opacity-50"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
    </UnsavedChangesContext.Provider>
  );
}

/**
 * A page/component outside the /inventory/* route group (or a test)
 * would get `null` from useContext — throwing here rather than silently
 * no-op-ing means a missing Provider is caught immediately in
 * development, not discovered later as "the guard just doesn't work".
 */
export function useUnsavedChanges(): UnsavedChangesContextValue {
  const ctx = useContext(UnsavedChangesContext);
  if (!ctx) throw new Error("useUnsavedChanges must be used within UnsavedChangesProvider (app/inventory/(protected)/layout.tsx)");
  return ctx;
}
