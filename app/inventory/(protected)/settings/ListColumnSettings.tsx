"use client";

import { INVENTORY_LIST_COLUMNS } from "@/lib/inventory/listColumns";
import { useInventoryListColumns } from "../../useInventoryListColumns";

/**
 * Toggles which optional columns InventoryTable renders (spec: 一覧表示
 *列を設定画面から表示/非表示). This is a personal display preference,
 * not master data — unlike the カテゴリ/保管場所 tabs, every role
 * (including VIEWER) can change it for themselves; there is no ADMIN
 * gate here and no Server Action, since nothing is written to the
 * backend at all (see useInventoryListColumns' own comment on why this
 * is localStorage, not an Inventory field). Every checkbox writes
 * through immediately — no separate "save" step to forget to click.
 */
export function ListColumnSettings() {
  const { visibility, setVisibility, hydrated } = useInventoryListColumns();

  function toggle(key: string) {
    setVisibility({ ...visibility, [key]: !visibility[key] });
  }

  function resetToDefaults() {
    setVisibility(Object.fromEntries(INVENTORY_LIST_COLUMNS.map((c) => [c.key, c.defaultVisible])));
  }

  return (
    <div>
      <p className="mb-3 max-w-md text-[12px] text-gray-500">
        在庫一覧・詳細検索結果に表示する列を選べます。この設定はお使いのブラウザに保存され、通常の一覧と検索結果の両方に同じ内容が反映されます。
      </p>
      <ul className="max-w-md divide-y divide-gray-100 border-y border-gray-200">
        {INVENTORY_LIST_COLUMNS.map((col) => (
          <li key={col.key} className="flex items-center justify-between px-1 py-1.5 text-[13px]">
            <span className="text-gray-700">{col.label}</span>
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
