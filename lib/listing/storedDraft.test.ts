import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeStructuredJson, normalizeDirectStructuredJson } from "../amplify/structuredJson";
import { toListingDraftRecord } from "./service";
import { resolveListPhotoUrl } from "../photoRegistration/gallerySelection";

const prices = { MERCARI_SHOPS: 97690, YAHOO: 92000, BASE: 92806, INDEPENDENT: 92000 };
const packages = [{ id: "main", name: "", rank: "B" }];
const images = Array.from({ length: 8 }, (_, sortOrder) => ({
  storageKey: `photo-batches/test/processed/${sortOrder}.jpg`,
  sortOrder, source: "PHOTO_ASSET" as const, photoAssetId: `photo-${sortOrder}`,
}));
const row = {
  id: "draft", inventoryId: "test", title: "テスト MAGIS", price: 92000,
  createdAt: "2026-10-18T12:00:00.000Z", updatedAt: "2026-10-18T12:00:00.000Z",
  channelPrices: prices, shippingPackages: packages, images,
};
const jsonFields = ["channelPrices", "shippingPackages", "images"] as const;
function encoded(layers: number) {
  const result: Record<string, unknown> = { ...row };
  for (const field of jsonFields) {
    for (let i = 0; i < layers; i++) result[field] = JSON.stringify(result[field]);
  }
  return result as typeof row;
}

for (const [name, layers] of [["native DynamoDB", 0], ["AppSync AWSJSON", 1], ["legacy direct write read by AppSync", 2]] as const) {
  test(`${name}: editor preserves four prices, eight photos and B-rank shipping`, () => {
    const draft = toListingDraftRecord(encoded(layers));
    assert.deepEqual(draft.channelPrices, prices);
    assert.deepEqual(draft.images, images);
    assert.deepEqual(draft.shippingPackages, packages);
  });
}

test("direct create/update input stores native JSON and survives AppSync serialization", () => {
  const input = { ...encoded(1), description: '{"ordinary":"text stays text"}' };
  const stored = normalizeDirectStructuredJson("ListingDraft", input);
  assert.deepEqual(stored.channelPrices, prices);
  assert.deepEqual(stored.images, images);
  assert.deepEqual(stored.shippingPackages, packages);
  assert.equal(stored.description, input.description);
  assert.equal(typeof input.channelPrices, "string"); // does not mutate the caller
  const wire = { ...stored };
  for (const field of jsonFields) wire[field] = JSON.stringify(stored[field]);
  assert.deepEqual(toListingDraftRecord(wire as typeof row), toListingDraftRecord({ ...row, description: input.description }));
  assert.deepEqual(normalizeDirectStructuredJson("ListingDraft", { channelPrices: null, images: undefined }), { channelPrices: null, images: undefined });
  assert.deepEqual(normalizeDirectStructuredJson("ChannelListing", { categoryMapping: '{"categoryId":"chair"}' }), { categoryMapping: { categoryId: "chair" } });
  assert.deepEqual(normalizeDirectStructuredJson("Inventory", { images: "untouched" }), { images: "untouched" });
});

test("invalid or excessively encoded prices never silently fall back to base price", () => {
  for (const channelPrices of ["not json", '"still a string"', "92000", JSON.stringify(JSON.stringify({ ...prices, BASE: -1 }))]) {
    assert.throws(() => toListingDraftRecord({ ...row, channelPrices }));
  }
  assert.throws(() => decodeStructuredJson(JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify(prices))))));
  assert.throws(() => normalizeDirectStructuredJson("ListingDraft", { images: "broken" }));
  assert.throws(() => toListingDraftRecord({ ...row, images: '{}' }));
});

test("legacy drafts with absent optional JSON remain readable", () => {
  const draft = toListingDraftRecord({ ...row, images: null, channelPrices: undefined, shippingPackages: null });
  assert.equal(draft.channelPrices, null);
  assert.deepEqual(draft.images, []);
  assert.equal(draft.shippingPackages?.length, 1);
});

test("EC thumbnail uses Photo Station when inventory has no explicit top, respecting both explicit choices", () => {
  const photo = { url: "https://photos.example.test/top.jpg", explicitPrimary: false };
  assert.equal(resolveListPhotoUrl(false, photo), photo.url);
  assert.equal(resolveListPhotoUrl(true, photo), null);
  assert.equal(resolveListPhotoUrl(true, { ...photo, explicitPrimary: true }), photo.url);
  assert.equal(resolveListPhotoUrl(false, null), null);
});
