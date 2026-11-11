import {Suspense} from "react";
import {PhotoAssetImageEditor} from "./PhotoAssetImageEditor";
import {selectableLocations} from "@/lib/inventory/locationChoices";
import { notFound, redirect } from "next/navigation";
import { canEditInventory, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { getInventoryDetail, listCategories, listCustomFieldDefinitions, listLocations, listStatuses, listUnits } from "@/lib/inventory/queries";
import { appendReturnParam } from "@/lib/inventory/listReturnParams";
import { InventoryHeader } from "../../../InventoryHeader";
import { EditInventoryForm } from "./EditInventoryForm";
import { listInventoryPhotoAssetsAction } from "@/app/actions/photoRegistration";
import { signInventoryPreviews } from "@/lib/inventory/listImageUrls";
import { InventoryPreviewUrls } from "../../../InventoryPreviewUrls";

export default async function EditInventoryPage(
  props: {
    params: Promise<{ id: string }>;
    /** QA005: 詳細画面から引き継いだ `from` — 詳細ページの同名propと同じ(lib/inventory/listReturnParams.ts参照)。 */
    searchParams: Promise<{ from?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const role = await getInventoryRole();
  if (!role) return null; // parent layout already redirects a signed-out/unauthorized visitor
  // QA005: 保存後/キャンセル時に戻る詳細URL。`from` を引き継いだまま
  // 詳細へ戻ることで、その後の「在庫一覧へ戻る」でも検索条件を失わない。
  const detailHref = appendReturnParam(`/inventory/${params.id}`, searchParams.from);
  // Same reasoning as new/page.tsx: the Data layer already rejects a
  // VIEWER's update, but bouncing here (to the detail page, which does
  // show a VIEWER-facing explanation) is a better experience than a
  // filled-out form failing only at submit time.
  if (!canEditInventory(role)) {
    redirect(detailHref);
  }

  // item に依存しない3つ(ステータス・追加項目の定義・単位)は、item の
  // 取得を待つ理由が無い。以前は item を取り切ってから5つまとめて投げて
  // いたので、独立した問い合わせが1往復ぶん後ろへずれていた。
  const [item, statuses, customFieldDefs, units, activeCategories, activeLocations] = await Promise.all([
    getInventoryDetail(params.id, {consistentDirectRead: true}),
    listStatuses(),
    listCustomFieldDefinitions(),
    listUnits(),
    listCategories(),
    listLocations(),
  ]);
  if (!item) notFound();

  // Pass the record's current categoryId/locationId through so a value
  // deactivated since this Inventory was last saved still shows up as a
  // selectable (labeled "（無効）") option — see listCategories'/
  // listLocations' own comment. Depends on `item`, so this can't join
  // the Promise.all above.
  const [categories, locations, previewUrls] = await Promise.all([
    item.categoryId && !activeCategories.some(category => category.id === item.categoryId) ? listCategories(item.categoryId) : activeCategories,
    item.locationId && !activeLocations.some(location => location.id === item.locationId) ? listLocations(item.locationId) : activeLocations,
    signInventoryPreviews(item.images),
  ]);

  return (
    <InventoryPreviewUrls key={item.id} urls={previewUrls}>
    <div className="flex h-full flex-col">
      <InventoryHeader role={role} center={<h1 className="text-base font-bold text-gray-900">在庫編集</h1>} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <EditInventoryForm item={item} photoEditor={<Suspense fallback={<p role="status" className="p-3 text-sm text-gray-500">写真を読み込み中です。物品情報は編集できます。</p>}><PhotoAssets inventoryId={item.id}/></Suspense>} categories={categories} locations={selectableLocations(locations,item.locationId)} statuses={statuses} customFieldDefs={customFieldDefs} units={units} returnTo={detailHref} />
      </div>
    </div>
    </InventoryPreviewUrls>
  );
}

async function PhotoAssets({inventoryId}:{inventoryId:string}){
 const result=await listInventoryPhotoAssetsAction(inventoryId);
 return result.ok?<PhotoAssetImageEditor inventoryId={inventoryId} assets={result.value.assets}/>:<p role="alert" className="p-3 text-sm text-red-700">写真を取得できませんでした。写真の操作には画面の再読み込みが必要です。</p>;
}
