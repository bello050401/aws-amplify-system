"use client";

/** 価格入力欄。number keyboardと¥表記(指示書 §11, §22)。 */
export function PriceInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-bello-700">{label}</span>
      <div className="flex items-center rounded-2xl border border-bello-200 bg-white px-4 py-3 focus-within:border-bello-500">
        <span className="mr-2 shrink-0 text-sm font-semibold text-bello-400">¥</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          placeholder={placeholder ?? "0"}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          className="w-full bg-transparent text-base outline-none tap-target"
        />
      </div>
    </label>
  );
}
