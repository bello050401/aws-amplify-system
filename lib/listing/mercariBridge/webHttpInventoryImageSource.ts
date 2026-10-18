import "server-only";

import { createHash } from "node:crypto";
import type { WebHttpDraftJob } from "./webHttpDraftJob.ts";
import { initialWebHttpExecutionState } from "./webHttpExecutionGate.ts";
import { prepareObservedJpeg, type PreparedObservedJpeg } from
  "./webHttpObservedImageAsset.ts";
import type { ObservedImageSourceProof } from
  "./webHttpObservedImageUpload.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
type InventoryImage = { storageKey: string; originalHash: string | null };
export type InventoryImageSourcePorts = {
  readInventory: (inventoryId: string) => Promise<{
    id: string; images: InventoryImage[] } | null>;
  /** Must verify READY/nondeleted asset and current LINKED batch ownership. */
  readPhotoAsset?: (inventoryId: string, photoAssetId: string) => Promise<InventoryImage | null>;
  readStorageBytes: (storageKey: string, maxBytes: number, source?: "INVENTORY" | "PHOTO_ASSET") =>
    Promise<Uint8Array | null>;
};

/** Read BELLO's frozen EC image, then prove its current source bytes before
 * the observed HTTPS upload. This only reads BELLO; it never contacts Shops.
 */
export async function prepareInventoryImageForObservedUpload(
  job: WebHttpDraftJob, ports: InventoryImageSourcePorts, imageIndex = 0,
): Promise<{ prepared: PreparedObservedJpeg;
  sourceProof: ObservedImageSourceProof } | null> {
  if (!initialWebHttpExecutionState(job) || !ports ||
      typeof ports.readInventory !== "function" ||
      typeof ports.readStorageBytes !== "function") return null;
  let imageRef: { storageKey: string; source: string; photoAssetId?: string };
  try {
    const snapshot = JSON.parse(job.snapshotJson);
    if (snapshot?.pack?.inventoryId !== job.inventoryId ||
        !Array.isArray(snapshot.pack.imageRefs) ||
        snapshot.pack.imageRefs.length < 1 || snapshot.pack.imageRefs.length > 20 ||
        !Number.isInteger(imageIndex) || imageIndex < 0 || imageIndex >= snapshot.pack.imageRefs.length) return null;
    imageRef = snapshot.pack.imageRefs[imageIndex];
  } catch { return null; }
  if (!["INVENTORY", "PHOTO_ASSET"].includes(imageRef?.source) ||
      typeof imageRef.storageKey !== "string" || !imageRef.storageKey)
    return null;
  try {
    const inventory = await ports.readInventory(job.inventoryId);
    if (!inventory || inventory.id !== job.inventoryId ||
        !Array.isArray(inventory.images)) return null;
    let matches: InventoryImage[];
    if (imageRef.source === "PHOTO_ASSET") {
      if (!imageRef.photoAssetId || !ports.readPhotoAsset) return null;
      const asset = await ports.readPhotoAsset(job.inventoryId, imageRef.photoAssetId);
      if (!asset || asset.storageKey !== imageRef.storageKey || !asset.originalHash || !SHA256.test(asset.originalHash)) return null;
      matches = [asset];
    } else matches = inventory.images.filter(image => image.storageKey === imageRef.storageKey);
    if (matches.length !== 1) return null;
    const bytes = await ports.readStorageBytes(imageRef.storageKey,
      MAX_SOURCE_BYTES, imageRef.source as "INVENTORY" | "PHOTO_ASSET");
    if (!(bytes instanceof Uint8Array) || bytes.length < 4 ||
        bytes.length > MAX_SOURCE_BYTES) return null;
    const originalSha256 = createHash("sha256").update(bytes).digest("hex");
    const storedHash = matches[0].originalHash;
    if (storedHash !== null && (!SHA256.test(storedHash) ||
        storedHash !== originalSha256)) return null;
    const prepared = await prepareObservedJpeg(bytes, originalSha256);
    return { prepared, sourceProof: {
      snapshotFingerprint: job.snapshotFingerprint,
      inventoryId: job.inventoryId, storageKey: imageRef.storageKey,
      originalSha256, preparedJpegSha256: prepared.preparedJpegSha256,
    } };
  } catch { return null; }
}
