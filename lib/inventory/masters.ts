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

/** New entries go to the end of the current order. */
export async function createMasterEntry(model: MasterModelName, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("名称を入力してください。");
  const existing = await listAllMasterEntries(model);
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
  const { data: inUse } =
    model === "Category"
      ? await serverDataClient.models.Inventory.list({ filter: { categoryId: { eq: id } }, ...inventoryAuthMode })
      : await serverDataClient.models.Inventory.list({ filter: { locationId: { eq: id } }, ...inventoryAuthMode });
  if (inUse.length > 0) {
    throw new Error(`${inUse.length}件の在庫がこの${model === "Category" ? "カテゴリ" : "保管場所"}を使用しているため削除できません。無効化してください。`);
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
