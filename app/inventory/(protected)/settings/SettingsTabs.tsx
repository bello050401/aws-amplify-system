"use client";

import { useState } from "react";
import type { MasterEntry } from "@/lib/inventory/masters";
import { MasterList } from "./MasterList";

interface SettingsTabsProps {
  categories: MasterEntry[];
  locations: MasterEntry[];
  readOnly: boolean;
}

/**
 * Simple sub-tab switch (spec: "タブまたはシンプルなサブメニューで構わ
 * ない") — a plain local state toggle is all two lists need; no router
 * segment per tab, since neither list is ever deep-linked to on its own.
 */
export function SettingsTabs({ categories, locations, readOnly }: SettingsTabsProps) {
  const [tab, setTab] = useState<"category" | "location">("category");

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
      </div>

      <div className="pt-4">
        {tab === "category" ? (
          <MasterList model="Category" label="カテゴリ" entries={categories} readOnly={readOnly} />
        ) : (
          <MasterList model="Location" label="保管場所" entries={locations} readOnly={readOnly} />
        )}
      </div>
    </div>
  );
}
