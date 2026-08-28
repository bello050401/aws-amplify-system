"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  bulkDeleteMasterEntriesAction,
  createMasterEntryAction,
  deleteMasterEntryAction,
  renameMasterEntryAction,
  reorderMasterEntriesAction,
  setMasterEntryActiveAction,
} from "@/app/actions/masters";
import type { MasterEntry, MasterModelName } from "@/lib/inventory/masters";

interface MasterListProps {
  model: MasterModelName;
  label: string; // "カテゴリ" / "保管場所" — used in copy only
  entries: MasterEntry[];
  readOnly: boolean;
}

/**
 * One model's (Category or Location) list — add / rename / reorder /
 * enable-disable / delete. Every mutation goes through a Server Action in
 * app/actions/masters.ts (ADMIN-enforced there and, independently, by the
 * schema itself), then `router.refresh()` re-pulls the settings page's
 * server-fetched entries so this always reflects what's actually saved
 * rather than trusting its own optimistic guess.
 *
 * High-density plain table, matching the rest of the Inventory UI (see
 * InventoryTable.tsx) — no cards/shadows/animation.
 */
export function MasterList({ model, label, entries, readOnly }: MasterListProps) {
  const router = useRouter();
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<void>) {
    setError(null);
    startTransition(async () => {
      try {
        await action();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "操作に失敗しました。");
      }
    });
  }

  function handleAdd() {
    const trimmed = newName.trim();
    if (!trimmed) return;
    run(async () => {
      await createMasterEntryAction(model, trimmed);
      setNewName("");
    });
  }

  function startEdit(entry: MasterEntry) {
    setEditingId(entry.id);
    setEditingName(entry.name);
  }

  function commitEdit() {
    const id = editingId;
    const trimmed = editingName.trim();
    if (!id || !trimmed) {
      setEditingId(null);
      return;
    }
    run(async () => {
      await renameMasterEntryAction(model, id, trimmed);
      setEditingId(null);
    });
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= entries.length) return;
    const next = [...entries];
    [next[index], next[target]] = [next[target], next[index]];
    run(() => reorderMasterEntriesAction(model, next.map((e) => e.id)));
  }

  function toggleActive(entry: MasterEntry) {
    run(() => setMasterEntryActiveAction(model, entry.id, !entry.isActive));
  }

  function handleDelete(entry: MasterEntry) {
    if (!window.confirm(`「${entry.name}」を削除します。この操作は元に戻せません。よろしいですか？`)) return;
    run(async () => {
      await deleteMasterEntryAction(model, entry.id);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(entry.id);
        return next;
      });
    });
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelectedIds(new Set(entries.map((e) => e.id)));
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  /**
   * Phase C.5 §1 — unused ids get physically deleted, in-use ids get
   * deactivated instead of blocking the whole batch, and only a real
   * error lands in "できなかったもの" — see
   * lib/inventory/masters.ts's bulkDeleteMasterEntries for the exact
   * rule. Reports all three counts back in one line rather than a
   * silent success/failure, per spec.
   */
  function handleBulkDelete() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!window.confirm(`選択した${ids.length}件の${label}を削除します。使用中のものは無効化されます。よろしいですか？`)) return;
    setResultMessage(null);
    setError(null);
    startTransition(async () => {
      try {
        const result = await bulkDeleteMasterEntriesAction(model, ids);
        setResultMessage(`削除 ${result.deletedIds.length}件・無効化 ${result.deactivatedIds.length}件・失敗 ${result.failed.length}件`);
        clearSelection();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "一括削除に失敗しました。");
      }
    });
  }

  return (
    <div>
      {readOnly && (
        <p className="mb-3 border border-gray-200 bg-gray-50 px-3 py-2 text-[12px] text-gray-500">
          閲覧のみです。{label}の追加・変更にはADMIN権限が必要です。
        </p>
      )}

      {!readOnly && (
        <div className="mb-3 flex gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder={`新しい${label}名`}
            className="w-64 border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={handleAdd}
            disabled={pending || !newName.trim()}
            className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            追加
          </button>
        </div>
      )}

      {error && <p className="mb-3 text-[12px] text-red-600">{error}</p>}
      {resultMessage && <p className="mb-3 text-[12px] text-gray-600">{resultMessage}</p>}

      {!readOnly && entries.length > 0 && (
        <div className="mb-2 flex items-center gap-3 text-[12px] text-gray-600">
          <button type="button" onClick={selectAll} className="hover:text-gray-900 hover:underline">
            全選択
          </button>
          <button type="button" onClick={clearSelection} className="hover:text-gray-900 hover:underline">
            選択解除
          </button>
          <span>{selectedIds.size}件選択中</span>
          <button
            type="button"
            onClick={handleBulkDelete}
            disabled={pending || selectedIds.size === 0}
            className="border border-red-200 px-2 py-0.5 text-red-500 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            選択した{label}を削除
          </button>
        </div>
      )}

      <table className="w-full max-w-xl border-collapse text-[13px]">
        <thead className="text-left text-[11px] text-gray-400">
          <tr className="border-b border-gray-200">
            {!readOnly && <th className="w-6 py-1.5"></th>}
            <th className="w-14 py-1.5 font-normal">並び順</th>
            <th className="py-1.5 font-normal">名称</th>
            <th className="w-16 py-1.5 font-normal">状態</th>
            {!readOnly && <th className="w-40 py-1.5 font-normal">操作</th>}
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 && (
            <tr>
              <td colSpan={readOnly ? 3 : 5} className="py-4 text-center text-gray-400">
                データがありません。
              </td>
            </tr>
          )}
          {entries.map((entry, index) => (
            <tr key={entry.id} className={`border-b border-gray-100 ${entry.isActive ? "" : "text-gray-400"}`}>
              {!readOnly && (
                <td className="py-1.5">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(entry.id)}
                    onChange={() => toggleSelected(entry.id)}
                    aria-label={`${entry.name} を選択`}
                  />
                </td>
              )}
              <td className="py-1.5">
                <div className="flex gap-1">
                  <button type="button" onClick={() => move(index, -1)} disabled={readOnly || pending || index === 0} className="disabled:text-gray-200">
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={readOnly || pending || index === entries.length - 1}
                    className="disabled:text-gray-200"
                  >
                    ↓
                  </button>
                </div>
              </td>
              <td className="py-1.5 pr-3">
                {editingId === entry.id ? (
                  <input
                    autoFocus
                    type="text"
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit();
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    onBlur={commitEdit}
                    className="w-48 border border-gray-400 px-1.5 py-0.5 text-[13px] focus:outline-none"
                  />
                ) : (
                  <span className={!readOnly ? "cursor-pointer hover:underline" : ""} onClick={() => !readOnly && startEdit(entry)}>
                    {entry.name}
                  </span>
                )}
              </td>
              <td className="py-1.5">
                {/* One control, not a static badge plus a separate
                    "無効化"/"有効化" action link — clicking this pill IS
                    the toggle; its own label+dot already show the
                    current state, so there's nothing else to show or
                    click separately. Read-only viewers get the same pill
                    minus the click (disabled, no hover affordance). */}
                <button
                  type="button"
                  onClick={() => toggleActive(entry)}
                  disabled={readOnly || pending}
                  title={readOnly ? undefined : entry.isActive ? "クリックで無効化" : "クリックで有効化"}
                  className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-[11px] ${
                    entry.isActive ? "border-gray-300 text-gray-600" : "border-gray-200 text-gray-400"
                  } ${readOnly ? "" : "hover:bg-gray-50"}`}
                >
                  <span>{entry.isActive ? "有効" : "無効"}</span>
                  <span aria-hidden="true">{entry.isActive ? "●" : "○"}</span>
                </button>
              </td>
              {!readOnly && (
                <td className="py-1.5">
                  <button type="button" onClick={() => handleDelete(entry)} disabled={pending} className="text-[12px] text-red-400 hover:text-red-600">
                    削除
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
