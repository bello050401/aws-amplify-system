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

  const duplicateSource = searchParams.duplicateFrom ? await getInventoryDetail(searchParams.duplicateFrom) : null;

  // Pass the duplicate source's categoryId/locationId through so a
  // duplicate of a record whose master has since been deactivated still
  // prefills correctly instead of silently dropping to 未選択 — same
  // reasoning as the edit page (see listCategories'/listLocations' comment).
  const [categories, locations, statuses, customFieldDefs] = await Promise.all([
    listCategories(duplicateSource?.categoryId),
    listLocations(duplicateSource?.locationId),
    listStatuses(),
    listCustomFieldDefinitions(),
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
