import type { WebPhotoAssetView } from "./webAdapter";

/** 再取得でも商品/傷の区分と閲覧中の写真を維持する。 */
export function refreshGallerySelection(all: WebPhotoAssetView[], damageGallery: boolean, selectedId: string) {
  const assets = all
    .filter(asset => !asset.isDeleted && asset.status === "READY" && (asset.inventoryImageType === "DAMAGE") === damageGallery)
    .sort((a, b) => Number(Boolean(b.inventoryIsPrimary)) - Number(Boolean(a.inventoryIsPrimary)) || a.sequence - b.sequence || a.id.localeCompare(b.id));
  return { assets, selected: Math.max(0, assets.findIndex(asset => asset.id === selectedId)) };
}
