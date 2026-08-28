import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { listAllMasterEntries } from "@/lib/inventory/masters";
import { seedInventoryMasters } from "@/lib/inventory/masterSeed";
import { dedupeMasterEntries } from "@/lib/inventory/masterDedupe";
import { seedCustomFieldDefinitions } from "@/lib/inventory/customFieldSeed";
import { SettingsTabs } from "./SettingsTabs";

/**
 * Phase B — カテゴリ/保管場所マスタ管理 (spec). Reuses the existing
 * Category/Location Amplify Data models as-is: both already carry
 * sortOrder/isActive and ADMIN-write/EDITOR+VIEWER-read authorization
 * from Phase 2, so this page needed no backend/schema change at all —
 * see lib/inventory/masters.ts's file comment.
 *
 * Dedupe-then-seed runs on every ADMIN load rather than as a one-off
 * migration step — both are safe no-ops once there's nothing left to do
 * (see masterDedupe.ts / masterSeed.ts), and running dedupe first means
 * seeding's own duplicate check sees the already-cleaned-up state.
 * Gated to ADMIN only: EDITOR/VIEWER's session can only read these
 * models (see amplify/data/resource.ts's authorization), so attempting
 * either write as one of them would just be a guaranteed-to-be-rejected
 * GraphQL call on every page view for no benefit.
 *
 * EDITOR/VIEWER can still reach this page (auth gate in the parent
 * layout only checks "is an Inventory user at all") but see a read-only
 * list — the schema already rejects their write attempts, this is just
 * the matching UI-side experience, same pattern as
 * canEditInventory/canHardDeleteInventory elsewhere in this app.
 */
export const metadata = { title: "設定 | BELLO 在庫管理" };

export default async function InventorySettingsPage() {
  const role = await getInventoryRole();
  if (!role) return null; // parent layout already redirects signed-out/unauthorized users

  if (role === "ADMIN") {
    await Promise.all([dedupeMasterEntries("Category"), dedupeMasterEntries("Location")]);
    // seedCustomFieldDefinitions (Phase C's low-frequency 口金/脚高/
    // 座面寸法/梱包サイズ/古物の特徴 fields) doesn't interact with
    // Category/Location at all, so it doesn't need to wait on the above.
    await Promise.all([seedInventoryMasters(), seedCustomFieldDefinitions()]);
  }

  const [categories, locations] = await Promise.all([listAllMasterEntries("Category"), listAllMasterEntries("Location")]);

  return (
    <div className="h-full overflow-y-auto px-6 py-4">
      <h1 className="mb-1 text-base font-bold text-gray-900">設定</h1>
      <p className="mb-4 text-[12px] text-gray-500">カテゴリ・保管場所の管理を行います。</p>
      <SettingsTabs categories={categories} locations={locations} readOnly={role !== "ADMIN"} isAdmin={role === "ADMIN"} />
    </div>
  );
}
