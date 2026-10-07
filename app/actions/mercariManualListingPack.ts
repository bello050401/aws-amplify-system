"use server";

import { getCategoryById, getBrandById } from "@/lib/listing/mercari/csv/masters";
import { getMercariPrivateCreatePreparationAction } from
  "@/app/actions/mercariPrivateCreatePreparation";

const TEST_INVENTORIES = new Set([
  "dd273c1e-9b2a-4013-acc6-c445a481fab8",
  "5b0f3587-cbbb-4c09-ae78-595b2b3e353f",
]);

export type MercariManualListingPack = {
  schemaVersion: 1;
  kind: "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK";
  shopId: string;
  inventoryId: string;
  draftId: string;
  draftUpdatedAt: string;
  title: string;
  description: string;
  condition: string;
  imageRefs: { source: "INVENTORY" | "PHOTO_ASSET"; storageKey: string;
    sortOrder: number; photoAssetId: string | null }[];
  priceYen: number;
  quantity: number;
  categoryId: string;
  categoryPath: string;
  brandId: string | null;
  brandName: string | null;
  managementCode: string;
  shipping: {
    method: "METHOD_TYPE_UNDECIDED";
    payer: "PAYER_TYPE_SELLER";
    origin: "jp11";
    duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS";
  };
  status: "PREPARED_NO_SEND";
};

/** The UUID makes the Shops management code stable and unique per BELLO inventory. */
function mercariManagementCode(inventoryId: string): string {
  return `BELLO_${inventoryId.replace(/-/g, "").toUpperCase()}`;
}

/** A human chooses the three variable listing fields before this no-send pack exists. */
export async function prepareMercariManualListingPackAction(
  inventoryId: string,
  selected: { priceYen: number; quantity: number; categoryId: string;
    brandId: string | null },
): Promise<{ ok: true; pack: MercariManualListingPack } |
  { ok: false; code: "INVALID_SELECTION" | "DRAFT_UNAVAILABLE" |
    "RESERVED_TEST" | "EXISTING_LINK" }> {
  if (typeof inventoryId !== "string" || TEST_INVENTORIES.has(inventoryId.toLowerCase()))
    return { ok: false, code: "RESERVED_TEST" };
  if (!selected || !Number.isSafeInteger(selected.priceYen) ||
      selected.priceYen < 300 || selected.priceYen > 9_999_999 ||
      !Number.isSafeInteger(selected.quantity) || selected.quantity < 1 ||
      typeof selected.categoryId !== "string" ||
      (selected.brandId !== null && typeof selected.brandId !== "string"))
    return { ok: false, code: "INVALID_SELECTION" };
  const saved = await getMercariPrivateCreatePreparationAction(inventoryId);
  if (!saved.ok) return { ok: false, code: saved.code === "EXISTING_LINK" ?
    "EXISTING_LINK" : "DRAFT_UNAVAILABLE" };
  if (saved.preparation.schemaVersion !== 1 ||
      selected.quantity > saved.preparation.quantity)
    return { ok: false, code: "INVALID_SELECTION" };
  const category = getCategoryById(selected.categoryId);
  const brand = selected.brandId === null ? null : getBrandById(selected.brandId);
  if (!category?.fullPath.startsWith("家具・インテリア > ") ||
      (selected.brandId !== null && !brand))
    return { ok: false, code: "INVALID_SELECTION" };
  const draft = saved.preparation;
  return { ok: true, pack: {
    schemaVersion: 1, kind: "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK",
    shopId: draft.shopId, inventoryId: draft.inventoryId,
    draftId: draft.draftId, draftUpdatedAt: draft.draftUpdatedAt,
    title: draft.title, description: draft.description,
    condition: draft.condition, imageRefs: draft.imageRefs,
    priceYen: selected.priceYen, quantity: selected.quantity,
    categoryId: category.categoryId, categoryPath: category.fullPath,
    brandId: brand?.brandId ?? null, brandName: brand?.name ?? null,
    managementCode: mercariManagementCode(draft.inventoryId),
    shipping: { method: "METHOD_TYPE_UNDECIDED", payer: "PAYER_TYPE_SELLER",
      origin: "jp11", duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" },
    status: "PREPARED_NO_SEND",
  } };
}
