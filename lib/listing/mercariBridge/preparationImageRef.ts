import { parseBatchIdFromPhotoAssetId } from "../../photoRegistration/keys";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Stored S3 keys are not URLs. Photo Station's canonical IDs contain #A#. */
export function validPreparationImageRef(image: {
  source?: string; storageKey?: unknown; photoAssetId?: unknown; sortOrder?: unknown;
} | null, index: number): boolean {
  if (!image || image.sortOrder !== index || typeof image.storageKey !== "string" ||
      !image.storageKey || image.storageKey.length > 512 ||
      /[?\x00-\x1f]/.test(image.storageKey) || image.storageKey.includes("://")) return false;
  if (image.source !== "PHOTO_ASSET") return (image.source === undefined || image.source === "INVENTORY") && !image.storageKey.includes("#");
  if (typeof image.photoAssetId !== "string") return false;
  const batchId = parseBatchIdFromPhotoAssetId(image.photoAssetId);
  if (!batchId) return UUID.test(image.photoAssetId) && !image.storageKey.includes("#");
  if (!UUID.test(batchId) || !/^[A-Za-z0-9_-]{1,128}$/.test(image.photoAssetId.slice(batchId.length + 3))) return false;
  return ["jpg", "jpeg", "png", "webp"].some(ext =>
    image.storageKey === `photo-batches/${batchId}/processed/${image.photoAssetId}.${ext}`);
}
