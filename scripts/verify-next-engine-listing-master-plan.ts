import assert from "node:assert/strict";
import { buildNextEngineListingMasterPlan } from "../lib/listing/nextEngine/listingMasterPlan";
import type { ListingDraftRecord, ChannelListingRecord } from "../lib/listing/types";

const inventory = { id: "inventory-1", sku: "B005730", purchasePrice: 5000 };
const draft = {
  id: "draft-1", inventoryId: inventory.id, title: "保存したタイトル", description: "保存した説明",
  price: 12000, condition: "NO_NOTABLE_DAMAGE", shippingMethod: "KAZAI",
  images: [{ storageKey: "inventory/one.jpg", sortOrder: 0 }],
  createdBy: null, updatedBy: null, createdAt: "", updatedAt: "",
} as ListingDraftRecord;
const listing = {
  id: "listing-1", inventoryId: inventory.id, listingDraftId: draft.id,
  channel: "MERCARI_SHOPS", status: "DRAFT", externalListingId: null,
  overrideTitle: "掲載タイトル", overrideDescription: null, overridePrice: null, categoryMapping: null,
} as ChannelListingRecord;
const plan = buildNextEngineListingMasterPlan(inventory, draft, listing, "9999");
assert.equal(plan.sku, inventory.sku);
assert.equal(plan.imageCount, 1);
assert.ok(plan.prepared.csv.includes('"掲載タイトル"'));
assert.ok(plan.prepared.csv.includes('"5000","12000"'));
assert.equal(plan.prepared.publicationState, "NOT_PUBLISHED");
const freshPlan = buildNextEngineListingMasterPlan(inventory, draft, null, "9999");
assert.ok(freshPlan.prepared.csv.includes('"保存したタイトル"'));
assert.ok(!freshPlan.prepared.csv.includes('"掲載タイトル"'));
assert.notEqual(freshPlan.fingerprint, plan.fingerprint);
assert.notEqual(buildNextEngineListingMasterPlan(inventory, { ...draft, images: [{ storageKey: "inventory/two.jpg", sortOrder: 0 }] }, listing, "9999").fingerprint, plan.fingerprint);
assert.throws(() => buildNextEngineListingMasterPlan({ ...inventory, sku: "B".repeat(31) }, draft, listing, "9999"));
assert.throws(() => buildNextEngineListingMasterPlan({ ...inventory, purchasePrice: null }, draft, listing, "9999"));
assert.throws(() => buildNextEngineListingMasterPlan(inventory, { ...draft, images: [] }, listing, "9999"));
assert.throws(() => buildNextEngineListingMasterPlan(inventory, draft, { ...listing, listingDraftId: "other" }, "9999"));
assert.throws(() => buildNextEngineListingMasterPlan(inventory, draft, { ...listing, externalListingId: "existing" }, "9999"));
assert.throws(() => buildNextEngineListingMasterPlan(inventory, draft, { ...listing, status: "PUBLISHING" }, "9999"));
console.log("Next Engine listing plan: saved links, exact source values, images and no-resend guards passed.");
