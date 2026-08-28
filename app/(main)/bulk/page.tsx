"use client";

import { useEffect, useState } from "react";
import { MobileHeader } from "@/components/layout/MobileHeader";
import { CategoryPicker } from "@/components/common/CategoryPicker";
import { LocationPicker } from "@/components/common/LocationPicker";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { toErrorMessage } from "@/components/common/ErrorState";
import { getInventoryService } from "@/lib/api";
import { useAuth } from "@/lib/auth/AuthProvider";
import type { Item } from "@/lib/types";
import { SearchIcon } from "@/components/icons";

type BulkAction = "category" | "location" | "status";

/** 一括操作画面(指示書 §20)。複数選択してカテゴリ/保管場所/状態を一括変更。 */
export default function BulkPage() {
  const { user } = useAuth();
  const [keyword, setKeyword] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<BulkAction>("category");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const service = getInventoryService();
    service.searchItems({ keyword, pageSize: 50 }).then((res) => setItems(res.items));
  }, [keyword]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function applyBulk() {
    setBusy(true);
    setError(null);
    try {
      const patch =
        action === "category"
          ? { categoryId }
          : action === "location"
            ? { locationId }
            : { status: status || null };
      const count = await getInventoryService().bulkUpdate(
        Array.from(selected),
        patch as never,
        user?.email ?? "unknown"
      );
      setMessage(`${count}件の在庫を一括更新しました`);
      setSelected(new Set());
    } catch (e) {
      setError(toErrorMessage(e));
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  }

  return (
    <div className="pb-32">
      <MobileHeader title="一括操作" />

      <div className="space-y-4 px-4 py-4 md:px-0">
        {message && <p className="rounded-2xl bg-bello-100 px-4 py-3 text-sm font-medium text-bello-800">{message}</p>}
        {error && <p className="rounded-2xl bg-danger-50 px-4 py-3 text-sm text-danger-600">{error}</p>}

        <div className="flex items-center gap-2 rounded-full border border-bello-200 bg-white px-4 py-3">
          <SearchIcon className="h-5 w-5 text-bello-300" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="対象の在庫を検索"
            className="w-full bg-transparent text-base outline-none"
          />
        </div>

        <p className="text-xs text-bello-400">{selected.size}件選択中</p>

        <div className="max-h-80 space-y-2 overflow-y-auto">
          {items.map((item) => (
            <label
              key={item.id}
              className="tap-target flex items-center gap-3 rounded-2xl bg-white p-3 shadow-card"
            >
              <input
                type="checkbox"
                checked={selected.has(item.id)}
                onChange={() => toggle(item.id)}
                className="h-5 w-5 accent-bello-700"
              />
              <span className="flex-1 truncate text-sm font-medium text-bello-900">{item.name}</span>
            </label>
          ))}
        </div>

        <section className="space-y-3 rounded-2xl bg-white p-4 shadow-card">
          <h2 className="text-sm font-bold text-bello-800">一括変更する項目</h2>
          <div className="flex gap-2 text-sm">
            {(["category", "location", "status"] as BulkAction[]).map((a) => (
              <button
                key={a}
                onClick={() => setAction(a)}
                className={`flex-1 rounded-full border py-2 font-semibold ${
                  action === a ? "border-bello-800 bg-bello-800 text-white" : "border-bello-200 text-bello-600"
                }`}
              >
                {a === "category" ? "カテゴリ" : a === "location" ? "保管場所" : "状態"}
              </button>
            ))}
          </div>

          {action === "category" && <CategoryPicker value={categoryId} onChange={setCategoryId} />}
          {action === "location" && <LocationPicker value={locationId} onChange={setLocationId} />}
          {action === "status" && (
            <input
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              placeholder="変更後の状態"
              className="tap-target w-full rounded-2xl border border-bello-200 px-4 py-3 text-base outline-none"
            />
          )}
        </section>
      </div>

      <div className="pb-safe-nav fixed inset-x-0 bottom-0 z-30 border-t border-bello-100 bg-white px-4 py-3 md:static md:border-0 md:bg-transparent md:px-0">
        <button
          onClick={() => setConfirmOpen(true)}
          disabled={selected.size === 0}
          className="tap-target w-full rounded-full bg-bello-800 py-3.5 text-base font-bold text-white disabled:opacity-40"
        >
          {selected.size}件へ一括適用
        </button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="一括変更を実行しますか?"
        description={`選択した${selected.size}件に変更を適用します。`}
        danger
        loading={busy}
        confirmLabel="適用する"
        onConfirm={applyBulk}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
