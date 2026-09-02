import { headers } from "next/headers";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { ensureSettingsBootstrap } from "@/lib/inventory/settingsBootstrap";
import { listAllMasterEntries } from "@/lib/inventory/masters";
import { listAllCustomFieldDefinitions } from "@/lib/inventory/queries";
import { getZaicoTokenSource } from "@/lib/zaico/client";
import { getMercariConnectionState } from "@/lib/listing/mercari/tokenAccess";
import { getBaseConnectionState } from "@/lib/base/connectionState";
import { getMercariEnvironment } from "@/lib/listing/mercari/endpoints";
import { getLineTokenSource } from "@/lib/messaging/line/tokenAccess";
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
    // dedupe + 各種seedは、以前ここで毎回のページ描画中に直接実行して
    // いた。家財おまかせ便の料金マスターが2件から450件になった時点で、
    // 1回の描画中に400件超の書き込みを試みるようになり、設定ページが
    // 高確率で500になった(実測8回中7回)。ブートストラップは
    // 「一度整えば済む」作業なので、プロセス単位に畳んで描画パスから
    // 外す(lib/inventory/settingsBootstrap.ts)。
    await ensureSettingsBootstrap();
  }

  // Mercariは以前getMercariTokenSource()とgetMercariClientNameConfig()を
  // 両方awaitしており、同じSecretへGetSecretValueが2回飛んでいた
  // (それぞれが内部で独立に読むため)。TOKEN・クライアント名・検証状態は
  // すべて同じpayloadに同居しているので、getMercariConnectionState()で
  // 1回だけ読む(夜間統合指示書 2026-09-01 §6.2の不要なfetch削減)。
  // BASEの接続状態(§4.2)。既存の特集ページ連携設定をそのまま参照する
  // だけで、BELLO側に新しいBASE認証情報は作らない。
  //
  // hostを渡すのは、BASE Developersへ登録すべきコールバックURLを
  // 画面に表示するため。手で組み立てさせると、そこがずれた場合の
  // `redirect_uri_mismatch` は原因が最も分かりにくい失敗になる
  // (lib/base/redirectUri.ts)。Amplify HostingはCloudFrontの背後に
  // あるので、ブラウザから見えるホストは x-forwarded-host に入る。
  //
  // headers() は同期なので host は即座に決まる —— getBaseConnectionState は
  // 上の7件に何も依存していない。以前は Promise.all の**後ろ**で単独に
  // awaitしており、Secrets Managerへの往復が1つだけ直列に後ろへ
  // ぶら下がっていた。この画面は外部サービスの接続状態を4つ読む
  // (ZAICO / Mercari / LINE / BASE)ので、そのうち1つが直列なのは効く。
  const requestHeaders = headers();
  const host = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim() || requestHeaders.get("host");

  const [categories, locations, units, customFields, zaicoTokenSource, mercariState, lineTokenSource, baseConnection] =
    await Promise.all([
      listAllMasterEntries("Category"),
      listAllMasterEntries("Location"),
      listAllMasterEntries("Unit"),
      listAllCustomFieldDefinitions(),
      getZaicoTokenSource(),
      getMercariConnectionState(),
      getLineTokenSource(),
      getBaseConnectionState(host),
    ]);
  // isZaicoConnected()相当の真偽値はzaicoTokenSourceから導出する — Secrets
  // Managerへ二重にGetSecretValueを呼ばないため(以前はisZaicoConnected()
  // とgetZaicoTokenSource()を両方呼ぶと同じ呼び出しが2回発生していた)。
  const zaicoConnected = zaicoTokenSource !== "unconfigured";
  // 同じ理由でMercariもgetMercariConnectionState()の結果から導出する(BELLO
  // 統合改修 master指示書 Phase D)。
  const mercariConnected = mercariState.tokenSource !== "unconfigured";
  // 同じ理由でLINEもgetLineTokenSource()の結果から導出する(§51-52)。
  const lineConnected = lineTokenSource !== "unconfigured";

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
          mercariTokenSource={mercariState.tokenSource}
          mercariEnvironment={getMercariEnvironment()}
          mercariClientName={mercariState.clientName}
          mercariClientNameSource={mercariState.clientNameSource}
          mercariVerification={mercariState.verification}
          mercariLastCheckedAt={mercariState.lastCheckedAt}
          mercariSecretReadError={mercariState.secretReadError}
          baseConnection={baseConnection}
          lineConnected={lineConnected}
          lineTokenSource={lineTokenSource}
        />
      </div>
    </div>
  );
}
