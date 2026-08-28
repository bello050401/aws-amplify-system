import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";

export interface HistoryFieldChange {
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
}

/**
 * Writes one InventoryHistory row per changed field (spec §5/§16: 新規登録/
 * 編集/削除 each need 操作種別・対象・日時・操作者 traceable). Always
 * called *after* the Inventory mutation it documents has already
 * succeeded (see app/actions/inventory.ts) — a history-write failure must
 * never be allowed to undo or block that mutation, hence allSettled
 * rather than a plain Promise.all that would reject on the first failure.
 */
export async function logInventoryHistory(inventoryId: string, changedBy: string | null, changes: HistoryFieldChange[]): Promise<void> {
  if (changes.length === 0) return;
  const changedAt = new Date().toISOString();
  await Promise.allSettled(
    changes.map((c) =>
      serverDataClient.models.InventoryHistory.create(
        {
          inventoryId,
          changedAt,
          changedBy: changedBy ?? undefined,
          fieldName: c.fieldName,
          oldValue: c.oldValue ?? undefined,
          newValue: c.newValue ?? undefined,
        },
        inventoryAuthMode,
      ),
    ),
  );
}

/** null/undefined/"" are treated as the same "empty" value so e.g. clearing a note doesn't log note: "" → undefined as a change, and vice versa. */
function normalize(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

/** Returns a HistoryFieldChange only if the (normalized) value actually differs — the building block for the field-by-field diff in updateInventory. */
export function diffField(fieldName: string, oldValue: string | number | null | undefined, newValue: string | number | null | undefined): HistoryFieldChange | null {
  const oldNorm = normalize(oldValue);
  const newNorm = normalize(newValue);
  if (oldNorm === newNorm) return null;
  return { fieldName, oldValue: oldNorm, newValue: newNorm };
}
