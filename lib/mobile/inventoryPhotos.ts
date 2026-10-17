import { createHash } from "node:crypto";
import { effectiveHeroKey, type InventoryImageRecord } from "../inventory/imageTypes";
import { resolveProductGallerySource } from "../photoRegistration/gallerySelection";
import type { WebPhotoAssetView } from "../photoRegistration/webAdapter";
import type { InventoryPhoto } from "../../mobile/src/domain/inventory";

const imageId = (key: string) => `inventory-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;

/** All existing Web image sources, with the same primary-image precedence. Never truncate to a screenshot's count. */
export async function mobileInventoryPhotos(images: InventoryImageRecord[], assets: WebPhotoAssetView[], sign: (key: string) => Promise<string>): Promise<InventoryPhoto[]> {
  const uniqueImages = [...new Map([...images].sort((a, b) => a.sortOrder - b.sortOrder).map(photo => [photo.storageKey, photo])).values()];
  const uniqueAssets = [...new Map(assets.filter(photo => !photo.isDeleted && photo.status === "READY").map(photo => [photo.id, photo])).values()];
  const chosen = resolveProductGallerySource(uniqueImages, uniqueAssets);
  const primaryId = chosen.kind === "INVENTORY" ? chosen.images[0] && imageId(chosen.images[0].storageKey) : chosen.assets[0] && `photo-${chosen.assets[0].id}`;
  const signed = new Map<string, Promise<string | null>>();
  const safeSign = (key: string) => {
    if (!signed.has(key)) signed.set(key, sign(key).catch(() => null));
    return signed.get(key)!;
  };
  const photos: InventoryPhoto[] = new Array(uniqueImages.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, uniqueImages.length) }, async () => {
    while (next < uniqueImages.length) {
      const index = next++, photo = uniqueImages[index];
      const [url, fullUrl] = await Promise.all([safeSign(effectiveHeroKey(photo)), safeSign(photo.storageKey)]);
      photos[index] = { id: imageId(photo.storageKey), url, fullUrl, primary: imageId(photo.storageKey) === primaryId, type: photo.type, source: "INVENTORY" };
    }
  }));
  photos.push(...uniqueAssets.map(photo => ({
    id: `photo-${photo.id}`, url: photo.thumbnailUrl ?? photo.processedUrl, fullUrl: photo.processedUrl,
    primary: `photo-${photo.id}` === primaryId, type: photo.inventoryImageType === "DAMAGE" ? "DAMAGE" as const : "NORMAL" as const, source: "PHOTO_ASSET" as const,
  })));
  return photos;
}
