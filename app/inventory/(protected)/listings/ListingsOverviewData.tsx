import { listListingsOverviewSafe } from "@/lib/listing/service";
import { ListingsOverviewTable } from "./ListingsOverviewTable";
import { getEcListingCatalogAction } from "@/app/actions/ecListingCatalog";

/**
 * EC一覧P1 レビュー補正(2026-09-13): page.tsx本体(ヘッダー・案内文)
 * から一覧データ取得だけを切り出した非同期Server Component。
 *
 * app/inventory/(protected)/[id]/InventoryHistoryTable.tsxと同じ分離 —
 * page.tsx側の<Suspense>境界の中でだけ使う。ヘッダー・検索の案内文は
 * この取得を待たずに(page.tsx側で)先に描画され、このコンポーネントは
 * 自分の分(listListingsOverviewSafe — Inventory全件相当のGSI Query +
 * ChannelListing/ListingDraftのScan)だけを個別に待つ。取得失敗時も
 * listListingsOverviewSafeが例外を外へ投げない(`{ok:false, failure}`を
 * 返す — EC一覧P1 実失敗分類、2026-09-13)ため、ここでtry/catchする
 * 必要はない——本体(ヘッダー)がエラー境界へ巻き込まれることはない。
 */
export async function ListingsOverviewData({ canEdit }: { canEdit: boolean }) {
  // The table needs both sources before an EC operation can be reviewed.
  // Fetch them together, rather than waiting for browser hydration to start
  // another server-action round trip. This remains inside the Suspense boundary.
  const [result, catalog] = await Promise.all([
    listListingsOverviewSafe(),
    getEcListingCatalogAction().catch(() => undefined),
  ]);
  return <ListingsOverviewTable initialResult={result} initialCatalog={catalog} canEdit={canEdit} />;
}
