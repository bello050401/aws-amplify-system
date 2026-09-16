import assert from "node:assert/strict";
import type { InventoryImageRecord } from "../lib/inventory/imageTypes";
import type { WebPhotoAssetView } from "../lib/photoRegistration/webAdapter";
import {
  buildListingImageCandidates,
  listingRefsFromSelection,
  restoreListingSelection,
} from "../lib/photoRegistration/inventoryListingAdapter";
import { normalizeListingImages } from "../lib/listing/service";

type Test = { name: string; run: () => void | Promise<void> };
const tests: Test[] = [];
const test = (name: string, run: Test["run"]) => tests.push({ name, run });

const inventoryImage = (key: string, sortOrder: number, type: "NORMAL" | "DAMAGE" = "NORMAL"): InventoryImageRecord => ({
  storageKey: key, sortOrder, type, isPrimary: sortOrder === 0, sourceSystem: null, sourceUrl: null,
  thumbnailKey: null, mediumKey: null, originalHash: null, classification: null,
});
const photoAsset = (id: string, sequence: number, overrides: Partial<WebPhotoAssetView> = {}): WebPhotoAssetView => ({
  id, photoBatchId: "batch-1", clientAssetId: `client-${id}`, sequence, status: "READY", isDeleted: false,
  statusBeforeDelete: null, sourceType: "PHOTO_STATION", revision: 0,
  declared: {
    PROCESSED: { mimeType: "image/jpeg", fileSize: 100, sha256: "a".repeat(64) },
    THUMBNAIL: { mimeType: "image/jpeg", fileSize: 10, sha256: "b".repeat(64) },
  },
  thumbnailUrl: `https://example.invalid/${id}/thumb`, processedUrl: `https://example.invalid/${id}/full`,
  ...overrides,
});

test("既存画像とPhotoAssetを保存元付きで統合する", () => {
  const candidates = buildListingImageCandidates([inventoryImage("inventory/a.jpg", 0)], [photoAsset("asset-1", 1)]);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].ref.source, "INVENTORY");
  assert.equal(candidates[1].ref.source, "PHOTO_ASSET");
  assert.equal(candidates[1].ref.photoAssetId, "asset-1");
  assert.match(candidates[1].ref.storageKey, /photo-batches\/batch-1\/processed\/asset-1\.jpg$/);
});

test("傷画像・削除済み・未完了PhotoAssetは出品候補へ入れない", () => {
  const candidates = buildListingImageCandidates(
    [inventoryImage("normal.jpg", 0), inventoryImage("damage.jpg", 1, "DAMAGE")],
    [photoAsset("deleted", 1, { isDeleted: true }), photoAsset("uploading", 2, { status: "UPLOADING" })],
  );
  assert.deepEqual(candidates.map((item) => item.ref.storageKey), ["normal.jpg"]);
});

test("旧source未設定をstorageKeyで復元し、PhotoAsset順序も維持する", () => {
  const candidates = buildListingImageCandidates([inventoryImage("inventory/a.jpg", 0)], [photoAsset("asset-1", 1)]);
  const restored = restoreListingSelection(candidates, [
    { storageKey: candidates[1].ref.storageKey, sortOrder: 0, source: "PHOTO_ASSET", photoAssetId: "asset-1" },
    { storageKey: "inventory/a.jpg", sortOrder: 1 },
  ]);
  assert.deepEqual(restored.selected.map((item) => item.ref.photoAssetId ?? item.ref.storageKey), ["asset-1", "inventory/a.jpg"]);
  assert.equal(restored.available.length, 0);
});

test("消失した参照をmissingとして返し、選択済みには混ぜない", () => {
  const restored = restoreListingSelection([], [{ storageKey: "missing.jpg", sortOrder: 0 }]);
  assert.equal(restored.selected.length, 0);
  assert.equal(restored.missing.length, 1);
});

test("選択順を0始まりへ正規化し、重複を拒否する", () => {
  const candidates = buildListingImageCandidates([inventoryImage("a.jpg", 0), inventoryImage("b.jpg", 1)], []);
  assert.deepEqual(listingRefsFromSelection([candidates[1], candidates[0]]).map((ref) => [ref.storageKey, ref.sortOrder]), [["b.jpg", 0], ["a.jpg", 1]]);
  assert.throws(() => normalizeListingImages([{ storageKey: "a.jpg", sortOrder: 0 }, { storageKey: "a.jpg", sortOrder: 1 }]), /重複/);
});

async function main(): Promise<void> {
  let passed = 0;
  const failures: { name: string; error: unknown }[] = [];
  for (const entry of tests) {
    try { await entry.run(); passed += 1; }
    catch (error) { failures.push({ name: entry.name, error }); }
  }
  console.log(`\n[verify-photo-registration-listing] ${passed} passed, ${failures.length} failed`);
  for (const failure of failures) console.error(`\nFAIL: ${failure.name}\n${failure.error instanceof Error ? failure.error.stack : String(failure.error)}`);
  if (failures.length) process.exitCode = 1;
}

void main();
