import { canEditInventory, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { listListingsOverviewAction } from "@/app/actions/listing";
import { InventoryHeader } from "../../InventoryHeader";
import { ListingsOverviewTable } from "./ListingsOverviewTable";

export const metadata = { title: "EC出品 | BELLO 在庫管理" };

/**
 * BELLO統合改修 master指示書(2026-08-29統合改修版) §14/§15/§16:
 * 在庫一覧ベースのEC出品管理画面。左サイドバーの「EC出品」(売上の直下、
 * InventoryNavRail.tsx参照)から遷移する、横断的な一覧画面 —
 * 商品詳細画面の既存「EC出品」リンク(/inventory/[id]/listing、1商品
 * 単位の編集画面)はこの追加後も変更・削除していない(Q4/Q12/Q13で
 * 明示的に要求されている「両方残す」)。
 *
 * 「eコンビニ」等の他社出品管理ツールは、あくまでUI設計の"コンセプト"
 * (商品中心・一括操作・外部ID/状態の可視化・詳細画面への深いリンク)
 * だけを参考にしている — UI/デザイン/コードは一切参照・コピーして
 * いない(spec: 「コンセプトだけを参考にし、UI/デザイン/コードは
 * コピーしない」)。
 *
 * データ取得はServer Component側で一括して行い(listListingsOverviewAction
 * — lib/listing/service.tsのlistListingsOverview、Inventory全件と
 * ChannelListing/ListingDraftをメモリ上でjoinする)、検索・絞り込み・
 * 選択状態はクライアント側(ListingsOverviewTable)で完結させる —
 * この画面の想定規模(Inventory全体、既存のSEARCH_MAX_SCAN_ITEMSと同じ
 * 上限)であれば、専用の検索基盤やサーバー側ページングは過剰設計になる
 * という、このアプリ全体で一貫した判断。
 *
 * 権限: 閲覧はADMIN/EDITOR/VIEWERいずれも可(既存の商品詳細のEC出品
 * リンクと同じ閲覧権限モデル)。一括下書き作成の書き込みだけADMIN/EDITOR
 * 限定(app/actions/listing.tsのbulkCreateListingDraftsAction — VIEWER
 * が呼んでもServer Action側で拒否される)。
 */
export default async function ListingsOverviewPage() {
  const role = await getInventoryRole();
  if (!role) return null; // parent layout already redirects signed-out/unauthorized users

  const rows = await listListingsOverviewAction();

  return (
    <div className="flex h-full flex-col">
      <InventoryHeader role={role} center={<h1 className="text-base font-bold text-gray-900">EC出品</h1>} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <p className="mb-4 text-[12px] text-gray-500">
          在庫の商品をMercari
          Shopsへ出品する状況を一覧で確認・一括操作できます。個別の出品下書き編集・出品実行は、各商品の「詳細を開く」から商品詳細画面のEC出品タブで行います。
        </p>
        <ListingsOverviewTable rows={rows} canEdit={canEditInventory(role)} />
      </div>
    </div>
  );
}
