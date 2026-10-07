"use server";

import { getMercariPrivateCreatePreparationAction } from
  "@/app/actions/mercariPrivateCreatePreparation";
import { prepareMercariManualListingPackAction } from
  "@/app/actions/mercariManualListingPack";
import { B005396_INVENTORY_ID, B005396_REVIEW_PRICE_YEN,
  inspectB005396GeneralPreparation } from
  "@/lib/listing/mercariBridge/b005396GeneralPreparation";

/** Read BELLO twice and return a review pack. This action never queues or sends. */
export async function prepareB005396GeneralPreparationAction(selected: {
  quantity: number; categoryId: string; brandId: string | null;
}) {
  if (!selected || !Number.isSafeInteger(selected.quantity) ||
      selected.quantity < 1 || typeof selected.categoryId !== "string" ||
      (selected.brandId !== null && typeof selected.brandId !== "string"))
    return { ok: false as const, code: "INVALID_SELECTION" as const };
  const source = await getMercariPrivateCreatePreparationAction(B005396_INVENTORY_ID);
  if (!source.ok) return { ok: false as const, code: source.code };
  const current = await prepareMercariManualListingPackAction(B005396_INVENTORY_ID, {
    priceYen: B005396_REVIEW_PRICE_YEN, quantity: selected.quantity,
    categoryId: selected.categoryId, brandId: selected.brandId,
  });
  if (!current.ok) return { ok: false as const, code: current.code };
  const evidence = inspectB005396GeneralPreparation(source.preparation, current.pack);
  if (!evidence) return { ok: false as const,
    code: "SOURCE_CHANGED_OR_UNVERIFIED" as const };
  return { ok: true as const, pack: current.pack, evidence,
    allowFinalCreate: false as const };
}
