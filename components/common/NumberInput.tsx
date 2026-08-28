"use client";

/**
 * 数量・寸法等の数値入力欄。iPhoneでは数値専用キーボードを表示する
 * (inputMode="decimal" / pattern) (指示書 §22)。
 */
export function NumberInput({
  label,
  value,
  onChange,
  suffix,
  min = 0,
  step = "any",
  placeholder,
  required,
}: {
  label?: string;
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  suffix?: string;
  min?: number;
  step?: number | "any";
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      {label && (
        <span className="mb-1 block text-sm font-medium text-bello-700">
          {label}
          {required && <span className="ml-1 text-danger-500">*</span>}
        </span>
      )}
      <div className="flex items-center rounded-2xl border border-bello-200 bg-white px-4 py-3 focus-within:border-bello-500">
        <input
          type="number"
          inputMode="decimal"
          min={min}
          step={step}
          placeholder={placeholder}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          className="w-full bg-transparent text-base outline-none tap-target"
        />
        {suffix && <span className="ml-2 shrink-0 text-sm text-bello-400">{suffix}</span>}
      </div>
    </label>
  );
}
