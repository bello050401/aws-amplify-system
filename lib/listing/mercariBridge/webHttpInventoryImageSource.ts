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
  readStorageBytes: (storageKey: string, maxBytes: number) =>
    Promise<Uint8Array | null>;
};

/** Read BELLO's frozen EC image, then prove its current source bytes before
 * the observed HTTPS upload. This only reads BELLO; it never contacts Shops.
 */
export async function prepareInventoryImageForObservedUpload(
  job: WebHttpDraftJob, ports: InventoryImageSourcePorts,
): Promise<{ prepared: PreparedObservedJpeg;
  sourceProof: ObservedImageSourceProof } | null> {
  if (!initialWebHttpExecutionState(job) || !ports ||
      typeof ports.readInventory !== "function" ||
      typeof ports.readStorageBytes !== "function") return null;
  let imageRef: { storageKey: string; source: string };
  try {
    const snapshot = JSON.parse(job.snapshotJson);
    if (snapshot?.pack?.inventoryId !== job.inventoryId ||
        !Array.isArray(snapshot.pack.imageRefs) ||
        snapshot.pack.imageRefs.length !== 1) return null;
    imageRef = snapshot.pack.imageRefs[0];
  } catch { return null; }
  if (imageRef?.source !== "INVENTORY" ||
      typeof imageRef.storageKey !== "string" || !imageRef.storageKey)
    return null;
  try {
    const inventory = await ports.readInventory(job.inventoryId);
    if (!inventory || inventory.id !== job.inventoryId ||
        !Array.isArray(inventory.images)) return null;
    const matches = inventory.images.filter(image =>
      image.storageKey === imageRef.storageKey);
    if (matches.length !== 1) return null;
    const bytes = await ports.readStorageBytes(imageRef.storageKey,
      MAX_SOURCE_BYTES);
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
