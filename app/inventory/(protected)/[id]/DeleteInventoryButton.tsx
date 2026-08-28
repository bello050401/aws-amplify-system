"use client";

import { useState } from "react";
import { deleteInventory } from "@/app/actions/inventory";

/**
 * ADMIN-only, two-step (native `confirm()`, not a custom modal — spec
 * §4 explicitly rules out heavy modals/animation for this system) so a
 * misclick can't silently destroy a record. Deliberately styled as a
 * plain text link, smaller and less prominent than 編集/複製, so it
 * doesn't read as "just another action button" at a glance — spec asks
 * for exactly this: harder to hit by accident, not merely confirmed.
 */
export function DeleteInventoryButton({ inventoryId, label }: { inventoryId: string; label: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (pending) return;
    if (!window.confirm(`「${label}」を完全に削除します。この操作は取り消せません。よろしいですか？`)) return;

    setPending(true);
    setError(null);
    try {
      await deleteInventory(inventoryId);
      // deleteInventory redirect()s to /inventory on success — see
      // NewInventoryForm's identical comment for why normal execution
      // never reaches past this on the happy path.
    } catch (err) {
      if (err && typeof err === "object" && "digest" in err && String(err.digest).startsWith("NEXT_REDIRECT")) {
        throw err;
      }
      setError(err instanceof Error ? err.message : "削除に失敗しました。");
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end">
      <button type="button" onClick={handleClick} disabled={pending} className="text-[11px] text-red-500 underline decoration-dotted hover:text-red-700 disabled:opacity-50">
        {pending ? "削除中…" : "削除"}
      </button>
      {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
