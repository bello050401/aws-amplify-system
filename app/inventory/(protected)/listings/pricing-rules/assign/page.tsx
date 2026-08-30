import { canEditInventory, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { listPricingRulesAction } from "@/app/actions/pricing";
import { listListingsOverviewAction } from "@/app/actions/listing";
import { InventoryHeader } from "../../../../InventoryHeader";
import { PricingRuleAssignForm } from "./PricingRuleAssignForm";

export const metadata = { title: "自動値下げルールを設定 | BELLO 在庫管理" };

/**
 * 第六ラウンド§14(P0-3): EC出品一覧で選択した商品への一括ルール割当。
 * 選択IDはURLに一切含まれない(lib/listing/pricingAssignmentSelection.ts
 * 参照、sessionStorage経由) — このServer Component自体はルール一覧と
 * 商品一覧(既存のlistListingsOverviewActionを再利用、新規クエリを
 * 増やさない)だけをpropsとして渡し、実際の選択IDの読み取りと絞り込みは
 * クライアント側(PricingRuleAssignForm)で行う。
 */
export default async function PricingRuleAssignPage() {
  const role = await getInventoryRole();
  if (!role) return null;
  if (!canEditInventory(role)) {
    return (
      <div className="flex h-full flex-col">
        <InventoryHeader role={role} center={<h1 className="text-base font-bold text-gray-900">自動値下げルールを設定</h1>} />
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <p className="text-[13px] text-gray-600">この画面にはADMINまたはEDITOR権限が必要です。</p>
        </div>
      </div>
    );
  }

  const [rules, rows] = await Promise.all([listPricingRulesAction(), listListingsOverviewAction()]);

  return (
    <div className="flex h-full flex-col">
      <InventoryHeader role={role} center={<h1 className="text-base font-bold text-gray-900">自動値下げルールを設定</h1>} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <PricingRuleAssignForm rules={rules} rows={rows} />
      </div>
    </div>
  );
}
