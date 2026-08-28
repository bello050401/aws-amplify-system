"use client";

import { useState } from "react";
import type { MasterEntry } from "@/lib/inventory/masters";
import { MasterList } from "./MasterList";
import { ListColumnSettings } from "./ListColumnSettings";
import { ZaicoSyncPanel } from "./ZaicoSyncPanel";

interface SettingsTabsProps {
  categories: MasterEntry[];
  locations: MasterEntry[];
  readOnly: boolean;
  /** ZAICO同期タブはADMINにのみ表示する（spec §19: UIレベルのADMIN制限）。実際の書き込み可否はServer Action側（app/actions/zaicoSync.ts）で独立に強制されるため、これは表示上のガードに過ぎない。 */
  isAdmin: boolean;
}

/**
 * Simple sub-tab switch (spec: "タブまたはシンプルなサブメニューで構わ
 * ない") — a plain local state toggle is all these lists need; none of
 * them are ever deep-linked to on their own.
 */
export function SettingsTabs({ categories, locations, readOnly, isAdmin }: SettingsTabsProps) {
  const [tab, setTab] = useState<"category" | "location" | "columns" | "zaico">("category");

  const tabClass = (active: boolean) =>
    `border-b-2 px-3 py-2 text-[13px] ${active ? "border-gray-900 font-bold text-gray-900" : "border-transparent text-gray-500 hover:text-gray-800"}`;

  return (
    <div>
      <div className="flex border-b border-gray-200">
        <button type="button" onClick={() => setTab("category")} className={tabClass(tab === "category")}>
          カテゴリ
        </button>
        <button type="button" onClick={() => setTab("location")} className={tabClass(tab === "location")}>
          保管場所
        </button>
        <button type="button" onClick={() => setTab("columns")} className={tabClass(tab === "columns")}>
          一覧表示設定
        </button>
        {isAdmin && (
          <button type="button" onClick={() => setTab("zaico")} className={tabClass(tab === "zaico")}>
            ZAICO同期
          </button>
        )}
      </div>

      <div className="pt-4">
        {tab === "category" && <MasterList model="Category" label="カテゴリ" entries={categories} readOnly={readOnly} />}
        {tab === "location" && <MasterList model="Location" label="保管場所" entries={locations} readOnly={readOnly} />}
        {tab === "columns" && <ListColumnSettings />}
        {tab === "zaico" && isAdmin && <ZaicoSyncPanel />}
      </div>
    </div>
  );
}
