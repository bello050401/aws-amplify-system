import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { listAllMasterEntries, type MasterModelName } from "./masters";

/**
 * Initial values requested for BELLO's own operation (Phase B spec) —
 * additive-only seeding: only a name that ISN'T already present (active
 * OR inactive — an ADMIN who deliberately deactivated or renamed one of
 * these must never have it silently reappear) gets created. Never
 * overwrites or deletes anything already in the table. Safe to call
 * every time the settings page loads.
 */
const CATEGORY_SEED = [
  "補修待ち",
  "撮影待ち",
  "出品待ち",
  "販売中",
  "売り切れ",
  "入金待ち",
  "出荷指示済",
  "発送完了",
  "保留",
  "コーディネート用",
  "事務所備品",
  "業者間",
  "川越移動予定",
  "破棄",
  "無償提供",
  "複数在庫 未出品",
  "五十嵐さん",
  "市川確認",
  "大原確認",
] as const;

const LOCATION_SEED = ["所沢事務所", "イエローテイル川越", "所沢プラス倉庫", "大原自宅", "市川自宅"] as const;

async function seedModel(model: MasterModelName, names: readonly string[]): Promise<void> {
  const existing = await listAllMasterEntries(model);
  const existingNames = new Set(existing.map((e) => e.name));
  const missing = names.filter((n) => !existingNames.has(n));
  if (missing.length === 0) return;

  let nextSortOrder = existing.length === 0 ? 0 : Math.max(...existing.map((e) => e.sortOrder)) + 1;
  for (const name of missing) {
    if (model === "Category") {
      await serverDataClient.models.Category.create({ name, sortOrder: nextSortOrder, isActive: true }, inventoryAuthMode);
    } else {
      await serverDataClient.models.Location.create({ name, sortOrder: nextSortOrder, isActive: true }, inventoryAuthMode);
    }
    nextSortOrder += 1;
  }
}

/** Called once from the settings page (ADMIN view only — see app/actions/masters.ts) so first-time setup needs no separate migration step. A no-op on every call after the first. */
export async function seedInventoryMasters(): Promise<void> {
  await Promise.all([seedModel("Category", CATEGORY_SEED), seedModel("Location", LOCATION_SEED)]);
}
