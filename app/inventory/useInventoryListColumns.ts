"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  defaultColumnPreferences,
  INVENTORY_LIST_COLUMNS,
  INVENTORY_LIST_COLUMNS_STORAGE_KEY,
  type ColumnPreferences,
  type InventoryListColumnDef,
} from "@/lib/inventory/listColumns";

export type ColumnVisibility = Record<string, boolean>;

function readStored(dynamicColumns: InventoryListColumnDef[], knownKeys: Set<string>): ColumnPreferences {
  const merged = defaultColumnPreferences(dynamicColumns);
  try {
    const raw = window.localStorage.getItem(INVENTORY_LIST_COLUMNS_STORAGE_KEY);
    if (!raw) return merged;
    const parsed = JSON.parse(raw) as Partial<ColumnPreferences> | null;
    if (!parsed || typeof parsed !== "object") return merged;

    // Only ever override a key this app actually knows about, and only
    // with an actual boolean — a column added later must still come up
    // with its own intended default for a browser whose saved value
    // predates it, rather than silently reading as `undefined` (falsy,
    // i.e. hidden) forever; and any other garbage in a hand-edited or
    // stale-version localStorage value is ignored instead of corrupting
    // `merged`'s type.
    if (parsed.visibility && typeof parsed.visibility === "object") {
      for (const key of Object.keys(merged.visibility)) {
        const v = (parsed.visibility as Record<string, unknown>)[key];
        if (typeof v === "boolean") merged.visibility[key] = v;
      }
    }

    // Order: keep only keys this app still knows about, in the saved
    // order, then append any known key the saved order is missing (a
    // newly-added column — including a CustomFieldDefinition created
    // after this browser last saved its order — or a first-time-storing
    // browser) at the end — never let a real column silently disappear
    // from the table because an older saved order predates it.
    if (Array.isArray(parsed.order)) {
      const savedKnown = parsed.order.filter((k): k is string => typeof k === "string" && knownKeys.has(k));
      const missing = merged.order.filter((k) => !savedKnown.includes(k));
      merged.order = [...savedKnown, ...missing];
    }

    // Widths (夜間開発指示書 §13) — 既存のv2形式にはこのキーが存在しな
    // いブラウザがほとんどのはずで、その場合は単にdefaultColumnWidths()
    // のままになる(visibilityと同じ後方互換の考え方)。0以下や非数値は
    // 無視して既定値を維持する(壊れた/手編集されたlocalStorageで列が
    // 潰れて操作不能になるのを防ぐ)。
    if (parsed.widths && typeof parsed.widths === "object") {
      for (const key of Object.keys(merged.widths)) {
        const v = (parsed.widths as Record<string, unknown>)[key];
        if (typeof v === "number" && Number.isFinite(v) && v > 0) merged.widths[key] = v;
      }
    }

    return merged;
  } catch {
    return merged;
  }
}

/**
 * Per-browser (not per-Inventory-record) UI preference — deliberately
 * NOT an Inventory/Amplify Data field. localStorage is shared by every
 * Inventory page in this origin, so the exact same setting applies to
 * the plain list and to search-filtered results without any extra
 * plumbing — both render the same InventoryTable, which calls this hook
 * once. Reading only after mount (not from a lazy `useState` initializer)
 * is what makes the server-rendered HTML and the first client render
 * agree — both use `defaultColumnPreferences()` — instead of trying to
 * run localStorage access during SSR, which does not exist server-side.
 * Any real saved preference is then applied on the same tick,
 * imperceptible in practice, matching the standard "theme from
 * localStorage" pattern.
 *
 * `hydrated` distinguishes those two states for a caller that wants to
 * hold off before rendering anything the flip itself would visibly
 * reflow.
 *
 * `dynamicColumns` (夜間開発指示書 §11): 追加項目(CustomFieldDefinition)
 * をlib/inventory/listColumns.tsのdynamicColumnDefsFromで変換したもの
 * — 呼び出し側(InventoryTable.tsx/ListColumnSettings.tsx)が現在の
 * CustomFieldDefinition一覧から都度生成して渡す。静的列(INVENTORY_LIST_COLUMNS)
 * とまったく同じ仕組み(表示/非表示・順序・幅)で管理されるため、この
 * ファイル自体はCustomFieldの存在を特別扱いしない。
 */
export function useInventoryListColumns(dynamicColumns: InventoryListColumnDef[] = []) {
  const knownKeys = useMemo(
    () => new Set([...INVENTORY_LIST_COLUMNS, ...dynamicColumns].map((c) => c.key)),
    [dynamicColumns],
  );

  const [preferences, setPreferencesState] = useState<ColumnPreferences>(() => defaultColumnPreferences(dynamicColumns));
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setPreferencesState(readStored(dynamicColumns, knownKeys));
    setHydrated(true);

    // Keeps multiple open tabs in sync — a column toggled/reordered from
    // the settings screen in one tab is reflected in a list already open
    // in another, next time it's interacted with, without a manual reload.
    function onStorage(e: StorageEvent) {
      if (e.key === INVENTORY_LIST_COLUMNS_STORAGE_KEY) setPreferencesState(readStored(dynamicColumns, knownKeys));
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knownKeys]);

  function persist(next: ColumnPreferences) {
    setPreferencesState(next);
    try {
      window.localStorage.setItem(INVENTORY_LIST_COLUMNS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Best-effort only — a private-browsing/storage-disabled browser
      // just keeps this session's in-memory value instead of persisting
      // it; the list still renders correctly either way.
    }
  }

  const setVisibility = useCallback(
    (next: ColumnVisibility) => {
      persist({ ...preferences, visibility: next });
    },
    [preferences],
  );

  const setOrder = useCallback(
    (next: string[]) => {
      persist({ ...preferences, order: next });
    },
    [preferences],
  );

  const setWidths = useCallback(
    (next: Record<string, number>) => {
      persist({ ...preferences, widths: next });
    },
    [preferences],
  );

  /** 1列だけ幅を更新する — ドラッグ中に毎フレームpersist()の対象オブジェクト全体を組み直すのを避け、リサイズ操作用に用意した専用ヘルパー。 */
  const setColumnWidth = useCallback(
    (key: string, width: number) => {
      persist({ ...preferences, widths: { ...preferences.widths, [key]: width } });
    },
    [preferences],
  );

  return {
    visibility: preferences.visibility,
    order: preferences.order,
    widths: preferences.widths,
    setVisibility,
    setOrder,
    setWidths,
    setColumnWidth,
    hydrated,
  };
}
