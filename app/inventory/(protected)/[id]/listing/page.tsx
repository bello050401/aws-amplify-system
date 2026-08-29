import { notFound } from "next/navigation";
import { canEditInventory, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { getListingDraftForInventory, getChannelListing } from "@/lib/listing/service";
import { isMercariConnected } from "@/lib/listing/mercari/tokenAccess";
import { InventoryHeader } from "../../../InventoryHeader";
import { ListingForm } from "./ListingForm";

/**
 * BELLO統合改修 master指示書 Phase D — 在庫詳細画面(app/inventory/
 * (protected)/[id]/page.tsx)を一切変更せず、独立したサブページとして
 * EC出品機能を実装している(詳細画面には「EC出品」への1行のリンクだけ
 * を追加 — page.tsx自体のコメント参照)。これにより、既存の詳細画面の
 * レイアウト/密度は完全に無傷のまま保たれる。
 *
 * READ ONLY境界: このページ自体もInventoryモデルを一切書き込まない
 * (getInventoryDetailは読み取り専用クエリ)。実際の書き込みは
 * ListingForm.tsx→app/actions/listing.ts→lib/listing/service.tsの
 * 一本道のみで行われ、Inventory/ZAICOには一切触れない。
 */
export const metadata = { title: "EC出品 | BELLO 在庫管理" };

export default async function ListingPage({ params }: { params: { id: string } }) {
  const role = await getInventoryRole();
  if (!role) return null; // parent layout already redirects signed-out/unauthorized users
  if (!canEditInventory(role)) {
    // spec: Listingの作成・編集はInventory編集権限(ADMIN/EDITOR)と同じ境界。
    // VIEWERはこの画面自体を開けない(Inventory詳細の閲覧はできるが、
    // 出品操作はできない — canEditInventoryの既存の意味と一致させる)。
    notFound();
  }

  const item = await getInventoryDetail(params.id);
  if (!item) notFound();

  const [draft, channelListing, mercariConnected] = await Promise.all([
    getListingDraftForInventory(item.id),
    getChannelListing(item.id, "MERCARI_SHOPS"),
    isMercariConnected(),
  ]);

  return (
    <div className="flex h-full flex-col">
      <InventoryHeader role={role} center={<h1 className="text-base font-bold text-gray-900">EC出品</h1>} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <ListingForm inventoryId={item.id} inventoryName={item.name} initialDraft={draft} initialChannelListing={channelListing} mercariConnected={mercariConnected} />
      </div>
    </div>
  );
}
