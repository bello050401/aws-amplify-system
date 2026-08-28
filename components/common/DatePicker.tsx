"use client";

import { formatDateOnlyForDisplay } from "@/lib/utils/date";

/**
 * 日付入力(取引年月日・棚卸日等)。iOS Safariのネイティブdate inputを利用し、
 * iPhoneで使い慣れたホイールピッカーをそのまま使う(指示書 §12)。
 * 表示形式は YYYY/MM/DD。内部保存は "YYYY-MM-DD" (タイムゾーンなし)。
 */
export function DatePicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null | undefined;
  onChange: (value: string | null) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-bello-700">{label}</span>
      <div className="relative rounded-2xl border border-bello-200 bg-white px-4 py-3 focus-within:border-bello-500">
        <input
          type="date"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
          className="w-full bg-transparent text-base outline-none tap-target [color-scheme:light]"
        />
      </div>
      <span className="mt-1 block text-xs text-bello-400">
        表示: {formatDateOnlyForDisplay(value)}
      </span>
    </label>
  );
}
