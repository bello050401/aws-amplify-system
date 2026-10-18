import type { InventoryImageRecord } from "@/lib/inventory/imageTypes";
import { resolveTopImage } from "@/lib/inventory/imageTypes";

/** Prefer the explicitly selected listing photo, then the product gallery's primary photo. */
export function chooseIntroductionPhoto(
  images: InventoryImageRecord[],
  photos: {
    id: string;
    isDeleted: boolean;
    status: string;
    inventoryIsPrimary?: boolean;
    processedUrl: string | null;
    thumbnailUrl: string | null;
  }[],
  selected?: {
    storageKey: string;
    source?: string;
    photoAssetId?: string;
    sortOrder: number;
  }[],
): { kind: "storage"; key: string } | { kind: "photo"; url: string } | null {
  const available = photos.filter((p) => !p.isDeleted && p.status === "READY");
  const first = [...(selected ?? [])].sort(
    (a, b) => a.sortOrder - b.sortOrder,
  )[0];
  const chosen =
    first?.source === "PHOTO_ASSET"
      ? available.find((p) => p.id === first.photoAssetId)
      : null;
  if (chosen?.processedUrl || chosen?.thumbnailUrl)
    return { kind: "photo", url: chosen.processedUrl ?? chosen.thumbnailUrl! };
  const inventory =
    first && first.source !== "PHOTO_ASSET"
      ? images.find((p) => p.storageKey === first.storageKey)
      : null;
  if (inventory)
    return {
      kind: "storage",
      key: inventory.mediumKey ?? inventory.storageKey,
    };
  if (Array.isArray(selected)) return null;
  const photo = available.find((p) => p.inventoryIsPrimary) ?? available[0];
  if (photo?.processedUrl || photo?.thumbnailUrl)
    return { kind: "photo", url: photo.processedUrl ?? photo.thumbnailUrl! };
  const top = resolveTopImage(images);
  return top ? { kind: "storage", key: top.mediumKey ?? top.storageKey } : null;
}
