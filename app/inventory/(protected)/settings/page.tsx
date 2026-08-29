import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { listAllMasterEntries } from "@/lib/inventory/masters";
import { listAllCustomFieldDefinitions } from "@/lib/inventory/queries";
import { seedInventoryMasters } from "@/lib/inventory/masterSeed";
import { dedupeMasterEntries } from "@/lib/inventory/masterDedupe";
import { seedCustomFieldDefinitions } from "@/lib/inventory/customFieldSeed";
import { getZaicoTokenSource } from "@/lib/zaico/client";
import { getMercariTokenSource } from "@/lib/listing/mercari/tokenAccess";
import { getMercariEnvironment } from "@/lib/listing/mercari/endpoints";
import { InventoryHeader } from "../../InventoryHeader";
import { SettingsTabs } from "./SettingsTabs";

/**
 * Phase B — カテゴリ/保管場所マスタ管理 (spec). Reuses the existing
 * Category/Location Amplify Data models as-is: both already carry
 * sortOrder/isActive and ADMIN-write/EDITOR+VIEWER-read authorization
 * from Phase 2, so this page needed no backend/schema change at all —
 * see lib/inventory/masters.ts's file comment.
 *
 * 単位(UnitMaster)は夜間開発指示書 §10で追加 — amplify/data/resource.ts
 * にモデルを新設したため、AWS側の再デプロイ(ampx sandbox / hosting
 * build)を経るまでは実際には利用できない(完了報告のBLOCKED_BY_USER
 * 参照)。コード自体はCategory/Locationと同じ経路(lib/inventory/masters.ts)
 * を素通りするだけで動く。
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
    // Unitはdedupe未対応(masterDedupe.tsのガード参照 — 新規追加のため
    // 過去の重複が存在しない)。
    await Promise.all([dedupeMasterEntries("Category"), dedupeMasterEntries("Location")]);
    // seedCustomFieldDefinitions (Phase Cの低頻度 口金/脚高/座面寸法/
    // 梱包サイズ/古物の特徴 fields) doesn't interact with
    // Category/Location/Unit at all, so it doesn't need to wait on the above.
    await Promise.all([seedInventoryMasters(), seedCustomFieldDefinitions()]);
  }

  const [categories, locations, units, customFields, zaicoTokenSource, mercariTokenSource] = await Promise.all([
    listAllMasterEntries("Category"),
    listAllMasterEntries("Location"),
    listAllMasterEntries("Unit"),
    listAllCustomFieldDefinitions(),
    getZaicoTokenSource(),
    getMercariTokenSource(),
  ]);
  // isZaicoConnected()相当の真偽値はzaicoTokenSourceから導出する — Secrets
  // Managerへ二重にGetSecretValueを呼ばないため(以前はisZaicoConnected()
  // とgetZaicoTokenSource()を両方呼ぶと同じ呼び出しが2回発生していた)。
  const zaicoConnected = zaicoTokenSource !== "unconfigured";
  // 同じ理由でMercariもgetMercariTokenSource()の結果から導出する(BELLO
  // 統合改修 master指示書 Phase D)。
  const mercariConnected = mercariTokenSource !== "unconfigured";

  return (
    <div className="flex h-full flex-col">
      <InventoryHeader role={role} center={<h1 className="text-base font-bold text-gray-900">設定</h1>} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <p className="mb-4 text-[12px] text-gray-500">カテゴリ・単位・保管場所・追加項目等の管理を行います。</p>
        <SettingsTabs
          categories={categories}
          locations={locations}
          units={units}
          customFields={customFields}
          readOnly={role !== "ADMIN"}
          isAdmin={role === "ADMIN"}
          zaicoConnected={zaicoConnected}
          zaicoTokenSource={zaicoTokenSource}
          mercariConnected={mercariConnected}
          mercariTokenSource={mercariTokenSource}
          mercariEnvironment={getMercariEnvironment()}
        />
      </div>
    </div>
  );
}
