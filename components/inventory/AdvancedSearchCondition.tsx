"use client";

import type { SearchCondition } from "@/lib/types";
import { DATE_OPERATORS, NUMBER_OPERATORS, STRING_OPERATORS } from "@/lib/search/fields";
import { CategoryPicker } from "@/components/common/CategoryPicker";
import { LocationPicker } from "@/components/common/LocationPicker";
import { NumberInput } from "@/components/common/NumberInput";
import { DatePicker } from "@/components/common/DatePicker";

/**
 * 詳細検索の1条件ブロック(指示書 §13-3)。
 * 「カテゴリ」「× 削除」「値を選択」「›」の構成。フィールド型に応じて
 * 入力UIを切り替える。
 */
export function AdvancedSearchConditionBlock({
  condition,
  onChange,
  onRemove,
}: {
  condition: SearchCondition;
  onChange: (next: SearchCondition) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-card">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-bold text-bello-900">{condition.label}</span>
        <button
          onClick={onRemove}
          className="tap-target text-sm text-danger-500"
          aria-label={`${condition.label}を削除`}
        >
          × 削除
        </button>
      </div>

      {condition.type === "category" && (
        <CategoryPicker
          label=""
          value={(condition.value as string) ?? null}
          onChange={(id) => onChange({ ...condition, value: id })}
        />
      )}

      {condition.type === "location" && (
        <LocationPicker
          label=""
          value={(condition.value as string) ?? null}
          onChange={(id) => onChange({ ...condition, value: id })}
        />
      )}

      {condition.type === "string" && (
        <div className="space-y-2">
          <OperatorSelect
            options={STRING_OPERATORS}
            value={condition.operator}
            onChange={(op) => onChange({ ...condition, operator: op as SearchCondition["operator"] })}
          />
          <input
            value={(condition.value as string) ?? ""}
            onChange={(e) => onChange({ ...condition, value: e.target.value })}
            placeholder="値を入力"
            className="tap-target w-full rounded-2xl border border-bello-200 px-4 py-3 text-base outline-none focus:border-bello-500"
          />
        </div>
      )}

      {(condition.type === "number" || condition.type === "condition") && (
        <div className="space-y-2">
          <OperatorSelect
            options={NUMBER_OPERATORS}
            value={condition.operator}
            onChange={(op) => onChange({ ...condition, operator: op as SearchCondition["operator"] })}
          />
          <div className="flex gap-2">
            <NumberInput
              value={condition.value as number}
              onChange={(v) => onChange({ ...condition, value: v })}
              min={condition.type === "condition" ? 1 : 0}
            />
            {condition.operator === "range" && (
              <NumberInput
                value={condition.valueTo as number}
                onChange={(v) => onChange({ ...condition, valueTo: v })}
                min={condition.type === "condition" ? 1 : 0}
              />
            )}
          </div>
        </div>
      )}

      {condition.type === "date" && (
        <div className="space-y-2">
          <OperatorSelect
            options={DATE_OPERATORS}
            value={condition.operator}
            onChange={(op) => onChange({ ...condition, operator: op as SearchCondition["operator"] })}
          />
          <div className="flex gap-2">
            <DatePicker
              label=""
              value={condition.value as string}
              onChange={(v) => onChange({ ...condition, value: v })}
            />
            {condition.operator === "range" && (
              <DatePicker
                label=""
                value={condition.valueTo as string}
                onChange={(v) => onChange({ ...condition, valueTo: v })}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function OperatorSelect({
  options,
  value,
  onChange,
}: {
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="tap-target w-full rounded-2xl border border-bello-200 bg-white px-4 py-3 text-base outline-none"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
