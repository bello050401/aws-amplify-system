"use client";

import type { CustomFieldDefinitionRow } from "@/lib/inventory/queries";
import { DateField } from "../DateField";

/**
 * Shared field primitives for the new-registration and edit forms — pulled
 * out once both forms needed the exact same inputs (spec: editing exposes
 * the same fields as registration, minus SKU). Keeping them here means
 * a future field-level change (validation, styling) doesn't need to be
 * made twice.
 *
 * `size` (BELLO統合改修 master指示書 Phase C: 編集画面のみ大きな
 * 単一カラムフォームへ再設計、詳細画面/新規登録画面は現状維持) — every
 * call defaults to "compact", the exact pre-Phase-C styling (13px input,
 * py-1) — this is what keeps NewInventoryForm.tsx (and everything else
 * that already imports these) pixel-identical to before this Phase.
 * Only EditInventoryForm.tsx passes `size="large"`. This is a shared
 * *component*, not shared *styling*: the field-iteration/definition
 * logic stays in exactly one place (spec §5's own rule) while the two
 * forms render at genuinely different sizes.
 */
export type FieldSize = "compact" | "large";

/** 16-17px font / ~44-48px total height (border included) — master指示書 Phase C's explicit edit-screen input sizing. */
const SIZE_CLASSES: Record<FieldSize, string> = {
  compact: "text-[13px] py-1",
  large: "text-[16px] py-2.5",
};

export function LabeledInput({
  label,
  value,
  onChange,
  type = "text",
  required = false,
  placeholder,
  list,
  size = "compact",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  placeholder?: string;
  /** ネイティブ<input list>属性 — 対応する<datalist id={list}>と組み合わせて、既存の自由入力を維持したまま候補を提示する(夜間開発指示書 §10: 単位マスタ)。 */
  list?: string;
  size?: FieldSize;
}) {
  return (
    <div>
      <label className="block text-[12px] text-gray-600">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </label>
      <input
        type={type}
        value={value}
        required={required}
        placeholder={placeholder}
        list={list}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-0.5 w-full border border-gray-300 px-2.5 focus:border-gray-500 focus:outline-none ${SIZE_CLASSES[size]}`}
      />
    </div>
  );
}

export function LabeledSelect({
  label,
  value,
  onChange,
  options,
  size = "compact",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  size?: FieldSize;
}) {
  return (
    <div>
      <label className="block text-[12px] text-gray-600">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-0.5 w-full border border-gray-300 bg-white px-2.5 focus:border-gray-500 focus:outline-none ${SIZE_CLASSES[size]}`}
      >
        <option value="">未選択</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function CustomFieldInput({
  def,
  value,
  onChange,
  size = "compact",
  /** Phase C: the edit screen's additional-fields section is single-column, so a textarea there never needs the "span both columns" escape hatch a 2-column grid otherwise requires. */
  fullWidthClassName = "col-span-2",
}: {
  def: CustomFieldDefinitionRow;
  value: string;
  onChange: (v: string) => void;
  size?: FieldSize;
  fullWidthClassName?: string;
}) {
  const label = (
    <label className="block text-[12px] text-gray-600">
      {def.label}
      {def.required && <span className="text-red-500"> *</span>}
    </label>
  );
  const fieldClass = `mt-0.5 w-full border border-gray-300 px-2.5 focus:border-gray-500 focus:outline-none ${SIZE_CLASSES[size]}`;

  if (def.fieldType === "TEXTAREA") {
    return (
      <div className={fullWidthClassName}>
        {label}
        <textarea
          value={value}
          required={def.required}
          onChange={(e) => onChange(e.target.value)}
          rows={size === "large" ? 5 : 2}
          className={fieldClass}
        />
      </div>
    );
  }
  if (def.fieldType === "SELECT") {
    return (
      <div>
        {label}
        <select value={value} required={def.required} onChange={(e) => onChange(e.target.value)} className={`bg-white ${fieldClass}`}>
          <option value="">未選択</option>
          {def.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (def.fieldType === "DATE") {
    return (
      <div>
        {label}
        <DateField value={value} required={def.required} onChange={onChange} className={fieldClass} />
      </div>
    );
  }

  const inputType = def.fieldType === "NUMBER" ? "number" : def.fieldType === "URL" ? "url" : "text";
  return (
    <div>
      {label}
      <input type={inputType} value={value} required={def.required} onChange={(e) => onChange(e.target.value)} className={fieldClass} />
    </div>
  );
}
