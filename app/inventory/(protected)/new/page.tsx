import { redirect } from "next/navigation";
import { canEditInventory, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { listCategories, listCustomFieldDefinitions, listLocations, listStatuses } from "@/lib/inventory/queries";
import { NewInventoryForm } from "./NewInventoryForm";

export default async function NewInventoryPage() {
  const role = await getInventoryRole();
  // VIEWER can reach every /inventory/* URL by typing it directly — the
  // (protected) layout only checks "is this an Inventory user at all",
  // not "can this role write". The Data layer already rejects a VIEWER's
  // write (allow.group("VIEWER").to(["read"]) — see amplify/data/resource.ts),
  // but bouncing here is a better experience than letting them fill out
  // the whole form first and only finding out at submit time.
  if (!canEditInventory(role)) {
    redirect("/inventory");
  }

  const [categories, locations, statuses, customFieldDefs] = await Promise.all([
    listCategories(),
    listLocations(),
    listStatuses(),
    listCustomFieldDefinitions(),
  ]);

  return (
    <div className="h-full overflow-y-auto px-6 py-4">
      <NewInventoryForm categories={categories} locations={locations} statuses={statuses} customFieldDefs={customFieldDefs} />
    </div>
  );
}
