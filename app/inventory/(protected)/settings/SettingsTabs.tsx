"use client";

import { useState } from "react";
import type { MasterEntry } from "@/lib/inventory/masters";
import type { CustomFieldDefinitionRow } from "@/lib/inventory/queries";
import { MasterList } from "./MasterList";
import { CustomFieldSettings } from "./CustomFieldSettings";
import { ListColumnSettings } from "./ListColumnSettings";
import { ZaicoSyncPanel } from "./ZaicoSyncPanel";

interface SettingsTabsProps {
  categories: MasterEntry[];
  locations: MasterEntry[];
  units: MasterEntry[];
  customFields: CustomFieldDefinitionRow[];
  readOnly: boolean;
  /** ZAICO同期タブはADMINにのみ表示する（spec §19: UIレベルのADMIN制限）。実際の書き込み可否はServer Action側（app/actions/zaicoSync.ts）で独立に強制されるため、これは表示上のガードに過ぎない。 */
  isAdmin: boolean;
  /** サーバー環境変数ZAICO_API_TOKENが設定済みかどうか — 真偽値のみ、トークン本体は一切渡らない（page.tsxのisZaicoConnected()参照）。 */
  zaicoConnected: boolean;
}

/**
 * Simple sub-tab switch (spec: "タブまたはシンプルなサブメニューで構わ
 * ない") — a plain local state toggle is all these lists need; none of
 * them are ever deep-linked to on their own. 夜間開発指示書 §10:
 * 「設定を最低限：カテゴリ・単位・保管場所・追加項目・一覧表示設定・
 * ZAICO同期に整理」に合わせたタブ構成。
 */
export function SettingsTabs({ categories, locations, units, customFields, readOnly, isAdmin, zaicoConnected }: SettingsTabsProps) {
  const [tab, setTab] = useState<"category" | "unit" | "location" | "customFields" | "columns" | "zaico">("category");

  const tabClass = (active: boolean) =>
    `border-b-2 px-3 py-2 text-[13px] ${active ? "border-gray-900 font-bold text-gray-900" : "border-transparent text-gray-500 hover:text-gray-800"}`;

  return (
    <div>
      <div className="flex flex-wrap border-b border-gray-200">
        <button type="button" onClick={() => setTab("category")} className={tabClass(tab === "category")}>
          カテゴリ
        </button>
        <button type="button" onClick={() => setTab("unit")} className={tabClass(tab === "unit")}>
          単位
        </button>
        <button type="button" onClick={() => setTab("location")} className={tabClass(tab === "location")}>
          保管場所
        </button>
        <button type="button" onClick={() => setTab("customFields")} className={tabClass(tab === "customFields")}>
          追加項目
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
        {tab === "unit" && <MasterList model="Unit" label="単位" entries={units} readOnly={readOnly} />}
        {tab === "location" && <MasterList model="Location" label="保管場所" entries={locations} readOnly={readOnly} />}
        {tab === "customFields" && <CustomFieldSettings fields={customFields} readOnly={readOnly} />}
        {/* 一覧表示設定の列候補には無効化された追加項目を含めない(新規登録/編集/詳細検索から消えるのと同じ扱い)。 */}
        {tab === "columns" && <ListColumnSettings customFieldDefs={customFields.filter((f) => f.isActive)} />}
        {tab === "zaico" && isAdmin && <ZaicoSyncPanel zaicoConnected={zaicoConnected} />}
      </div>
    </div>
  );
}
