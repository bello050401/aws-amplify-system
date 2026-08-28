"use client";

import { useMemo, useState } from "react";

export interface PickerOption {
  id: string;
  label: string;
  sublabel?: string;
}

/**
 * カテゴリ選択・保管場所選択で共通利用する汎用選択シート(指示書 §14, §15, §29)。
 * フラット一覧・選択・選択解除・戻るのみに対応(既存がフラット管理の場合、
 * 無理に階層UIを追加しない、との方針に合わせる)。
 */
export function PickerSheet({
  title,
  options,
  selectedId,
  onSelect,
  onClose,
  emptyLabel = "登録がありません",
}: {
  title: string;
  options: PickerOption[];
  selectedId?: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
  emptyLabel?: string;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      <header className="safe-top flex items-center gap-3 border-b border-bello-100 px-4 py-3">
        <button onClick={onClose} className="tap-target text-lg text-bello-700" aria-label="戻る">
          ←
        </button>
        <h1 className="flex-1 text-center text-base font-bold text-bello-900">{title}</h1>
        <div className="w-11" />
      </header>

      <div className="border-b border-bello-100 px-4 py-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="絞り込み"
          className="tap-target w-full rounded-full bg-bello-50 px-4 py-2 text-sm outline-none"
        />
      </div>

      <div className="flex-1 overflow-y-auto pb-safe-nav">
        <button
          onClick={() => onSelect(null)}
          className="tap-target flex w-full items-center justify-between border-b border-bello-50 px-4 py-4 text-left text-sm text-bello-500"
        >
          選択解除(すべて)
          {!selectedId && <span className="text-bello-600">✓</span>}
        </button>
        {filtered.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-bello-400">{emptyLabel}</p>
        )}
        {filtered.map((opt) => (
          <button
            key={opt.id}
            onClick={() => onSelect(opt.id)}
            className="tap-target flex w-full items-center justify-between border-b border-bello-50 px-4 py-4 text-left"
          >
            <span>
              <span className="block text-sm font-medium text-bello-900">{opt.label}</span>
              {opt.sublabel && <span className="block text-xs text-bello-400">{opt.sublabel}</span>}
            </span>
            {selectedId === opt.id && <span className="text-bello-600">✓</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
