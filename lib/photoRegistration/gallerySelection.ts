import type { WebPhotoAssetView } from "./webAdapter";
import type { InventoryImageRecord } from "@/lib/inventory/imageTypes";

/** 再取得でも商品/傷の区分と閲覧中の写真を維持する。 */
export function refreshGallerySelection(all: WebPhotoAssetView[], damageGallery: boolean, selectedId: string) {
  const assets = all
    .filter(asset => !asset.isDeleted && asset.status === "READY" && (asset.inventoryImageType === "DAMAGE") === damageGallery)
    .sort((a, b) => Number(Boolean(b.inventoryIsPrimary)) - Number(Boolean(a.inventoryIsPrimary)) || a.sequence - b.sequence || a.id.localeCompare(b.id));
  return { assets, selected: Math.max(0, assets.findIndex(asset => asset.id === selectedId)) };
}

/** 在庫の商品画像表示は撮影画像を優先し、無い場合だけ旧画像を使う。 */
export function resolveProductGallerySource(images: InventoryImageRecord[], photoAssets: WebPhotoAssetView[]) {
  const assets = refreshGallerySelection(photoAssets, false, "").assets;
  return assets.length > 0
    ? { kind: "PHOTO_ASSET" as const, assets }
    : { kind: "INVENTORY" as const, images };
}
