"use server";

import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { getChannelListing, getListingDraftForInventory } from "@/lib/listing/service";
import { mercariBridgeReadRepository } from "@/lib/listing/mercariBridge/repository";

const SHOP_ID = "evkhihBFFNn5hukMS9s36H";
const TEST_INVENTORY_ID = "dd273c1e-9b2a-4013-acc6-c445a481fab8";
const TEST_INTENT = "B005659_SEPARATE_PRIVATE_TEST_99999";
const TEST_MANAGEMENT_CODE = "TEST_B005659_E51E4F6B7B86DD150546";
const EXISTING_PUBLIC_PRODUCT_ID = "2JWp7EJx6aqKfn6dTXc5Q9";
const RESERVED_TEST_CODES = new Set(["B005659", TEST_MANAGEMENT_CODE]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SKU = /^[A-Za-z0-9_-]{1,40}$/;
const CONDITIONS = new Set(["NEW", "LIKE_NEW", "NO_NOTABLE_DAMAGE",
  "SLIGHT_DAMAGE", "DAMAGE", "BAD"]);

type PreparationContent = {
  shopId: string;
  inventoryId: string;
  draftId: string;
  draftUpdatedAt: string;
  title: string;
  description: string;
  quantity: number;
  condition: string;
  shippingMethod: "KAZAI" | "SAGAWA";
  imageRefs: { source: "INVENTORY" | "PHOTO_ASSET"; storageKey: string;
    sortOrder: number; photoAssetId: string | null }[];
};
export type PrivateCreatePreparation = PreparationContent & ({
  schemaVersion: 1;
  kind: "BELLO_PRIVATE_CREATE_PREPARATION";
  inventoryCode: string;
  priceYen: number;
} | {
  schemaVersion: 2;
  kind: "BELLO_SEPARATE_PRIVATE_TEST_PREPARATION";
  sourceInventoryCode: "B005659";
  sourcePriceYen: 54200;
  testManagementCode: typeof TEST_MANAGEMENT_CODE;
  testPriceYen: 99999;
  visibility: "PRIVATE_ONLY";
  doNotModifyProductId: typeof EXISTING_PUBLIC_PRODUCT_ID;
  contentEvidence: "BELLO_SAVED_DRAFT_ONLY";
});

/** Read BELLO's saved EC draft for a local, no-send preparation file. */
export async function getMercariPrivateCreatePreparationAction(
  inventoryId: string, intent?: string,
): Promise<
  { ok: true; preparation: PrivateCreatePreparation } |
  { ok: false; code: "FORBIDDEN" | "INCOMPLETE_DRAFT" | "EXISTING_LINK" |
      "READ_UNAVAILABLE" | "TEST_INTENT_REQUIRED" }
> {
  if (await getInventoryRole() !== "ADMIN") return { ok: false, code: "FORBIDDEN" };
  if (!UUID.test(inventoryId)) return { ok: false, code: "INCOMPLETE_DRAFT" };
  const isPrivateTest = inventoryId.toLowerCase() === TEST_INVENTORY_ID;
  if ((isPrivateTest && intent !== TEST_INTENT) || (!isPrivateTest && intent !== undefined))
    return { ok: false, code: "TEST_INTENT_REQUIRED" };
  try {
    const [inventory, draft, channel, binding] = await Promise.all([
      getInventoryDetail(inventoryId), getListingDraftForInventory(inventoryId),
      getChannelListing(inventoryId, "MERCARI_SHOPS"),
      mercariBridgeReadRepository.getBinding(inventoryId),
    ]);
    if (channel || binding) return { ok: false, code: "EXISTING_LINK" };
    if (!inventory || !draft || draft.inventoryId !== inventory.id ||
        typeof inventory.sku !== "string" || !SKU.test(inventory.sku) ||
        (!isPrivateTest && RESERVED_TEST_CODES.has(inventory.sku.toUpperCase())) ||
        !UUID.test(draft.id) ||
        typeof draft.updatedAt !== "string" ||
        !ISO.test(draft.updatedAt) || !Number.isFinite(Date.parse(draft.updatedAt)) ||
        !draft.title.trim() || draft.title.length > 130 ||
        !draft.description?.trim() || draft.description.length > 3000 ||
        !Number.isSafeInteger(draft.price) || (draft.price ?? 0) < 300 ||
        (draft.price ?? 0) > 9_999_999 ||
        (isPrivateTest && (inventory.sku !== "B005659" || draft.price !== 54200 ||
          inventory.quantity !== 1 || draft.condition !== "NO_NOTABLE_DAMAGE" ||
          draft.shippingMethod !== "KAZAI")) ||
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
    const content: PreparationContent = {
      shopId: SHOP_ID, inventoryId: inventory.id,
      draftId: draft.id, draftUpdatedAt: draft.updatedAt,
      title: draft.title, description: draft.description,
      quantity: inventory.quantity,
      condition: draft.condition as string, shippingMethod: draft.shippingMethod,
      imageRefs: draft.images.map(image => ({ source: image.source ?? "INVENTORY",
        storageKey: image.storageKey, sortOrder: image.sortOrder,
        photoAssetId: image.source === "PHOTO_ASSET" ? image.photoAssetId ?? null : null })),
    };
    const preparation: PrivateCreatePreparation = isPrivateTest ? {
      ...content, schemaVersion: 2,
      kind: "BELLO_SEPARATE_PRIVATE_TEST_PREPARATION",
      sourceInventoryCode: "B005659", sourcePriceYen: 54200,
      testManagementCode: TEST_MANAGEMENT_CODE, testPriceYen: 99999,
      visibility: "PRIVATE_ONLY", doNotModifyProductId: EXISTING_PUBLIC_PRODUCT_ID,
      contentEvidence: "BELLO_SAVED_DRAFT_ONLY",
    } : {
      ...content, schemaVersion: 1, kind: "BELLO_PRIVATE_CREATE_PREPARATION",
      inventoryCode: inventory.sku, priceYen: draft.price as number,
    };
    return { ok: true, preparation };
  } catch { return { ok: false, code: "READ_UNAVAILABLE" }; }
}
