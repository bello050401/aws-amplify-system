import assert from "node:assert/strict";
import { mobileInventoryPhotos } from "../lib/mobile/inventoryPhotos";
import { normalizeImageRecord } from "../lib/inventory/imageTypes";
import type { WebPhotoAssetView } from "../lib/photoRegistration/webAdapter";
import { SnapshotStore } from "../mobile/src/domain/snapshot";
import { previewItems } from "../mobile/src/preview/fixture";

async function main() {
  const images = Array.from({ length: 110 }, (_, i) => normalizeImageRecord({ storageKey: `inventory/${i}.jpg`, mediumKey: `inventory/${i}-medium.jpg`, sortOrder: i, type: i === 109 ? "DAMAGE" : "NORMAL", isPrimary: i === 2 }));
  const asset = { id: "camera-1", sequence: 0, status: "READY", isDeleted: false, inventoryIsPrimary: true, thumbnailUrl: "https://example.test/thumb.jpg", processedUrl: "https://example.test/full.jpg" } as WebPhotoAssetView;
  const sign = async (key: string) => { if (key.includes("/50")) throw Error("Unavailable"); return `https://example.test/${key}`; };
  const photos = await mobileInventoryPhotos([...images, images[0]], [asset, asset, { ...asset, id: "deleted", isDeleted: true }], sign);
  assert.equal(photos.length, 111); assert.equal(photos.filter(photo => photo.primary).length, 1);
  assert.equal(photos.find(photo => photo.primary)?.source, "PHOTO_ASSET");
  assert.equal(photos.filter(photo => photo.type === "DAMAGE").length, 1);
  assert.equal(photos.filter(photo => photo.url === null).length, 1);
  const reversed = await mobileInventoryPhotos([...images].reverse(), [asset], sign);
  assert.deepEqual(reversed.map(photo => photo.id), photos.map(photo => photo.id));
  const withoutPhotoPrimary = await mobileInventoryPhotos(images, [{ ...asset, inventoryIsPrimary: false }], sign);
  assert.equal(withoutPhotoPrimary.find(photo => photo.primary)?.source, "INVENTORY");
  const item = { ...previewItems[0], photos, photosComplete: false };
  let stored = "";
  const store = new SnapshotStore({ getItem: async () => stored, setItem: async (_, value) => { stored = value; }, removeItem: async () => {} }, "sample", "isolated");
  await store.write([item], new Date().toISOString());
  assert.deepEqual((await store.read())?.items[0].photos, photos);
  console.log("PASS: all 111 images, source deduplication, primary precedence, damage groups, failed-image placeholder, stable identities and offline snapshot.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
