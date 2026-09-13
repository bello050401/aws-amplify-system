import { listListingsOverviewSafe } from "@/lib/listing/service";
import { ListingsOverviewTable } from "./ListingsOverviewTable";

/**
 * EC一覧P1 レビュー補正(2026-09-13): page.tsx本体(ヘッダー・案内文)
 * から一覧データ取得だけを切り出した非同期Server Component。
 *
 * app/inventory/(protected)/[id]/InventoryHistoryTable.tsxと同じ分離 —
 * page.tsx側の<Suspense>境界の中でだけ使う。ヘッダー・検索の案内文は
 * この取得を待たずに(page.tsx側で)先に描画され、このコンポーネントは
 * 自分の分(listListingsOverviewSafe — Inventory全件相当のGSI Query +
 * ChannelListing/ListingDraftのScan)だけを個別に待つ。取得失敗時も
 * listListingsOverviewSafeが例外を外へ投げない(null を返す)ため、
 * ここでtry/catchする必要はない——本体(ヘッダー)がエラー境界へ巻き
 * 込まれることはない。
 */
export async function ListingsOverviewData({ canEdit }: { canEdit: boolean }) {
  const rows = await listListingsOverviewSafe();
  return <ListingsOverviewTable initialRows={rows} canEdit={canEdit} />;
}
