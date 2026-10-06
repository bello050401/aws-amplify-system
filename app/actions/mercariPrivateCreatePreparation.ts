"use server";

import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { getChannelListing, getListingDraftForInventory } from "@/lib/listing/service";
import { mercariBridgeReadRepository } from "@/lib/listing/mercariBridge/repository";

const SHOP_ID = "evkhihBFFNn5hukMS9s36H";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SKU = /^[A-Za-z0-9_-]{1,40}$/;
const CONDITIONS = new Set(["NEW", "LIKE_NEW", "NO_NOTABLE_DAMAGE",
  "SLIGHT_DAMAGE", "DAMAGE", "BAD"]);

export type PrivateCreatePreparation = {
  schemaVersion: 1;
  kind: "BELLO_PRIVATE_CREATE_PREPARATION";
  shopId: string;
  inventoryId: string;
  inventoryCode: string;
  draftId: string;
  draftUpdatedAt: string;
  title: string;
  description: string;
  priceYen: number;
  quantity: number;
  condition: string;
  shippingMethod: "KAZAI" | "SAGAWA";
  imageRefs: { source: "INVENTORY" | "PHOTO_ASSET"; storageKey: string;
    sortOrder: number; photoAssetId: string | null }[];
};

/** Read BELLO's saved EC draft for a local, no-send preparation file. */
export async function getMercariPrivateCreatePreparationAction(inventoryId: string): Promise<
  { ok: true; preparation: PrivateCreatePreparation } |
  { ok: false; code: "FORBIDDEN" | "INCOMPLETE_DRAFT" | "EXISTING_LINK" |
      "READ_UNAVAILABLE" }
> {
  if (await getInventoryRole() !== "ADMIN") return { ok: false, code: "FORBIDDEN" };
  if (!UUID.test(inventoryId)) return { ok: false, code: "INCOMPLETE_DRAFT" };
  try {
    const [inventory, draft, channel, binding] = await Promise.all([
      getInventoryDetail(inventoryId), getListingDraftForInventory(inventoryId),
      getChannelListing(inventoryId, "MERCARI_SHOPS"),
      mercariBridgeReadRepository.getBinding(inventoryId),
    ]);
    if (channel || binding) return { ok: false, code: "EXISTING_LINK" };
    if (!inventory || !draft || draft.inventoryId !== inventory.id ||
        !SKU.test(inventory.sku) || !UUID.test(draft.id) ||
        typeof draft.updatedAt !== "string" ||
        !ISO.test(draft.updatedAt) || !Number.isFinite(Date.parse(draft.updatedAt)) ||
        !draft.title.trim() || draft.title.length > 130 ||
        !draft.description?.trim() || draft.description.length > 3000 ||
        !Number.isSafeInteger(draft.price) || (draft.price ?? 0) < 300 ||
        (draft.price ?? 0) > 9_999_999 ||
        !Number.isSafeInteger(inventory.quantity) || inventory.quantity < 1 ||
        typeof draft.condition !== "string" || !CONDITIONS.has(draft.condition) ||
        !["KAZAI", "SAGAWA"].includes(draft.shippingMethod) ||
        !Array.isArray(draft.images) || draft.images.length < 1 || draft.images.length > 20 ||
        draft.images.some((image, index) => !image || image.sortOrder !== index ||
          typeof image.storageKey !== "string" || !image.storageKey ||
          image.storageKey.length > 512 || /[?#\x00-\x1f]/.test(image.storageKey) ||
          image.storageKey.includes("://") ||
          (image.source === "PHOTO_ASSET" ? !UUID.test(image.photoAssetId ?? "") :
            image.source !== undefined && image.source !== "INVENTORY")))
      return { ok: false, code: "INCOMPLETE_DRAFT" };
    const preparation: PrivateCreatePreparation = {
      schemaVersion: 1, kind: "BELLO_PRIVATE_CREATE_PREPARATION", shopId: SHOP_ID,
      inventoryId: inventory.id, inventoryCode: inventory.sku,
      draftId: draft.id, draftUpdatedAt: draft.updatedAt,
      title: draft.title, description: draft.description,
      priceYen: draft.price as number, quantity: inventory.quantity,
      condition: draft.condition as string, shippingMethod: draft.shippingMethod,
      imageRefs: draft.images.map(image => ({ source: image.source ?? "INVENTORY",
        storageKey: image.storageKey, sortOrder: image.sortOrder,
        photoAssetId: image.source === "PHOTO_ASSET" ? image.photoAssetId ?? null : null })),
    };
    return { ok: true, preparation };
  } catch { return { ok: false, code: "READ_UNAVAILABLE" }; }
}
