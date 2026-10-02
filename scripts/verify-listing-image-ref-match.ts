import assert from "node:assert/strict";
import { sameListingImageRefs } from "../lib/photoRegistration/inventoryListingAdapter";
import type { ListingImageRef } from "../lib/listing/types";

const malformed = (value: unknown): ListingImageRef[] => value as ListingImageRef[];

const inventory = { storageKey: "inventory/test.png", sortOrder: 0, source: "INVENTORY" as const };
// Amplify JSON reads keys in a different order than the selector creates them.
assert.equal(sameListingImageRefs([inventory], [{ sortOrder: 0, source: "INVENTORY", storageKey: "inventory/test.png" }]), true);
assert.equal(sameListingImageRefs([inventory], [{ storageKey: "inventory/test.png", sortOrder: 0 }]), true);
assert.equal(sameListingImageRefs([inventory], [{ ...inventory, storageKey: "inventory/other.png" }]), false);
assert.equal(sameListingImageRefs([inventory], [{ ...inventory, sortOrder: 1 }]), false);
assert.equal(sameListingImageRefs([inventory], []), false);
assert.equal(sameListingImageRefs([inventory], null), false);
assert.equal(sameListingImageRefs(undefined, [inventory]), false);
const second = { storageKey: "inventory/second.png", sortOrder: 1, source: "INVENTORY" as const };
assert.equal(sameListingImageRefs([inventory, second], [second, inventory]), false); // primary/order changed
assert.equal(sameListingImageRefs([inventory, second], [{ ...second, sortOrder: 0 }, { ...inventory, sortOrder: 1 }]), false);
assert.equal(sameListingImageRefs([inventory, second], [inventory, { ...second, storageKey: "inventory/replaced.png" }]), false);

const photo = { storageKey: "photo/a.png", sortOrder: 0, source: "PHOTO_ASSET" as const, photoAssetId: "asset-a" };
assert.equal(sameListingImageRefs([photo], [{ photoAssetId: "asset-a", source: "PHOTO_ASSET", sortOrder: 0, storageKey: "photo/a.png" }]), true);
assert.equal(sameListingImageRefs([photo], [{ ...photo, photoAssetId: "asset-b" }]), false);
assert.equal(sameListingImageRefs([photo], [{ storageKey: "photo/a.png", sortOrder: 0, source: "PHOTO_ASSET" }]), false);
assert.equal(sameListingImageRefs([{ storageKey: "photo/a.png", sortOrder: 0, source: "PHOTO_ASSET" }],
  [{ storageKey: "photo/a.png", sortOrder: 0, source: "PHOTO_ASSET" }]), false);
assert.equal(sameListingImageRefs(malformed([{}]), malformed([{}])), false);
assert.equal(sameListingImageRefs(malformed([null]), malformed([null])), false);
assert.equal(sameListingImageRefs([inventory], malformed([null])), false);
assert.equal(sameListingImageRefs(malformed(new Array(1)), malformed(new Array(1))), false);
assert.equal(sameListingImageRefs(malformed([{ storageKey: "", sortOrder: 0 }]), malformed([{ storageKey: "", sortOrder: 0 }])), false);
assert.equal(sameListingImageRefs(malformed([{ storageKey: "  ", sortOrder: 0 }]), malformed([{ storageKey: "  ", sortOrder: 0 }])), false);
assert.equal(sameListingImageRefs(malformed([{ storageKey: "inventory/test.png", sortOrder: -1 }]), malformed([{ storageKey: "inventory/test.png", sortOrder: -1 }])), false);
assert.equal(sameListingImageRefs(malformed([{ storageKey: "inventory/test.png", sortOrder: "0" }]), malformed([{ storageKey: "inventory/test.png", sortOrder: "0" }])), false);
assert.equal(sameListingImageRefs(malformed([{ storageKey: "inventory/test.png", sortOrder: 0, source: "OTHER" }]), malformed([{ storageKey: "inventory/test.png", sortOrder: 0, source: "OTHER" }])), false);
assert.equal(sameListingImageRefs(malformed([{ ...photo, photoAssetId: "  " }]), malformed([{ ...photo, photoAssetId: "  " }])), false);
assert.equal(sameListingImageRefs([inventory, { ...inventory, sortOrder: 1 }], [inventory, { ...inventory, sortOrder: 1 }]), false);
assert.equal(sameListingImageRefs([photo, { ...photo, storageKey: "photo/b.png", sortOrder: 1 }],
  [photo, { ...photo, storageKey: "photo/b.png", sortOrder: 1 }]), false);

console.log("Listing image reference comparison: 26 cases passed");
