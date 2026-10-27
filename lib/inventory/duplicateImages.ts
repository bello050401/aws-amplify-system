import type { InventoryImageRecord } from './imageTypes';
import type { WebPhotoAssetView } from '@/lib/photoRegistration/webAdapter';
import { extensionForMimeType, photoAssetS3Key } from '@/lib/photoRegistration/types';
import { resolveProductGallerySource } from '@/lib/photoRegistration/gallerySelection';

/** Copy-source metadata exists only in the unsaved form; saved images own new inventory keys. */
export type DuplicateInventoryImage = InventoryImageRecord & { sourceBucket?: string };

/** PhotoAsset IDs include their batch ID and #A# separator; originals must never be copied here. */
export function isPhotoProcessedCopyKey(key: string): boolean {
  const match = /^photo-batches\/([a-zA-Z0-9-]+)\/processed\/([a-zA-Z0-9-]+)(?:#A#([a-zA-Z0-9-]+))?\.(jpg|png|webp)$/.exec(key);
  return !!match && (!match[3] || match[1] === match[2]);
}

export function buildDuplicateImages(images: InventoryImageRecord[], assets: WebPhotoAssetView[], photoBucket?: string) {
  const ready = assets.filter(asset => !asset.isDeleted && !asset.purgeStartedAt && !asset.purgedAt && asset.status === 'READY')
    .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  if (ready.length && !photoBucket) throw new Error('商品画像の保存先を確認できません。再読み込みしてください。');
  const photos: DuplicateInventoryImage[] = ready.map(asset => ({
    storageKey: photoAssetS3Key(asset.photoBatchId, asset.id, 'PROCESSED', extensionForMimeType(asset.declared.PROCESSED.mimeType)),
    sourceBucket: photoBucket,
    sortOrder: asset.sequence,
    type: asset.inventoryImageType === 'DAMAGE' ? 'DAMAGE' : 'NORMAL',
    isPrimary: asset.inventoryIsPrimary === true,
    sourceSystem: null, sourceUrl: null,
    // Photo thumbnails belong to a different bucket. Generate fresh inventory derivatives at save.
    thumbnailKey: null, mediumKey: null,
    originalHash: asset.declared.PROCESSED.sha256, classification: null,
  }));
  const legacy = [...images].sort((a, b) => a.sortOrder - b.sortOrder);
  const gallery = resolveProductGallerySource(legacy, ready);
  const primaryKey = gallery.kind === 'PHOTO_ASSET'
    ? photos[ready.findIndex(asset => asset.id === gallery.assets[0]?.id)]?.storageKey
    : gallery.images[0]?.storageKey;
  const combined = [...legacy.map(image => ({ ...image })), ...photos];
  const unique = combined.filter((image, index) => combined.findIndex(other => other.storageKey === image.storageKey) === index);
  const normal = unique.filter(image => image.type === 'NORMAL').sort((a, b) => Number(b.storageKey === primaryKey) - Number(a.storageKey === primaryKey));
  const damage = unique.filter(image => image.type === 'DAMAGE');
  const normalize = (list: DuplicateInventoryImage[]) => list.map((image, sortOrder) => ({
    ...image, sortOrder, isPrimary: image.type === 'NORMAL' && image.storageKey === primaryKey,
  }));
  const previewUrls: Record<string, string> = {};
  ready.forEach((asset, index) => {
    const url = asset.processedUrl ?? asset.thumbnailUrl;
    if (url) previewUrls[photos[index].storageKey] = url;
  });
  return { normal: normalize(normal), damage: normalize(damage), previewUrls };
}
