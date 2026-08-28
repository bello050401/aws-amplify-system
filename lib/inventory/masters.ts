import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";

/**
 * Category and Location share an identical shape (name/parentId/
 * sortOrder/isActive — see amplify/data/resource.ts) and identical
 * ADMIN-write/EDITOR+VIEWER-read authorization already, from Phase 2 —
 * this Phase needed no backend change at all, just a UI for data that
 * was already there. One generic implementation here backs both rather
 * than duplicating the same CRUD twice.
 *
 * Note: each operation below branches explicitly on `model` and calls
 * serverDataClient.models.Category.xxx / .Location.xxx directly, rather
 * than resolving "the model client" once into a shared variable — doing
 * that turned the client into a union of two structurally near-identical
 * but independently-generated generic types, and TypeScript blew its
 * comparison stack depth trying to check assignability
 * (`TS2321: Excessive stack depth`) on every call. Branching per call
 * keeps each branch's type fully concrete instead.
 */
export type MasterModelName = "Category" | "Location";

export interface MasterEntry {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

/**
 * Canonical comparison key for a master name — used ONLY to detect
 * duplicates/matches, never to overwrite what's actually stored or
 * displayed. Collapses the表記ゆれ (spelling variants) that produced
 * real duplicate categories in practice:
 * - `NFKC` unifies full-width/half-width forms, including turning a
 *   full-width space (U+3000) into an ordinary one.
 * - `trim()` + collapsing internal whitespace (including stray
 *   tabs/newlines pasted from elsewhere) removes padding differences.
 * - `toLowerCase()` catches any ASCII-letter casing difference.
 */
export function normalizeMasterName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Every entry regardless of isActive — the settings screen needs to show (and let ADMIN re-enable) disabled ones too, unlike listCategories()/listLocations() in queries.ts which only ever return active entries for the registration/edit forms' dropdowns. */
export async function listAllMasterEntries(model: MasterModelName): Promise<MasterEntry[]> {
  const { data } =
    model === "Category"
      ? await serverDataClient.models.Category.list(inventoryAuthMode)
      : await serverDataClient.models.Location.list(inventoryAuthMode);
  return data
    .map((d) => ({ id: d.id, name: d.name, sortOrder: d.sortOrder ?? 0, isActive: d.isActive ?? true }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ja"));
}

/**
 * New entries go to the end of the current order. Refuses a name that's
 * already present — even under a different exact spelling (full-width
 * space, trailing whitespace, casing) — via normalizeMasterName, rather
 * than only rejecting a byte-for-byte match; this is what stops today's
 * duplicate-category problem from recurring going forward (see
 * lib/inventory/masterDedupe.ts for cleaning up what's already there).
 */
export async function createMasterEntry(model: MasterModelName, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("名称を入力してください。");
  const existing = await listAllMasterEntries(model);
  const normalized = normalizeMasterName(trimmed);
  const duplicate = existing.find((e) => normalizeMasterName(e.name) === normalized);
  if (duplicate) {
    throw new Error(`「${duplicate.name}」と同じ名称（表記ゆれ含む）が既に存在します。`);
  }
  const nextSortOrder = existing.length === 0 ? 0 : Math.max(...existing.map((e) => e.sortOrder)) + 1;
  const { errors } =
    model === "Category"
      ? await serverDataClient.models.Category.create({ name: trimmed, sortOrder: nextSortOrder, isActive: true }, inventoryAuthMode)
      : await serverDataClient.models.Location.create({ name: trimmed, sortOrder: nextSortOrder, isActive: true }, inventoryAuthMode);
  if (errors) {
    console.error(`[createMasterEntry] ${model} create failed:`, errors);
    throw new Error(`追加に失敗しました: ${JSON.stringify(errors)}`);
  }
}

export async function renameMasterEntry(model: MasterModelName, id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("名称を入力してください。");
  const existing = await listAllMasterEntries(model);
  const normalized = normalizeMasterName(trimmed);
  const duplicate = existing.find((e) => e.id !== id && normalizeMasterName(e.name) === normalized);
  if (duplicate) {
    throw new Error(`「${duplicate.name}」と同じ名称（表記ゆれ含む）が既に存在します。`);
  }
  const { errors } =
    model === "Category"
      ? await serverDataClient.models.Category.update({ id, name: trimmed }, inventoryAuthMode)
      : await serverDataClient.models.Location.update({ id, name: trimmed }, inventoryAuthMode);
  if (errors) {
    console.error(`[renameMasterEntry] ${model} update failed:`, errors);
    throw new Error(`名称の変更に失敗しました: ${JSON.stringify(errors)}`);
  }
}

export async function setMasterEntryActive(model: MasterModelName, id: string, isActive: boolean): Promise<void> {
  const { errors } =
    model === "Category"
      ? await serverDataClient.models.Category.update({ id, isActive }, inventoryAuthMode)
      : await serverDataClient.models.Location.update({ id, isActive }, inventoryAuthMode);
  if (errors) {
    console.error(`[setMasterEntryActive] ${model} update failed:`, errors);
    throw new Error(`更新に失敗しました: ${JSON.stringify(errors)}`);
  }
}

async function updateSortOrder(model: MasterModelName, id: string, sortOrder: number) {
  return model === "Category"
    ? serverDataClient.models.Category.update({ id, sortOrder }, inventoryAuthMode)
    : serverDataClient.models.Location.update({ id, sortOrder }, inventoryAuthMode);
}

/** Persists a full reorder — `orderedIds` is the complete new top-to-bottom order, so sortOrder becomes each id's index. Only entries whose sortOrder actually changed are written. */
export async function reorderMasterEntries(model: MasterModelName, orderedIds: string[]): Promise<void> {
  const current = await listAllMasterEntries(model);
  const currentById = new Map(current.map((e) => [e.id, e]));
  const updates = orderedIds
    .map((id, index) => ({ id, sortOrder: index }))
    .filter(({ id, sortOrder }) => currentById.get(id)?.sortOrder !== sortOrder);
  const results = await Promise.all(updates.map(({ id, sortOrder }) => updateSortOrder(model, id, sortOrder)));
  const failed = results.filter((r) => r.errors);
  if (failed.length > 0) {
    console.error(`[reorderMasterEntries] ${model} update failed for ${failed.length} item(s):`, failed);
    throw new Error("並び替えの保存に失敗しました。");
  }
}

/** How many Inventory records currently reference this id — the one check both deleteMasterEntry and bulkDeleteMasterEntries use to decide delete-vs-deactivate, kept in one place so the two can never disagree about what "in use" means. */
async function countInventoryReferences(model: MasterModelName, id: string): Promise<number> {
  const { data } =
    model === "Category"
      ? await serverDataClient.models.Inventory.list({ filter: { categoryId: { eq: id } }, ...inventoryAuthMode })
      : await serverDataClient.models.Inventory.list({ filter: { locationId: { eq: id } }, ...inventoryAuthMode });
  return data.length;
}

/**
 * Physical delete is refused whenever any Inventory record currently
 * references this id (spec: "使用中の場合は無効化を優先" / never break
 * an existing reference) — the caller (settings UI) is expected to
 * offer 無効化 instead in that case. Checking a `deletedAt`-agnostic
 * count is deliberate: an Inventory soft-deletion in a future phase
 * would still reference this id in its history/record, so "in use"
 * here means "any Inventory row has this id", full stop.
 */
export async function deleteMasterEntry(model: MasterModelName, id: string): Promise<void> {
  const inUseCount = await countInventoryReferences(model, id);
  if (inUseCount > 0) {
    throw new Error(`${inUseCount}件の在庫がこの${model === "Category" ? "カテゴリ" : "保管場所"}を使用しているため削除できません。無効化してください。`);
  }
  const { errors } =
    model === "Category"
      ? await serverDataClient.models.Category.delete({ id }, inventoryAuthMode)
      : await serverDataClient.models.Location.delete({ id }, inventoryAuthMode);
  if (errors) {
    console.error(`[deleteMasterEntry] ${model} delete failed:`, errors);
    throw new Error(`削除に失敗しました: ${JSON.stringify(errors)}`);
  }
}

export interface BulkDeleteResult {
  /** ids that were unused and got physically deleted. */
  deletedIds: string[];
  /** ids that were in use, so were deactivated instead of deleted (never a hard failure — spec: 使用中カテゴリは無効化). */
  deactivatedIds: string[];
  /** ids that hit an actual error (neither deleted nor deactivated) — a real failure, not just "in use". */
  failed: { id: string; reason: string }[];
}

/**
 * Phase C.5 §1 — bulk operation for /inventory/settings' multi-select:
 * for each id, delete it if nothing references it, deactivate it
 * (never a rejection) if something does, and only land in `failed` on an
 * actual error. Reuses deleteMasterEntry/setMasterEntryActive rather
 * than re-implementing either, and countInventoryReferences rather than
 * re-deriving "is this in use". Sequential, not Promise.all — a settings
 * screen bulk action is small in practice, and processing one at a time
 * keeps each id's outcome cleanly isolated (one slow/failing id can't
 * corrupt another's result).
 *
 * Generic over `model` exactly like every other function in this file —
 * Category and Location get this mechanism for free from the same code
 * (spec §1: "保管場所についても同じ仕組みを流用可能な構造"); which of
 * the two actually exposes the bulk-select UI is a settings-screen
 * concern, not a backend one.
 */
export async function bulkDeleteMasterEntries(model: MasterModelName, ids: string[]): Promise<BulkDeleteResult> {
  const result: BulkDeleteResult = { deletedIds: [], deactivatedIds: [], failed: [] };
  for (const id of ids) {
    try {
      const inUseCount = await countInventoryReferences(model, id);
      if (inUseCount > 0) {
        await setMasterEntryActive(model, id, false);
        result.deactivatedIds.push(id);
      } else {
        await deleteMasterEntry(model, id);
        result.deletedIds.push(id);
      }
    } catch (err) {
      result.failed.push({ id, reason: err instanceof Error ? err.message : "不明なエラー" });
    }
  }
  return result;
}
