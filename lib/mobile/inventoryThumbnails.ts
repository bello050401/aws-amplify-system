import { cookies } from "next/headers";
import { getUrl } from "aws-amplify/storage/server";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";
import { listInventoryPrimaryPhotoThumbnailsAction } from "@/app/actions/photoRegistration";
import { resolveListPhotoUrl } from "@/lib/photoRegistration/gallerySelection";
import type { InventoryListRow } from "@/lib/inventory/queries";
import type { InventoryThumbnail } from "@/mobile/src/domain/inventory";

/** Called only after the mobile staff guard. Uses the Web system's primary-image rules. */
export async function inventoryThumbnails(rows: InventoryListRow[]): Promise<InventoryThumbnail[]> {
  const photoResult = await listInventoryPrimaryPhotoThumbnailsAction(rows.map(row => row.id)).catch(() => null);
  return runWithAmplifyServerContext({ nextServerContext: { cookies }, operation: async context => Promise.all(rows.map(async row => {
    const key = row.mainImageThumbnailKey ?? row.mainImageStorageKey;
    const photoUrl = resolveListPhotoUrl(row.mainImageIsPrimary, photoResult?.ok ? photoResult.value[row.id] : null);
    const thumbnailUrl = photoUrl ?? (key ? await getUrl(context, { path: key, options: { expiresIn: 900 } })
      .then(image => image.url.toString()).catch(() => null) : null);
    return { id: row.id, updatedAt: row.updatedAt, thumbnailUrl };
  })) });
}
