import { notFound, redirect } from "next/navigation";
import { canEditInventory, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { getInventoryDetail, listCategories, listCustomFieldDefinitions, listLocations, listStatuses } from "@/lib/inventory/queries";
import { EditInventoryForm } from "./EditInventoryForm";

export default async function EditInventoryPage({ params }: { params: { id: string } }) {
  const role = await getInventoryRole();
  // Same reasoning as new/page.tsx: the Data layer already rejects a
  // VIEWER's update, but bouncing here (to the detail page, which does
  // show a VIEWER-facing explanation) is a better experience than a
  // filled-out form failing only at submit time.
  if (!canEditInventory(role)) {
    redirect(`/inventory/${params.id}`);
  }

  const [item, categories, locations, statuses, customFieldDefs] = await Promise.all([
    getInventoryDetail(params.id),
    listCategories(),
    listLocations(),
    listStatuses(),
    listCustomFieldDefinitions(),
  ]);
  if (!item) notFound();

  return (
    <div className="h-full overflow-y-auto px-6 py-4">
      <EditInventoryForm item={item} categories={categories} locations={locations} statuses={statuses} customFieldDefs={customFieldDefs} />
    </div>
  );
}
