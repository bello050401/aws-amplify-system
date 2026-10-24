import {signInventoryListKey} from "@/lib/inventory/listImageUrls";


import { listInventoryPrimaryPhotoThumbnailsAction } from "@/app/actions/photoRegistration";
import { resolveListPhotoUrl } from "@/lib/photoRegistration/gallerySelection";
import type { InventoryListRow } from "@/lib/inventory/queries";
import type { InventoryThumbnail } from "@/mobile/src/domain/inventory";

/** Called only after the mobile staff guard. Uses the Web system's primary-image rules. */
export async function inventoryThumbnails(rows: InventoryListRow[]): Promise<InventoryThumbnail[]> {
  const [photoResult,signed] = await Promise.all([listInventoryPrimaryPhotoThumbnailsAction(rows.map(row=>row.id)).catch(()=>null),Promise.all(rows.map(row=>{const key=row.mainImageThumbnailKey??row.mainImageStorageKey;return key?signInventoryListKey(key):Promise.resolve(null);}))]);
  return Promise.all(rows.map(async (row,index) => {
    const photoUrl = resolveListPhotoUrl(row.mainImageIsPrimary, photoResult?.ok ? photoResult.value[row.id] : null);
    const thumbnailUrl = photoUrl ?? signed[index];
    return { id: row.id, updatedAt: row.updatedAt, thumbnailUrl };
  }));
}
