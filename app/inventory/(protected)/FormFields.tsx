"use client";

import type { CustomFieldDefinitionRow } from "@/lib/inventory/queries";

/**
 * Shared field primitives for the new-registration and edit forms — pulled
 * out once both forms needed the exact same inputs (spec: editing exposes
 * the same fields as registration, minus SKU). Keeping them here means
 * a future field-level change (validation, styling) doesn't need to be
 * made twice.
 */

export function LabeledInput({
  label,
  value,
  onChange,
  type = "text",
  required = false,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  placeholder?: string;
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
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
      />
    </div>
  );
}

export function LabeledSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div>
      <label className="block text-[12px] text-gray-600">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5 w-full border border-gray-300 bg-white px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
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
}: {
  def: CustomFieldDefinitionRow;
  value: string;
  onChange: (v: string) => void;
}) {
  const label = (
    <label className="block text-[12px] text-gray-600">
      {def.label}
      {def.required && <span className="text-red-500"> *</span>}
    </label>
  );

  if (def.fieldType === "TEXTAREA") {
    return (
      <div className="col-span-2">
        {label}
        <textarea
          value={value}
          required={def.required}
          onChange={(e) => onChange(e.target.value)}
          rows={2}
          className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
        />
      </div>
    );
  }
  if (def.fieldType === "SELECT") {
    return (
      <div>
        {label}
        <select
          value={value}
          required={def.required}
          onChange={(e) => onChange(e.target.value)}
          className="mt-0.5 w-full border border-gray-300 bg-white px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
        >
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

  const inputType = def.fieldType === "NUMBER" ? "number" : def.fieldType === "DATE" ? "date" : def.fieldType === "URL" ? "url" : "text";
  return (
    <div>
      {label}
      <input
        type={inputType}
        value={value}
        required={def.required}
        onChange={(e) => onChange(e.target.value)}
        className="mt-0.5 w-full border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
      />
    </div>
  );
}
