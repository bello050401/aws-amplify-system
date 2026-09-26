import assert from "node:assert/strict";
import type { InventoryImageRecord } from "../lib/inventory/imageTypes";
import type { WebPhotoAssetView } from "../lib/photoRegistration/webAdapter";
import {
  buildListingImageCandidates,
  listingRefsFromSelection,
  restoreListingSelection,
  initialListingSelection,
} from "../lib/photoRegistration/inventoryListingAdapter";
import { normalizeListingImages } from "../lib/listing/service";
import type { ChannelListingRecord, ListingDraftRecord, ListingImageRef } from "../lib/listing/types";
// assembleMercariCsvRowFieldsは副作用のない純粋関数(lib/listing/mercari/csv/assembleRow.ts
// 冒頭コメント参照)——buildExportRows.tsは"server-only"+next/headersのため
// 素のtsxからは直接importできないが、この判定ロジック自体はそちらへ切り出されている。
import { assembleMercariCsvRowFields } from "../lib/listing/mercari/csv/assembleRow";

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

test("未保存下書きは撮影トップを優先し傷画像と旧画像を初期選択しない", () => {
  const candidates = buildListingImageCandidates([inventoryImage("old.jpg", 0)], [
    photoAsset("normal", 1), photoAsset("top", 2, { inventoryIsPrimary: true }),
    photoAsset("damage", 3, { inventoryImageType: "DAMAGE" }),
  ]);
  assert.deepEqual(initialListingSelection(candidates, null).map(c => c.ref.photoAssetId), ["top", "normal"]);
  assert.equal(candidates.some(c => c.ref.photoAssetId === "damage"), false);
  assert.deepEqual(initialListingSelection(candidates, [{ storageKey: "old.jpg", sortOrder: 0 }]).map(c => c.ref.storageKey), ["old.jpg"]);
});

