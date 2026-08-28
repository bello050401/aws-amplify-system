"use client";

import { useCallback, useState } from "react";
import type { AdvancedSearchQuery } from "@/lib/types";

const STORAGE_KEY = "bello-search-state-v1";

export interface PersistedSearchState {
  keyword: string;
  categoryId: string | null;
  advanced: AdvancedSearchQuery | null;
  sort: { field: string; direction: "asc" | "desc" } | null;
}

const DEFAULT_STATE: PersistedSearchState = {
  keyword: "",
  categoryId: null,
  advanced: null,
  sort: null,
};

function readState(): PersistedSearchState {
  if (typeof window === "undefined") return DEFAULT_STATE;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_STATE, ...JSON.parse(raw) } : DEFAULT_STATE;
  } catch {
    return DEFAULT_STATE;
  }
}

function writeState(state: PersistedSearchState) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

/**
 * 在庫一覧の検索条件(キーワード/カテゴリ/詳細検索/並び替え)を
 * 画面遷移をまたいで保持する(指示書 §13-4: 戻っても検索状態を維持)。
 */
export function useSearchState() {
  const [state, setState] = useState<PersistedSearchState>(readState);

  const update = useCallback((patch: Partial<PersistedSearchState>) => {
    setState((prev) => {
      const next = { ...prev, ...patch };
      writeState(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    writeState(DEFAULT_STATE);
    setState(DEFAULT_STATE);
  }, []);

  return { state, update, reset };
}

export function readSearchState(): PersistedSearchState {
  return readState();
}

export function writeSearchState(state: PersistedSearchState): void {
  writeState(state);
}
