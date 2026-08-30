"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

/**
 * 不具合修正・ZAICO同期重複根絶・EC出品UI改善・画像自動加工 完全自律
 * 実装指示書(2026-08-30) §7: 在庫一覧のチェックボックスへ実際の用途を
 * 与えるための選択状態——ヘッダー内のツールバー(InventoryToolbar、
 * InventoryHeaderのcenterスロット)とテーブル本体(InventoryTable)の
 * 間で共有する必要があるため、DirectEditProvider.tsxと全く同じ理由
 * (page.tsxの中で別々の位置に描画される)でContextにする。
 *
 * 選択は「現在ページに表示中の行」に閉じたローカル状態(ページ遷移・
 * フィルタ変更で自然にリセットされる、URLやDBに永続化しない)——
 * ListingsOverviewTable.tsx/EC出品一覧の一括選択と同じ設計判断。
 */
interface InventorySelectionContextValue {
  selected: Set<string>;
  isSelected: (id: string) => boolean;
  toggle: (id: string) => void;
  toggleAll: (ids: string[]) => void;
  clear: () => void;
}

const InventorySelectionContext = createContext<InventorySelectionContextValue | null>(null);

export function InventorySelectionProvider({ children }: { children: React.ReactNode }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const isSelected = useCallback((id: string) => selected.has(id), [selected]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback((ids: string[]) => {
    setSelected((prev) => {
      const allSelected = ids.length > 0 && ids.every((id) => prev.has(id));
      return allSelected ? new Set() : new Set(ids);
    });
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);

  const value = useMemo(() => ({ selected, isSelected, toggle, toggleAll, clear }), [selected, isSelected, toggle, toggleAll, clear]);

  return <InventorySelectionContext.Provider value={value}>{children}</InventorySelectionContext.Provider>;
}

export function useInventorySelection(): InventorySelectionContextValue {
  const ctx = useContext(InventorySelectionContext);
  if (!ctx) throw new Error("useInventorySelection must be used within InventorySelectionProvider");
  return ctx;
}
