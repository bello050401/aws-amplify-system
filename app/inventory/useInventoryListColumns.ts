"use client";

import { useCallback, useEffect, useState } from "react";
import { defaultColumnVisibility, INVENTORY_LIST_COLUMNS_STORAGE_KEY } from "@/lib/inventory/listColumns";

export type ColumnVisibility = Record<string, boolean>;

function readStored(): ColumnVisibility {
  const merged = defaultColumnVisibility();
  try {
    const raw = window.localStorage.getItem(INVENTORY_LIST_COLUMNS_STORAGE_KEY);
    if (!raw) return merged;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Only ever override a key this app actually knows about, and only
    // with an actual boolean — a column added later (Phase C) must still
    // come up with its own intended default for a browser whose saved
    // value predates it, rather than silently reading as `undefined`
    // (falsy, i.e. hidden) forever; and any other garbage in a hand-
    // edited or stale-version localStorage value is ignored instead of
    // corrupting `merged`'s type.
    for (const key of Object.keys(merged)) {
      if (typeof parsed[key] === "boolean") merged[key] = parsed[key] as boolean;
    }
    return merged;
  } catch {
    return merged;
  }
}

/**
 * Per-browser (not per-Inventory-record) UI preference — deliberately
 * NOT an Inventory/Amplify Data field (spec: "Inventoryモデルへ追加しな
 * いでください"). localStorage is shared by every Inventory page in this
 * origin, so the exact same setting applies to the plain list and to
 * search-filtered results without any extra plumbing — both render the
 * same InventoryTable, which calls this hook once. Reading only after
 * mount (not from a lazy `useState` initializer) is what makes the
 * server-rendered HTML and the first client render agree — both use
 * `defaultColumnVisibility()` — instead of trying to run localStorage
 * access during SSR, which does not exist server-side. Any real saved
 * preference is then applied on the same tick, imperceptible in
 * practice, matching the standard "theme from localStorage" pattern.
 *
 * `hydrated` distinguishes those two states for a caller that wants to
 * hold off before rendering anything the flip itself would visibly
 * reflow (none of this app's current callers need that yet, but it's
 * cheap to expose from the start rather than needing a signature change
 * for it later).
 */
export function useInventoryListColumns() {
  const [visibility, setVisibilityState] = useState<ColumnVisibility>(defaultColumnVisibility);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setVisibilityState(readStored());
    setHydrated(true);

    // Keeps multiple open tabs in sync — a column toggled from the
    // settings screen in one tab is reflected in a list already open in
    // another, next time it's interacted with, without a manual reload.
    function onStorage(e: StorageEvent) {
      if (e.key === INVENTORY_LIST_COLUMNS_STORAGE_KEY) setVisibilityState(readStored());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setVisibility = useCallback((next: ColumnVisibility) => {
    setVisibilityState(next);
    try {
      window.localStorage.setItem(INVENTORY_LIST_COLUMNS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Best-effort only — a private-browsing/storage-disabled browser
      // just keeps this session's in-memory value instead of persisting
      // it; the list still renders correctly either way.
    }
  }, []);

  return { visibility, setVisibility, hydrated };
}
