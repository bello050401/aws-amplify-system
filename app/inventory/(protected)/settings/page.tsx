import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { listAllMasterEntries } from "@/lib/inventory/masters";
import { seedInventoryMasters } from "@/lib/inventory/masterSeed";
import { SettingsTabs } from "./SettingsTabs";

/**
 * Phase B — カテゴリ/保管場所マスタ管理 (spec). Reuses the existing
 * Category/Location Amplify Data models as-is: both already carry
 * sortOrder/isActive and ADMIN-write/EDITOR+VIEWER-read authorization
 * from Phase 2, so this page needed no backend/schema change at all —
 * see lib/inventory/masters.ts's file comment.
 *
 * Seeding runs on every load rather than as a one-off migration step —
 * seedInventoryMasters() only ever adds a name that's missing (by exact
 * match, active or inactive), so this is a no-op after the first real
 * visit and never overwrites an ADMIN's own edits.
 *
 * EDITOR/VIEWER can reach this page (auth gate in the parent layout only
 * checks "is an Inventory user at all") but see a read-only list — the
 * schema already rejects their write attempts, this is just the matching
 * UI-side experience, same pattern as canEditInventory/canHardDeleteInventory
 * elsewhere in this app.
 */
export const metadata = { title: "設定 | BELLO 在庫管理" };

export default async function InventorySettingsPage() {
  const role = await getInventoryRole();
  if (!role) return null; // parent layout already redirects signed-out/unauthorized users

  await seedInventoryMasters();

  const [categories, locations] = await Promise.all([listAllMasterEntries("Category"), listAllMasterEntries("Location")]);

  return (
    <div className="h-full overflow-y-auto px-6 py-4">
      <h1 className="mb-1 text-base font-bold text-gray-900">設定</h1>
      <p className="mb-4 text-[12px] text-gray-500">カテゴリ・保管場所の管理を行います。</p>
      <SettingsTabs categories={categories} locations={locations} readOnly={role !== "ADMIN"} />
    </div>
  );
}
