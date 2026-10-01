import type { WebPhotoAssetView } from "./webAdapter";
import type { InventoryImageRecord } from "@/lib/inventory/imageTypes";
import type { ListingImageRef } from "@/lib/listing/types";

export type PhotoThumbnailChoice = { url: string | null; explicitPrimary: boolean } | null;

/** 一覧も詳細と同じ明示指定順で写真URLを採用する。 */
export function resolveListPhotoUrl(inventoryExplicitPrimary: boolean, photo: PhotoThumbnailChoice | undefined): string | null {
  if (!photo) return null;
  return photo.explicitPrimary || !inventoryExplicitPrimary ? photo.url : null;
}

/** 再取得でも商品/傷の区分と閲覧中の写真を維持する。 */
export function refreshGallerySelection(all: WebPhotoAssetView[], damageGallery: boolean, selectedId: string) {
  const assets = all
    .filter(asset => !asset.isDeleted && asset.status === "READY" && (asset.inventoryImageType === "DAMAGE") === damageGallery)
    .sort((a, b) => Number(Boolean(b.inventoryIsPrimary)) - Number(Boolean(a.inventoryIsPrimary)) || a.sequence - b.sequence || a.id.localeCompare(b.id));
  return { assets, selected: Math.max(0, assets.findIndex(asset => asset.id === selectedId)) };
}

/** 明示した主画像を優先する。ECでは有効な保存済み先頭画像を優先する。 */
export function resolveProductGallerySource(images: InventoryImageRecord[], photoAssets: WebPhotoAssetView[], preferred?: ListingImageRef | null) {
  const assets = refreshGallerySelection(photoAssets, false, "").assets;
  const normalImages = images.filter(image => image.type === "NORMAL");
  const preferredImage = preferred && (preferred.source === "INVENTORY" || !preferred.source)
    ? normalImages.find(image => image.storageKey === preferred.storageKey) : null;
  const preferredAsset = preferred ? assets.find(asset => asset.id === preferred.photoAssetId) : null;
  const explicitPhoto = assets.find(asset => asset.inventoryIsPrimary);
  const explicitInventory = normalImages.find(image => image.isPrimary);
  const inventoryTop = preferredImage ?? explicitInventory ?? normalImages[0];
  if (preferredImage || (!preferredAsset && !explicitPhoto && explicitInventory) || (!assets.length && inventoryTop)) {
    return { kind: "INVENTORY" as const, images: inventoryTop ? [inventoryTop, ...normalImages.filter(image => image.storageKey !== inventoryTop.storageKey)] : normalImages };
  }
  if (assets.length) {
    const top = preferredAsset ?? explicitPhoto ?? assets[0];
    return { kind: "PHOTO_ASSET" as const, assets: [top, ...assets.filter(asset => asset.id !== top.id)] };
  }
  return { kind: "INVENTORY" as const, images: normalImages };
}
