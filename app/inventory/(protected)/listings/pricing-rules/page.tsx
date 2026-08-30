import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { InventoryHeader } from "../../../InventoryHeader";
import { PricingRulePanel } from "../../settings/PricingRulePanel";

export const metadata = { title: "自動値下げルール | BELLO 在庫管理" };

/**
 * 第六ラウンド§13-15(P0-3): 自動値下げルールの主導線を「設定」から
 * 「EC出品」へ移設。既存のPricingRulePanel(ルール一覧・作成・編集・
 * 複製・無効化のロジック一式)をそのまま再利用し、新しいUIを複製で
 * 作っていない——設置場所(このroute)だけを変えた。
 * `app/inventory/(protected)/settings/PricingRulePanel.tsx`自体は
 * Settings専用の副作用(タブ切り替え等)を持たない自己完結した
 * component だったため、importパスの変更以外は無改造で動く。
 */
export default async function PricingRulesPage() {
  const role = await getInventoryRole();
  if (!role) return null;
  if (role !== "ADMIN") {
    return (
      <div className="flex h-full flex-col">
        <InventoryHeader role={role} center={<h1 className="text-base font-bold text-gray-900">自動値下げルール</h1>} />
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <p className="text-[13px] text-gray-600">この画面はADMIN権限が必要です。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <InventoryHeader role={role} center={<h1 className="text-base font-bold text-gray-900">自動値下げルール</h1>} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <PricingRulePanel />
      </div>
    </div>
  );
}
