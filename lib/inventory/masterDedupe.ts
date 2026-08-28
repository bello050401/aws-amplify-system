import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { listAllMasterEntries, normalizeMasterName, type MasterEntry, type MasterModelName } from "./masters";

/**
 * Reassigns every Inventory record pointing at `fromId` over to `toId`.
 * Explicit per-model branches (not a computed `{ [field]: ... }` filter
 * key) for the same reason as masters.ts's own CRUD — a shared/dynamic
 * client type blew TypeScript's comparison stack depth there.
 */
async function reassignInventoryReferences(model: MasterModelName, fromId: string, toId: string): Promise<number> {
  if (model === "Category") {
    const { data } = await serverDataClient.models.Inventory.list({ filter: { categoryId: { eq: fromId } }, ...inventoryAuthMode });
    await Promise.all(data.map((item) => serverDataClient.models.Inventory.update({ id: item.id, categoryId: toId }, inventoryAuthMode)));
    return data.length;
  }
  const { data } = await serverDataClient.models.Inventory.list({ filter: { locationId: { eq: fromId } }, ...inventoryAuthMode });
  await Promise.all(data.map((item) => serverDataClient.models.Inventory.update({ id: item.id, locationId: toId }, inventoryAuthMode)));
  return data.length;
}

async function deactivate(model: MasterModelName, id: string): Promise<void> {
  if (model === "Category") {
    await serverDataClient.models.Category.update({ id, isActive: false }, inventoryAuthMode);
  } else {
    await serverDataClient.models.Location.update({ id, isActive: false }, inventoryAuthMode);
  }
}

/**
 * Picks which entry in a duplicate group survives as the one every
 * Inventory reference gets pointed at: an already-active one first (don't
 * make something someone deliberately deactivated the survivor), then the
 * lowest sortOrder (closest to the top of the list as currently arranged),
 * then id as a final, fully deterministic tiebreaker. Deterministic and
 * stable across repeated runs — the same group always resolves to the
 * same representative, which is what makes this safe to re-run on every
 * settings page load.
 */
function pickRepresentative(group: MasterEntry[]): MasterEntry {
  return [...group].sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.id.localeCompare(b.id);
  })[0];
}

/**
 * Safe, additive-only cleanup for categories/locations that ended up
 * duplicated under slightly different spellings (full-width space,
 * trailing whitespace, casing — see normalizeMasterName) before
 * createMasterEntry/renameMasterEntry started rejecting new duplicates.
 *
 * Never deletes anything (spec: "DB破壊につながる一括処理は避けてくださ
 * い") — for each group of same-normalized-name entries, every Inventory
 * reference to a non-representative duplicate is repointed at the
 * representative, then the now-unreferenced duplicate is deactivated
 * (isActive: false), never removed. An ADMIN can review and physically
 * delete a deactivated duplicate afterwards from /inventory/settings
 * once they've confirmed it's safe to — deleteMasterEntry's own in-use
 * check will pass by then, since nothing references it any more.
 *
 * Idempotent: a group already collapsed to one active representative
 * plus already-deactivated, already-unreferenced duplicates just gets
 * re-checked and no-ops (0 records to reassign, an isActive:false
 * write that changes nothing). Safe to call on every settings page load,
 * same as seedInventoryMasters().
 */
export async function dedupeMasterEntries(model: MasterModelName): Promise<void> {
  // Unit(夜間開発指示書 §10で追加)はここでは未対応 — 新規追加された
  // マスタで過去の表記ゆれ重複が存在しないうえ、Inventory.unitは
  // categoryId/locationIdのような外部キーではなく自由文字列のままな
  // ので、reassignInventoryReferences/deactivateの「IDを付け替える」
  // 仕組みがそのままでは通用しない(masters.tsのcountInventoryReferences
  // のコメント参照)。createMasterEntry自体は今後もUnitの重複作成を
  // normalizeMasterNameで防ぐため、実害はない。
  if (model === "Unit") return;

  const entries = await listAllMasterEntries(model);
  const groups = new Map<string, MasterEntry[]>();
  for (const entry of entries) {
    const key = normalizeMasterName(entry.name);
    const list = groups.get(key);
    if (list) list.push(entry);
    else groups.set(key, [entry]);
  }

  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    const representative = pickRepresentative(group);
    for (const duplicate of group) {
      if (duplicate.id === representative.id) continue;
      await reassignInventoryReferences(model, duplicate.id, representative.id);
      await deactivate(model, duplicate.id);
    }
  }
}
