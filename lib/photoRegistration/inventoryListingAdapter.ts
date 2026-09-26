import type { InventoryImageRecord } from "@/lib/inventory/imageTypes";
import type { ListingImageRef } from "@/lib/listing/types";
import type { WebPhotoAssetView } from "./webAdapter";
import { extensionForMimeType, photoAssetS3Key } from "./types";

export type ListingImageCandidate = {
  ref: ListingImageRef;
  label: string;
  previewUrl: string | null;
  available: boolean;
};

/** 旧Inventory画像とPhotoAssetを、保存元を失わず同じ選択UIへ渡す。 */
export function buildListingImageCandidates(
  inventoryImages: InventoryImageRecord[],
  photoAssets: WebPhotoAssetView[],
): ListingImageCandidate[] {
  const legacy = inventoryImages
    .filter((image) => image.type === "NORMAL")
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((image, index) => ({
      ref: { storageKey: image.storageKey, sortOrder: index, source: "INVENTORY" as const },
      label: `既存画像 ${index + 1}`,
      previewUrl: null,
      available: true,
    }));
  const uploaded = photoAssets
    .filter((asset) => !asset.isDeleted && asset.status === "READY" && asset.inventoryImageType !== "DAMAGE")
    .sort((a, b) => Number(Boolean(b.inventoryIsPrimary)) - Number(Boolean(a.inventoryIsPrimary)) || a.sequence - b.sequence || a.id.localeCompare(b.id))
    .map((asset, index) => ({
      ref: {
        storageKey: photoAssetS3Key(
          asset.photoBatchId,
          asset.id,
          "PROCESSED",
          extensionForMimeType(asset.declared.PROCESSED.mimeType),
        ),
        sortOrder: legacy.length + index,
        source: "PHOTO_ASSET" as const,
        photoAssetId: asset.id,
      },
      label: `撮影画像 ${asset.sequence}`,
      previewUrl: asset.thumbnailUrl,
      available: true,
    }));
  return [...legacy, ...uploaded];
}

/** 未保存の下書きは撮影商品画像を優先する。保存済みの明示選択は維持する。 */
export function initialListingSelection(
  candidates: ListingImageCandidate[],
  saved: ListingImageRef[] | null | undefined,
): ListingImageCandidate[] {
  if (saved?.length) return restoreListingSelection(candidates, saved).selected;
  const photos = candidates.filter((item) => item.ref.source === "PHOTO_ASSET");
  return (photos.length ? photos : candidates.filter((item) => item.ref.source === "INVENTORY")).slice(0, 20);
}

/**
 * 保存済み順序を復元する。削除済み/取得不能なPhotoAssetは選択から外し、
 * 未選択候補は後ろへ残す。旧source未設定はstorageKey一致で復元する。
 */
export function restoreListingSelection(
  candidates: ListingImageCandidate[],
  saved: ListingImageRef[] | null | undefined,
): { selected: ListingImageCandidate[]; available: ListingImageCandidate[]; missing: ListingImageRef[] } {
  const byAsset = new Map(candidates.filter((item) => item.ref.photoAssetId).map((item) => [item.ref.photoAssetId as string, item]));
  const byKey = new Map(candidates.map((item) => [item.ref.storageKey, item]));
  const selected: ListingImageCandidate[] = [];
  const missing: ListingImageRef[] = [];
  const used = new Set<string>();
  for (const ref of [...(saved ?? [])].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const candidate = (ref.photoAssetId ? byAsset.get(ref.photoAssetId) : undefined) ?? byKey.get(ref.storageKey);
    if (!candidate) {
      missing.push(ref);
      continue;
    }
    const identity = candidate.ref.photoAssetId ?? candidate.ref.storageKey;
    if (used.has(identity)) continue;
    used.add(identity);
    selected.push(candidate);
  }
  const available = candidates.filter((item) => !used.has(item.ref.photoAssetId ?? item.ref.storageKey));
  return { selected, available, missing };
}

export function listingRefsFromSelection(selected: ListingImageCandidate[]): ListingImageRef[] {
  if (selected.length > 20) throw new Error("出品画像は20枚まで選択できます。");
  return selected.map((item, index) => ({ ...item.ref, sortOrder: index }));
}
