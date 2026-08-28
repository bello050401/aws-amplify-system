import { redirect } from "next/navigation";
import { canEditInventory, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { getInventoryDetail, listCategories, listCustomFieldDefinitions, listLocations, listStatuses, listUnits } from "@/lib/inventory/queries";
import { ALL_EXTENDED_FIELDS, type InventoryExtendedFields } from "@/lib/inventory/extendedFields";
import { splitImagesByType } from "@/lib/inventory/imageTypes";
import { InventoryHeader } from "../../InventoryHeader";
import { NewInventoryForm } from "./NewInventoryForm";

interface NewInventoryPageProps {
  searchParams: { duplicateFrom?: string };
}

export default async function NewInventoryPage({ searchParams }: NewInventoryPageProps) {
  const role = await getInventoryRole();
  if (!role) return null; // parent layout already redirects a signed-out/unauthorized visitor
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
  const [categories, locations, statuses, customFieldDefs, units] = await Promise.all([
    listCategories(duplicateSource?.categoryId),
    listLocations(duplicateSource?.locationId),
    listStatuses(),
    listCustomFieldDefinitions(),
    listUnits(),
  ]);

  // A missing/deleted source (bad link, or it was deleted between
  // opening the list and clicking 複製) just falls back to a blank
  // registration form rather than erroring the whole page.
  //
  // Everything about the source item carries over except its identity/
  // audit trail (spec §11: new Inventory id / 在庫ID / createdAt /
  // updatedAt / history — id and history simply never get copied here,
  // and 在庫ID(sku)/createdAt/updatedAt are always freshly assigned by
  // createInventory itself, never accepted from the client at all).
  // Phase C's ~30 extended fields ride along via one spread over
  // ALL_EXTENDED_FIELDS rather than being listed by hand a third time.
  // Phase C.5: normal and damage photos are split here (once) rather
  // than in the client — NewInventoryForm just seeds its two independent
  // ImageEditor slot lists straight from these, isPrimary included, so a
  // duplicate keeps whichever photo was the source's top image too
  // (spec §9).
  const { normal: normalImages, damage: damageImages } = splitImagesByType(duplicateSource?.images ?? []);

  const duplicateFrom = duplicateSource
    ? {
        sourceDisplayId: duplicateSource.displayId,
        name: duplicateSource.name,
        categoryId: duplicateSource.categoryId ?? undefined,
        statusId: duplicateSource.statusId ?? undefined,
        locationId: duplicateSource.locationId ?? undefined,
        quantity: duplicateSource.quantity,
        unit: duplicateSource.unit ?? undefined,
        purchasePrice: duplicateSource.purchasePrice ?? undefined,
        salePrice: duplicateSource.salePrice ?? undefined,
        barcode: duplicateSource.barcode ?? undefined,
        note: duplicateSource.note ?? undefined,
        customFields: duplicateSource.customFields ?? undefined,
        normalImages,
        damageImages,
        ...(Object.fromEntries(ALL_EXTENDED_FIELDS.map((f) => [f.key, duplicateSource[f.key] ?? undefined])) as Partial<InventoryExtendedFields>),
      }
    : undefined;

  return (
    <div className="flex h-full flex-col">
      <InventoryHeader role={role} center={<h1 className="text-base font-bold text-gray-900">新規在庫登録</h1>} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <NewInventoryForm
          categories={categories}
          locations={locations}
          statuses={statuses}
          customFieldDefs={customFieldDefs}
          units={units}
          duplicateFrom={duplicateFrom}
        />
      </div>
    </div>
  );
}
