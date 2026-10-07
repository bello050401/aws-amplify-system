import { createHash } from "node:crypto";

export const B005413_INVENTORY_ID = "5b0f3587-cbbb-4c09-ae78-595b2b3e353f";
export const B005413_TEST_INTENT = "B005413_SEPARATE_PRIVATE_TEST_99999";
export const B005413_TEST_CODE = "TEST_B005413_B63EF3F86211FFE0F890D81E";
const DRAFT_ID = "7bbdd5b7-5df6-4b93-97ba-dd7f675feab9";
const DRAFT_UPDATED_AT = "2026-09-02T00:53:48.206Z";
const TITLE = "Anonymous Lounge Chair";
const DESCRIPTION_SHA256 = "c1b95825120d1851f698fc2f4095d627ce3639f2791c88265a7466328dbb8586";
const IMAGE_KEY = "inventory/16fd3352-1e54-4b5e-a2ab-8e20ef4bafa9.jpg";

type SavedContent = {
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

/** BELLO's saved draft is the only source of content; the test override is fixed. */
export function buildB005413PrivatePreparation(content: SavedContent,
  sourceSku: string, savedPriceYen: number) {
  if (!content || content.shopId !== "evkhihBFFNn5hukMS9s36H" ||
      content.inventoryId !== B005413_INVENTORY_ID ||
      sourceSku !== "B005413" || savedPriceYen !== 30000 ||
      content.draftId !== DRAFT_ID ||
      content.draftUpdatedAt !== DRAFT_UPDATED_AT ||
      content.title !== TITLE || typeof content.description !== "string" ||
      createHash("sha256").update(content.description).digest("hex") !==
        DESCRIPTION_SHA256 ||
      content.quantity !== 1 || content.condition !== "NO_NOTABLE_DAMAGE" ||
      content.shippingMethod !== "KAZAI" || !Array.isArray(content.imageRefs) ||
      content.imageRefs.length !== 1 ||
      content.imageRefs[0].source !== "INVENTORY" ||
      content.imageRefs[0].storageKey !== IMAGE_KEY ||
      content.imageRefs[0].sortOrder !== 0 ||
      content.imageRefs[0].photoAssetId !== null) return null;
  return { ...content, schemaVersion: 2 as const,
    kind: "BELLO_SEPARATE_PRIVATE_TEST_PREPARATION" as const,
    sourceInventoryCode: "B005413" as const, sourcePriceYen: 30000 as const,
    testManagementCode: B005413_TEST_CODE, testPriceYen: 99999 as const,
    visibility: "PRIVATE_ONLY" as const, doNotModifyProductId: null,
    contentEvidence: "BELLO_SAVED_DRAFT_ONLY" as const };
}
