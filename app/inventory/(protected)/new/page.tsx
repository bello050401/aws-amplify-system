import { redirect } from "next/navigation";
import { canEditInventory, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { getInventoryDetail, listCategories, listCustomFieldDefinitions, listLocations, listStatuses } from "@/lib/inventory/queries";
import { NewInventoryForm } from "./NewInventoryForm";

interface NewInventoryPageProps {
  searchParams: { duplicateFrom?: string };
}

export default async function NewInventoryPage({ searchParams }: NewInventoryPageProps) {
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

  const [categories, locations, statuses, customFieldDefs, duplicateSource] = await Promise.all([
    listCategories(),
    listLocations(),
    listStatuses(),
    listCustomFieldDefinitions(),
    searchParams.duplicateFrom ? getInventoryDetail(searchParams.duplicateFrom) : Promise.resolve(null),
  ]);

  // A missing/deleted source (bad link, or it was deleted between
  // opening the list and clicking 複製) just falls back to a blank
  // registration form rather than erroring the whole page.
  const duplicateFrom = duplicateSource
    ? {
        sourceSku: duplicateSource.sku,
        name: duplicateSource.name,
        categoryId: duplicateSource.categoryId ?? undefined,
        statusId: duplicateSource.statusId ?? undefined,
        locationId: duplicateSource.locationId ?? undefined,
        quantity: duplicateSource.quantity,
        unit: duplicateSource.unit ?? undefined,
        purchasePrice: duplicateSource.purchasePrice ?? undefined,
        salePrice: duplicateSource.salePrice ?? undefined,
        note: duplicateSource.note ?? undefined,
        customFields: duplicateSource.customFields ?? undefined,
        images: duplicateSource.images,
      }
    : undefined;

  return (
    <div className="h-full overflow-y-auto px-6 py-4">
      <NewInventoryForm
        categories={categories}
        locations={locations}
        statuses={statuses}
        customFieldDefs={customFieldDefs}
        duplicateFrom={duplicateFrom}
      />
    </div>
  );
}
