"use client";

import { useState } from "react";
import { PickerSheet } from "./PickerSheet";
import { useMasterData } from "@/lib/hooks/useMasterData";

/** 保管場所選択フィールド。編集・検索・数量移動で共通利用(指示書 §15)。 */
export function LocationPicker({
  value,
  onChange,
  label = "保管場所",
}: {
  value: string | null | undefined;
  onChange: (locationId: string | null) => void;
  label?: string;
}) {
  const { locations } = useMasterData();
  const [open, setOpen] = useState(false);
  const selected = locations.find((l) => l.id === value);

  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-bello-700">{label}</span>
      <button
        onClick={() => setOpen(true)}
        className="tap-target flex w-full items-center justify-between rounded-2xl border border-bello-200 bg-white px-4 py-3 text-left text-base"
      >
        <span className={selected ? "flex items-center gap-1 text-bello-900" : "text-bello-400"}>
          {selected ? (
            <>
              <span aria-hidden>📍</span> {selected.name}
            </>
          ) : (
            "保管場所を選択"
          )}
        </span>
        <span className="text-bello-300">›</span>
      </button>
      {open && (
        <PickerSheet
          title="保管場所を選択"
          options={locations.map((l) => ({ id: l.id, label: l.name, sublabel: l.code ?? undefined }))}
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
