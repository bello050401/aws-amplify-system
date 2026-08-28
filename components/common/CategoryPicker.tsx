"use client";

import { useState } from "react";
import { PickerSheet } from "./PickerSheet";
import { useMasterData } from "@/lib/hooks/useMasterData";

/**
 * カテゴリ選択フィールド。検索画面・詳細検索・編集画面で同一コンポーネントを
 * 再利用する(指示書 §14)。
 */
export function CategoryPicker({
  value,
  onChange,
  label = "カテゴリ",
}: {
  value: string | null | undefined;
  onChange: (categoryId: string | null) => void;
  label?: string;
}) {
  const { categories } = useMasterData();
  const [open, setOpen] = useState(false);
  const selected = categories.find((c) => c.id === value);

  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-bello-700">{label}</span>
      <button
        onClick={() => setOpen(true)}
        className="tap-target flex w-full items-center justify-between rounded-2xl border border-bello-200 bg-white px-4 py-3 text-left text-base"
      >
        <span className={selected ? "text-bello-900" : "text-bello-400"}>
          {selected ? selected.name : "カテゴリを選択"}
        </span>
        <span className="text-bello-300">›</span>
      </button>
      {open && (
        <PickerSheet
          title="カテゴリを選択"
          options={categories.map((c) => ({ id: c.id, label: c.name }))}
          selectedId={value}
          onSelect={(id) => {
            onChange(id);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
