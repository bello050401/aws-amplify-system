"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { listEcPresetsAction } from "@/app/actions/ecListingPresets";
import type { EcChannel } from "@/lib/listing/ecManagement";
import type { EcPreset } from "@/lib/listing/ecPresets";

export function EcPresetPicker({
  channel,
  disabled,
  onApply,
}: {
  channel: EcChannel;
  disabled?: boolean;
  onApply: (preset: EcPreset) => void;
}) {
  const [presets, setPresets] = useState<EcPreset[]>([]),
    [id, setId] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    listEcPresetsAction()
      .then((rows) => {
        if (live) setPresets(rows.filter((p) => p.channel === channel));
      })
      .catch(() => {
        if (live) setError("出品設定を読み込めませんでした。");
      });
    return () => {
      live = false;
    };
  }, [channel]);
  return (
    <div className="my-3 rounded-lg border border-blue-100 bg-blue-50/50 p-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-40 flex-1 text-sm">
          保存した出品設定
          <select
            aria-label="保存した出品設定"
            disabled={disabled}
            value={id}
            onChange={(e) => setId(e.target.value)}
            className="mt-1 block w-full rounded border bg-white p-2"
          >
            <option value="">設定を選択</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={disabled || !id}
          className="rounded border bg-white px-3 py-2 text-sm disabled:opacity-40"
          onClick={() => {
            const p = presets.find((row) => row.id === id);
            if (p) onApply(p);
          }}
        >
          適用
        </button>
        <Link
          className="px-2 py-2 text-sm text-blue-700 underline"
          href="/inventory/settings?tab=ecListing"
        >
          設定を管理
        </Link>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
