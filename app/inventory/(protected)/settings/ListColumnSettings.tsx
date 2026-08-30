"use client";

import { useMemo } from "react";
import { INVENTORY_LIST_COLUMNS, defaultColumnWidths, dynamicColumnDefsFrom, type InventoryListColumnDef } from "@/lib/inventory/listColumns";
import type { CustomFieldDefinitionRow } from "@/lib/inventory/queries";
import { useInventoryListColumns } from "../../useInventoryListColumns";

interface ListColumnSettingsProps {
  /** 追加項目(CustomFieldDefinition)を動的な一覧列としてトグル対象へ含める(夜間開発指示書 §11)。 */
  customFieldDefs: CustomFieldDefinitionRow[];
}

/**
 * Toggles which optional columns InventoryTable renders, and their
 * display order (統合改善指示書 §10: 表示する項目/表示しない項目/カラ
 * ム順序). This is a personal display preference, not master data —
 * unlike the カテゴリ/保管場所 タブ, every role (including VIEWER) can
 * change it for themselves; there is no ADMIN gate here and no Server
 * Action, since nothing is written to the backend at all (see
 * useInventoryListColumns' own comment on why this is localStorage, not
 * an Inventory field). Every checkbox/↑↓ writes through immediately —
 * no separate "save" step to forget to click.
 *
 * Reordering is ↑/↓ per row, not drag-and-drop — spec explicitly offers
 * either; ↑/↓ matches the exact pattern ImageEditor.tsx already uses for
 * reordering images, so this doesn't introduce a second reordering
 * idiom or a drag-and-drop library into the app for one settings list.
 * (在庫一覧本体の列"幅"はマウスドラッグでのリサイズ機能を一度実装した
 * 後、ユーザー指示により撤回・削除した — 各列の幅はlib/inventory/
 * listColumns.tsのdefaultWidthのみで決まる。ここの「初期設定に戻す」
 * は表示/非表示・順序に加え、そのdefaultWidthへも明示的にリセットする。)
 *
 * `customFieldDefs`(夜間開発指示書 §11) — 追加項目もInventoryTable.tsx
 * と全く同じ仕組み(dynamicColumnDefsFrom)で列候補に混ざる。ADMINが追
 *加項目を新設すればコード変更なしにここへも現れる。
 */
export function ListColumnSettings({ customFieldDefs }: ListColumnSettingsProps) {
  const dynamicColumns: InventoryListColumnDef[] = useMemo(() => dynamicColumnDefsFrom(customFieldDefs), [customFieldDefs]);
  const { visibility, order, setVisibility, setOrder, setWidths, hydrated } = useInventoryListColumns(dynamicColumns);
  const columnByKey = new Map([...INVENTORY_LIST_COLUMNS, ...dynamicColumns].map((c) => [c.key, c]));
  const orderedColumns = order.map((key) => columnByKey.get(key)).filter((c): c is NonNullable<typeof c> => Boolean(c));

  function toggle(key: string) {
    setVisibility({ ...visibility, [key]: !visibility[key] });
  }

  function move(key: string, direction: -1 | 1) {
    const index = order.indexOf(key);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
  }

  function resetToDefaults() {
    const allColumns = [...INVENTORY_LIST_COLUMNS, ...dynamicColumns];
    setVisibility(Object.fromEntries(allColumns.map((c) => [c.key, c.defaultVisible])));
    setOrder(allColumns.map((c) => c.key));
    setWidths(defaultColumnWidths(dynamicColumns));
  }

  return (
    <div>
      <p className="mb-3 max-w-md text-[12px] text-gray-500">
        在庫一覧・詳細検索結果に表示する列と順序を選べます。この設定はお使いのブラウザに保存され、通常の一覧と検索結果の両方に同じ内容が反映されます。
      </p>
      <ul className="max-w-md divide-y divide-gray-100 border-y border-gray-200">
        {orderedColumns.map((col, index) => (
          <li key={col.key} className="flex items-center justify-between gap-2 px-1 py-1.5 text-[13px]">
            <div className="flex items-center gap-1 text-[10px] text-gray-400">
              <button
                type="button"
                onClick={() => move(col.key, -1)}
                disabled={index === 0}
                aria-label={`${col.label}を上へ`}
                // CustomFieldSettings.tsx と同じ理由 — グリフだけだと
                // 実測13x20pxで、モバイルでは隣と押し分けられない。
                className="inline-flex min-h-8 min-w-8 items-center justify-center disabled:text-gray-200"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => move(col.key, 1)}
                disabled={index === orderedColumns.length - 1}
                aria-label={`${col.label}を下へ`}
                className="inline-flex min-h-8 min-w-8 items-center justify-center disabled:text-gray-200"
              >
                ↓
              </button>
            </div>
            <span className="flex-1 text-gray-700">
              {col.label}
              {col.key.startsWith("cf:") && <span className="ml-1 text-[10px] text-gray-400">（追加項目）</span>}
            </span>
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={visibility[col.key] ?? col.defaultVisible}
                onChange={() => toggle(col.key)}
                disabled={!hydrated}
                className="h-3.5 w-3.5"
              />
              <span className="text-[11px] text-gray-400">{(visibility[col.key] ?? col.defaultVisible) ? "表示" : "非表示"}</span>
            </label>
          </li>
        ))}
      </ul>
      <button type="button" onClick={resetToDefaults} className="mt-3 text-[12px] text-gray-500 hover:text-gray-900 hover:underline">
        初期設定に戻す
      </button>
    </div>
  );
}
