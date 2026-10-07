import type { PrivateCreatePreparation } from
  "@/app/actions/mercariPrivateCreatePreparation";
import type { MercariManualListingPack } from
  "@/app/actions/mercariManualListingPack";
import type { getMercariPrivateCreatePreparationAction } from
  "@/app/actions/mercariPrivateCreatePreparation";
import type { prepareMercariManualListingPackAction } from
  "@/app/actions/mercariManualListingPack";

export const B005396_INVENTORY_ID = "2c53f36a-7a60-4e34-801d-8abc24f6cfc0";
export const B005396_REVIEW_PRICE_YEN = 99_999;

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const SHOPS_SHIPPING = { method: "METHOD_TYPE_UNDECIDED",
  payer: "PAYER_TYPE_SELLER", origin: "jp11",
  duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" };

/** Confirm that a no-send pack still reflects the saved BELLO EC draft. */
export function inspectB005396GeneralPreparation(
  source: PrivateCreatePreparation, pack: MercariManualListingPack,
) {
  if (source.schemaVersion !== 1 || source.kind !== "BELLO_PRIVATE_CREATE_PREPARATION" ||
      source.inventoryId.toLowerCase() !== B005396_INVENTORY_ID ||
      source.inventoryCode !== "B005396" ||
      pack.inventoryId.toLowerCase() !== B005396_INVENTORY_ID ||
      pack.priceYen !== B005396_REVIEW_PRICE_YEN ||
      pack.status !== "PREPARED_NO_SEND" ||
      pack.shopId !== source.shopId || pack.draftId !== source.draftId ||
      pack.draftUpdatedAt !== source.draftUpdatedAt ||
      pack.title !== source.title || pack.description !== source.description ||
      pack.condition !== source.condition ||
      !same(pack.imageRefs, source.imageRefs) ||
      pack.quantity < 1 || pack.quantity > source.quantity ||
      !pack.categoryId || !pack.categoryPath.startsWith("家具・インテリア > ") ||
      !same(pack.shipping, SHOPS_SHIPPING) ||
      pack.managementCode !==
        `BELLO_${B005396_INVENTORY_ID.replace(/-/g, "").toUpperCase()}` ||
      !["KAZAI", "SAGAWA"].includes(source.shippingMethod)) return null;
  return {
    sourceInventoryCode: source.inventoryCode,
    sourcePriceYen: source.priceYen,
    sourceQuantity: source.quantity,
    sourceShippingMethod: source.shippingMethod,
    selectedQuantity: pack.quantity,
    selectedCategoryId: pack.categoryId,
    selectedCategoryPath: pack.categoryPath,
    categoryEvidence: "ADMIN_SELECTED_MASTER" as const,
    shopsShipping: pack.shipping,
    imageCount: pack.imageRefs.length,
    imageEvidence: "SAVED_REFERENCES_ONLY" as const,
    shippingReviewRequired: true as const,
    status: "REVIEW_REQUIRED_NO_SEND" as const,
  };
}

export type B005396GeneralReviewEvidence = NonNullable<
  ReturnType<typeof inspectB005396GeneralPreparation>>;

type Selection = { quantity: number; categoryId: string; brandId: string | null };
type SourceResult = Awaited<ReturnType<typeof getMercariPrivateCreatePreparationAction>>;
type PackResult = Awaited<ReturnType<typeof prepareMercariManualListingPackAction>>;

/** Read-only orchestration; the only dependencies are BELLO draft readers. */
export async function runB005396GeneralPreparation(selected: Selection, readers: {
  readSource: () => Promise<SourceResult>;
  readPack: (selected: { priceYen: number } & Selection) => Promise<PackResult>;
}) {
  if (!selected || !Number.isSafeInteger(selected.quantity) ||
      selected.quantity < 1 || typeof selected.categoryId !== "string" ||
      (selected.brandId !== null && typeof selected.brandId !== "string"))
    return { ok: false as const, code: "INVALID_SELECTION" as const };
  const source = await readers.readSource();
  if (!source.ok) return { ok: false as const, code: source.code };
  const current = await readers.readPack({
    priceYen: B005396_REVIEW_PRICE_YEN, ...selected,
  });
  if (!current.ok) return { ok: false as const, code: current.code };
  if (current.pack.quantity !== selected.quantity ||
      current.pack.categoryId !== selected.categoryId ||
      current.pack.brandId !== selected.brandId)
    return { ok: false as const,
      code: "SOURCE_CHANGED_OR_UNVERIFIED" as const };
  const evidence = inspectB005396GeneralPreparation(source.preparation, current.pack);
  if (!evidence) return { ok: false as const,
    code: "SOURCE_CHANGED_OR_UNVERIFIED" as const };
  return { ok: true as const, pack: current.pack, evidence,
    allowFinalCreate: false as const };
}
