"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { MobileHeader } from "@/components/layout/MobileHeader";
import { PickerSheet } from "@/components/common/PickerSheet";
import { AdvancedSearchConditionBlock } from "@/components/inventory/AdvancedSearchCondition";
import { SEARCH_FIELDS } from "@/lib/search/fields";
import { isSearchQueryReady } from "@/lib/search/buildFilter";
import { useSearchState } from "@/lib/hooks/useSearchState";
import type { AdvancedSearchQuery, SearchCondition, SearchField } from "@/lib/types";

function defaultOperator(field: SearchField): SearchCondition["operator"] {
  switch (field.type) {
    case "string":
      return "contains";
    case "number":
    case "condition":
      return "eq";
    case "date":
      return "after";
    default:
      return "eq";
  }
}

/** 詳細検索画面 (指示書 §13)。「検索条件一覧」。 */
export default function AdvancedSearchPage() {
  const router = useRouter();
  const { state, update } = useSearchState();
  const [query, setQuery] = useState<AdvancedSearchQuery>(
    state.advanced ?? { combinator: "AND", conditions: [] }
  );
  const [fieldPickerOpen, setFieldPickerOpen] = useState(false);

  function addField(fieldKey: SearchField["field"]) {
    const field = SEARCH_FIELDS.find((f) => f.field === fieldKey);
    if (!field) return;
    const condition: SearchCondition = {
      id: `${field.field}_${Date.now()}`,
      field: field.field,
      label: field.label,
      type: field.type,
      operator: defaultOperator(field),
      value: null,
      valueTo: null,
    };
    setQuery((q) => ({ ...q, conditions: [...q.conditions, condition] }));
    setFieldPickerOpen(false);
  }

  function updateCondition(id: string, next: SearchCondition) {
    setQuery((q) => ({ ...q, conditions: q.conditions.map((c) => (c.id === id ? next : c)) }));
  }

  function removeCondition(id: string) {
    setQuery((q) => ({ ...q, conditions: q.conditions.filter((c) => c.id !== id) }));
  }

  function handleReset() {
    setQuery({ combinator: "AND", conditions: [] });
  }

  function handleSearch() {
    update({ advanced: query.conditions.length > 0 ? query : null });
    router.push("/inventory");
  }

  const ready = isSearchQueryReady(query);

  return (
    <div className="min-h-screen pb-28">
      <MobileHeader
        title="検索条件一覧"
        right={
          <button
            onClick={() => setFieldPickerOpen(true)}
            className="tap-target text-sm font-semibold text-bello-700"
          >
            条件追加
          </button>
        }
      />

      <div className="space-y-4 px-4 py-4 md:px-0">
        <div className="flex overflow-hidden rounded-full border border-bello-200 bg-white text-sm">
          <button
            onClick={() => setQuery((q) => ({ ...q, combinator: "AND" }))}
            className={`flex-1 py-2.5 font-semibold ${
              query.combinator === "AND" ? "bg-bello-800 text-white" : "text-bello-500"
            }`}
          >
            すべての条件に一致
          </button>
          <button
            onClick={() => setQuery((q) => ({ ...q, combinator: "OR" }))}
            className={`flex-1 py-2.5 font-semibold ${
              query.combinator === "OR" ? "bg-bello-800 text-white" : "text-bello-500"
            }`}
          >
            いずれかの条件に一致
          </button>
        </div>

        <button
          onClick={() => setFieldPickerOpen(true)}
          className="tap-target flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-bello-200 py-4 text-sm font-semibold text-bello-600"
        >
          ＋ 検索条件を追加
        </button>

        {query.conditions.length === 0 && (
          <p className="py-8 text-center text-sm text-bello-400">
            検索条件がまだありません。「検索条件を追加」から選択してください。
          </p>
        )}

        {query.conditions.map((c) => (
          <AdvancedSearchConditionBlock
            key={c.id}
            condition={c}
            onChange={(next) => updateCondition(c.id, next)}
            onRemove={() => removeCondition(c.id)}
          />
        ))}
      </div>

      <div className="pb-safe-nav fixed inset-x-0 bottom-0 z-30 flex gap-3 border-t border-bello-100 bg-white px-4 py-3 md:static md:mt-4 md:border-0 md:bg-transparent md:px-0">
        <button
          onClick={handleReset}
          className="tap-target flex-1 rounded-full border border-bello-200 py-3 text-sm font-semibold text-bello-700"
        >
          リセット
        </button>
        <button
          onClick={handleSearch}
          disabled={!ready}
          className="tap-target flex-1 rounded-full bg-bello-800 py-3 text-sm font-bold text-white disabled:opacity-40"
        >
          検索
        </button>
      </div>

      {fieldPickerOpen && (
        <PickerSheet
          title="検索対象フィールド"
          options={SEARCH_FIELDS.map((f) => ({ id: f.field, label: f.label }))}
          onSelect={(id) => id && addField(id as SearchField["field"])}
          onClose={() => setFieldPickerOpen(false)}
        />
      )}
    </div>
  );
}