test("撮影画像が無い場合は旧画像を維持し初期選択は20枚まで", () => {
  const old = buildListingImageCandidates([inventoryImage("old.jpg", 0)], []);
  assert.equal(initialListingSelection(old, null)[0].ref.storageKey, "old.jpg");
  const many = buildListingImageCandidates([], Array.from({ length: 25 }, (_, i) => photoAsset(`p${i}`, i)));
  assert.equal(initialListingSelection(many, null).length, 20);
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

// ─────────────────────────────────────────────────────────────────────────
// CSV画像列(assembleMercariCsvRowFields、純粋関数)との結線検証。
// buildExportRows.ts自体は"server-only"のため直接importできないが、
// 選択順(sortOrder)をそのままCSVの画像列へ渡すロジックはassembleRow.ts
// 側にあり、そちらは副作用が無いためここで直接検証できる。
// ─────────────────────────────────────────────────────────────────────────

const baseCsvInventory = { displayId: "INV-001", quantity: 1, sku: "SKU-1", barcode: null };

function draftWithImages(images: ListingImageRef[]): ListingDraftRecord {
  return {
    id: "draft-1",
    inventoryId: "inv-1",
    title: "テスト商品",
    description: "説明",
    price: 1000,
    condition: "NO_NOTABLE_DAMAGE",
    shippingMethod: "KAZAI",
    images,
    createdBy: null,
    updatedBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function validChannelListing(): ChannelListingRecord {
  return {
    id: "cl-1",
    listingDraftId: "draft-1",
    inventoryId: "inv-1",
    channel: "MERCARI_SHOPS",
    categoryMapping: { mercariCategoryId: "cat-1" },
    overrideTitle: null,
    overrideDescription: null,
    overridePrice: null,
    status: "DRAFT",
    externalListingId: null,
    listingUrl: null,
    firstListedAt: null,
    lastListedAt: null,
    lastRelistedAt: null,
    endedAt: null,
    soldAt: null,
    lastError: null,
    autoPricingEnabled: false,
    pricingRuleId: null,
    originalPrice: null,
    currentPrice: null,
    floorPrice: null,
    markdownCount: 0,
    lastPriceChangeAt: null,
    nextPriceActionAt: null,
    automationHold: false,
    lastAutomationResult: null,
    shippingRank: null,
    shippingDestinationPrefecture: null,
    calculatedShippingFee: null,
    confirmedShippingFee: null,
    shippingFeeUpdatedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("CSV画像列: 既存画像のみの並び順を維持する", () => {
  const candidates = buildListingImageCandidates(
    [inventoryImage("inventory/a.jpg", 0), inventoryImage("inventory/b.jpg", 1)],
    [],
  );
  const refs = listingRefsFromSelection([candidates[1], candidates[0]]); // b→先頭, a→2枚目
  const result = assembleMercariCsvRowFields("inv-1", baseCsvInventory, draftWithImages(refs), validChannelListing());
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.fields.images, ["INV-001_1.jpg", "INV-001_2.jpg"]);
});

test("CSV画像列: 新規PhotoAssetのみの並び順を維持する(processed keyを再uploadなしでそのまま使う)", () => {
  const candidates = buildListingImageCandidates([], [photoAsset("p1", 1), photoAsset("p2", 2)]);
  const refs = listingRefsFromSelection([candidates[1], candidates[0]]); // p2→先頭, p1→2枚目
  const result = assembleMercariCsvRowFields("inv-1", baseCsvInventory, draftWithImages(refs), validChannelListing());
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.fields.images, ["INV-001_1.jpg", "INV-001_2.jpg"]);
});

test("CSV画像列: 既存/PhotoAsset混在で並び替え後、主画像(index0)がそのままファイル名の先頭になる", () => {
  const candidates = buildListingImageCandidates([inventoryImage("inventory/a.jpg", 0)], [photoAsset("p1", 1)]);
  const reordered = [candidates[1], candidates[0]]; // PhotoAssetを主画像にする
  const refs = listingRefsFromSelection(reordered);
  assert.equal(refs[0].source, "PHOTO_ASSET");
  assert.equal(refs[0].sortOrder, 0);
  const result = assembleMercariCsvRowFields("inv-1", baseCsvInventory, draftWithImages(refs), validChannelListing());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.fields.images.length, 2);
    assert.equal(result.fields.images[0], "INV-001_1.jpg");
  }
});

test("保存後にPhotoAssetが論理削除されても、復元時に選択から除外され残りの順序は保たれる", () => {
  const initialAssets = [photoAsset("p1", 1), photoAsset("p2", 2)];
  const initialCandidates = buildListingImageCandidates([inventoryImage("inventory/a.jpg", 0)], initialAssets);
  const savedRefs = listingRefsFromSelection(initialCandidates); // 保存時の選択: a, p1, p2

  const reloadedAssets = [photoAsset("p1", 1, { isDeleted: true }), photoAsset("p2", 2)];
  const reloadedCandidates = buildListingImageCandidates([inventoryImage("inventory/a.jpg", 0)], reloadedAssets);
  const restored = restoreListingSelection(reloadedCandidates, savedRefs);

  assert.deepEqual(restored.selected.map((c) => c.ref.photoAssetId ?? c.ref.storageKey), ["inventory/a.jpg", "p2"]);
  assert.equal(restored.missing.length, 1);
  assert.equal(restored.missing[0].photoAssetId, "p1");
});

test("setListingPhotoAssetSelectionAction入力: 選択順を保ったままPhotoAsset分だけ取り出す", () => {
  const candidates = buildListingImageCandidates([inventoryImage("inventory/a.jpg", 0)], [photoAsset("p1", 1), photoAsset("p2", 2)]);
  const reordered = [candidates[2], candidates[0], candidates[1]]; // p2, a, p1
  const refs = listingRefsFromSelection(reordered);
  const photoAssetIds = refs
    .filter((ref): ref is ListingImageRef & { photoAssetId: string } => ref.source === "PHOTO_ASSET" && !!ref.photoAssetId)
    .map((ref) => ref.photoAssetId);
  assert.deepEqual(photoAssetIds, ["p2", "p1"]);
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
