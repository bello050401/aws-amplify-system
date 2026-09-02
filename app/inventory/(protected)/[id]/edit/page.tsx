import { notFound, redirect } from "next/navigation";
import { canEditInventory, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { getInventoryDetail, listCategories, listCustomFieldDefinitions, listLocations, listStatuses, listUnits } from "@/lib/inventory/queries";
import { InventoryHeader } from "../../../InventoryHeader";
import { EditInventoryForm } from "./EditInventoryForm";

export default async function EditInventoryPage({ params }: { params: { id: string } }) {
  const role = await getInventoryRole();
  if (!role) return null; // parent layout already redirects a signed-out/unauthorized visitor
  // Same reasoning as new/page.tsx: the Data layer already rejects a
  // VIEWER's update, but bouncing here (to the detail page, which does
  // show a VIEWER-facing explanation) is a better experience than a
  // filled-out form failing only at submit time.
  if (!canEditInventory(role)) {
    redirect(`/inventory/${params.id}`);
  }

  // item に依存しない3つ(ステータス・追加項目の定義・単位)は、item の
  // 取得を待つ理由が無い。以前は item を取り切ってから5つまとめて投げて
  // いたので、独立した問い合わせが1往復ぶん後ろへずれていた。
  const [item, statuses, customFieldDefs, units] = await Promise.all([
    getInventoryDetail(params.id),
    listStatuses(),
    listCustomFieldDefinitions(),
    listUnits(),
  ]);
  if (!item) notFound();

  // Pass the record's current categoryId/locationId through so a value
  // deactivated since this Inventory was last saved still shows up as a
  // selectable (labeled "（無効）") option — see listCategories'/
  // listLocations' own comment. Depends on `item`, so this can't join
  // the Promise.all above.
  const [categories, locations] = await Promise.all([
    listCategories(item.categoryId),
    listLocations(item.locationId),
  ]);

  return (
    <div className="flex h-full flex-col">
      <InventoryHeader role={role} center={<h1 className="text-base font-bold text-gray-900">在庫編集</h1>} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <EditInventoryForm item={item} categories={categories} locations={locations} statuses={statuses} customFieldDefs={customFieldDefs} units={units} />
      </div>
    </div>
  );
}
