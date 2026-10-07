"use server";

import { getMercariPrivateCreatePreparationAction } from
  "@/app/actions/mercariPrivateCreatePreparation";
import { prepareMercariManualListingPackAction } from
  "@/app/actions/mercariManualListingPack";
import { B005396_INVENTORY_ID, runB005396GeneralPreparation } from
  "@/lib/listing/mercariBridge/b005396GeneralPreparation";

/** Read BELLO twice and return a review pack. This action never queues or sends. */
export async function prepareB005396GeneralPreparationAction(selected: {
  quantity: number; categoryId: string; brandId: string | null;
}) {
  return runB005396GeneralPreparation(selected, {
    readSource: () => getMercariPrivateCreatePreparationAction(B005396_INVENTORY_ID),
    readPack: chosen => prepareMercariManualListingPackAction(B005396_INVENTORY_ID,
      chosen),
  });
}
