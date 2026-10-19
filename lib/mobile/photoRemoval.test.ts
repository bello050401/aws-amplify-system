import assert from "node:assert/strict";
import test from "node:test";
import { InventoryEditor, InventoryWriteError, type SaveRequest } from "../../mobile/src/domain/editor";
import { draftFor, type InventoryItem } from "../../mobile/src/domain/inventory";
import { imageId } from "./inventoryPhotos";
import { mobileInventoryInput, mobileWriteWasApplied, parseMobileSave } from "./inventoryWrite";

const id = "133963a7-c411-4a62-a3b3-e8947515c203";
const first = imageId("inventory/this-product/a.jpg"), second = imageId("inventory/this-product/b.jpg");
const item: InventoryItem = { id, sku: "TEST", name: "写真削除確認", quantity: 1, unit: "", location: "", category: "", condition: "", note: "", barcode: "", plannedSalePrice: null, thumbnailUrl: null, updatedAt: "2026-10-19T00:00:00Z", photosComplete: true, photos: [
  { id: first, url: "https://example.test/a.jpg", source: "INVENTORY", primary: true, type: "NORMAL" },
  { id: second, url: "https://example.test/b.jpg", source: "INVENTORY", primary: false, type: "DAMAGE" },
] };
const request = (): SaveRequest => ({ id, expectedUpdatedAt: item.updatedAt, mutationId: "754d07cb-eede-4da5-8b7f-92892ae16a18", draft: draftFor(item), removedPhotoIds: [first] });
const row = { ...item, categoryId: null, locationId: null, statusId: null, customFields: {}, purchasePrice: null, salePrice: null, images: [
  { storageKey: "inventory/this-product/a.jpg", sortOrder: 0, type: "NORMAL", isPrimary: true },
  { storageKey: "inventory/this-product/b.jpg", sortOrder: 1, type: "DAMAGE", isPrimary: false },
] } as unknown as Parameters<typeof mobileInventoryInput>[0];

test("photo removal stays local, can be restored, and is retained offline until explicit save", async () => {
  let online = false; const calls: SaveRequest[] = [];
  const editor = new InventoryEditor(item, { online: async () => online, newMutationId: () => request().mutationId, save: async value => { calls.push(value); return { ...item, photos: [item.photos![1]] }; } });
  editor.removeSavedPhoto(first); editor.change("note", ""); editor.removePhoto("absent-pending");
  assert.equal(editor.getSnapshot().dirty, true); assert.equal(editor.getSnapshot().saved.photos?.length, 2);
  assert.equal(editor.requestLeave(), false); await editor.save(); assert.equal(calls.length, 0);
  assert.equal(editor.getSnapshot().warning, "【圏外です】");
  editor.restoreRemovedPhotos(); assert.equal(editor.getSnapshot().dirty, false);
  editor.removeSavedPhoto(first); editor.discard(); assert.deepEqual(editor.getSnapshot().removedPhotoIds, []);
  editor.removeSavedPhoto(first); online = true; await editor.save();
  assert.deepEqual(calls[0].removedPhotoIds, [first]); assert.equal(editor.getSnapshot().saved.photos?.length, 1);
  assert.equal(editor.getSnapshot().dirty, false);
});

test("lost removal response retries identical receipt and locks further photo edits", async () => {
  const calls: SaveRequest[] = [];
  const editor = new InventoryEditor(item, { online: async () => true, newMutationId: () => request().mutationId, save: async value => { calls.push(value); if (calls.length === 1) throw new InventoryWriteError("uncertain"); return { ...item, photos: [item.photos![1]] }; } });
  editor.removeSavedPhoto(first); await editor.save(); editor.removeSavedPhoto(second); editor.restoreRemovedPhotos();
  assert.deepEqual(editor.getSnapshot().removedPhotoIds, [first]); await editor.save(); assert.deepEqual(calls[0], calls[1]);
});

test("server accepts only current-product photo IDs, preserves other photos, and fingerprints removals", () => {
  const parsed = parseMobileSave(request(), id);
  const input = mobileInventoryInput(row, parsed, "owner", { ecListing: true, sales: true }, [], [], []);
  assert.equal(input.images.length, 1); assert.equal(input.images[0].type, "DAMAGE");
  const saved = { ...row, customFields: input.customFields ?? null };
  assert.equal(mobileWriteWasApplied(saved, parsed, "owner"), true);
  assert.equal(mobileWriteWasApplied(saved, { ...parsed, removedPhotoIds: [second] }, "owner"), false);
  assert.throws(() => mobileInventoryInput(row, { ...parsed, removedPhotoIds: [imageId("inventory/other/a.jpg")] }, "owner", { ecListing: true, sales: true }, [], [], []));
  assert.throws(() => mobileInventoryInput({ ...row, updatedAt: "2026-10-19T00:01:00Z" }, parsed, "owner", { ecListing: true, sales: true }, [], [], []));
});

test("malformed, duplicate and create-time deletions are rejected without accepting storage paths", () => {
  for (const removedPhotoIds of [["inventory/other/a.jpg"], [first, first], ["photo-batch-id"], "all"]) {
    assert.throws(() => parseMobileSave({ ...request(), removedPhotoIds }, id));
  }
  assert.throws(() => parseMobileSave({ ...request(), create: true }, id));
  const editor = new InventoryEditor({ ...item, photosComplete: false }, { online: async () => true, newMutationId: () => "m", save: async () => item });
  editor.removeSavedPhoto(first); assert.equal(editor.getSnapshot().dirty, false);
});
