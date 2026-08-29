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

/** A navigation target is either a literal path (router.push) or the sentinel "BACK" (router.back() — actual browser history, not a reconstructed URL). See InventoryPagination.tsx's CursorPagination for why "← 前へ" needs this instead of a path: reconstructing "the previous page's URL" server-side would require accumulating every visited cursor into the URL itself, which is exactly the unbounded-URL-growth bug (HTTP 431) BELLO統合改修 master指示書(2026-08-29統合改修版) §7 fixed. */
type NavigationTarget = string | "BACK";

interface UnsavedChangesContextValue {
  isDirty: boolean;
  setDirty: (dirty: boolean) => void;
  registerSaveHandler: (fn: (() => Promise<AttemptSaveResult>) | null) => void;
  registerDiscardHandler: (fn: (() => void) | null) => void;
  guardedNavigate: (path: string) => void;
  /** Same guard, but the ultimate navigation is router.back() instead of router.push(path) once resolved (immediately, if not dirty). */
  guardedBack: () => void;
}

const UnsavedChangesContext = createContext<UnsavedChangesContextValue | null>(null);

function runNavigation(router: ReturnType<typeof useRouter>, target: NavigationTarget) {
  if (target === "BACK") router.back();
  else router.push(target);
}

export function UnsavedChangesProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [isDirty, setIsDirtyState] = useState(false);
  const saveHandlerRef = useRef<(() => Promise<AttemptSaveResult>) | null>(null);
  const discardHandlerRef = useRef<(() => void) | null>(null);
  const [dialog, setDialog] = useState<{ target: NavigationTarget; saving: boolean } | null>(null);

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
      if (!isDirty) {
        router.push(path);
        return;
      }
      setDialog({ target: path, saving: false });
    },
    [isDirty, router],
  );

  const guardedBack = useCallback(() => {
    if (!isDirty) {
      router.back();
      return;
    }
    setDialog({ target: "BACK", saving: false });
  }, [isDirty, router]);

  // M: ブラウザ標準の離脱警告（更新/タブを閉じる/URL直接変更） — アプ
  // リ内ナビゲーションのguardedNavigateとは別経路。dirtyな間だけ登録。
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  async function handleSaveAndLeave() {
    if (!dialog) return;
    setDialog((d) => (d ? { ...d, saving: true } : d));
    const fn = saveHandlerRef.current;
    const result = fn ? await fn() : { success: true };
    if (result.success) {
      // I-3: 保存成功 → dirty解除 → 元々向かっていた先へ移動。
      setIsDirtyState(false);
      const target = dialog.target;
      setDialog(null);
      runNavigation(router, target);
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
    setIsDirtyState(false);
    const target = dialog.target;
    setDialog(null);
    runNavigation(router, target);
  }

  function handleCancel() {
    // I-5: ダイアログを閉じ、現在画面に留まり、入力内容はそのまま
    // （何もリセットしない）。
    setDialog(null);
  }

  const value = useMemo<UnsavedChangesContextValue>(
    () => ({ isDirty, setDirty, registerSaveHandler, registerDiscardHandler, guardedNavigate, guardedBack }),
    [isDirty, setDirty, registerSaveHandler, registerDiscardHandler, guardedNavigate, guardedBack],
  );

  return (
    <UnsavedChangesContext.Provider value={value}>
      {children}
      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4">
          <div className="w-full max-w-sm border border-gray-300 bg-white p-4 shadow-lg">
            <p className="text-[13px] font-bold text-gray-900">変更内容が保存されていません。</p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                disabled={dialog.saving}
                onClick={handleSaveAndLeave}
                className="bg-gray-900 px-3 py-1.5 text-[13px] font-bold text-white disabled:opacity-50"
              >
                {dialog.saving ? "保存中…" : "保存して移動"}
              </button>
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
