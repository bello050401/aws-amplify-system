import assert from "node:assert/strict";
import test from "node:test";
import { buildExistingReadJob } from "./readRequest.ts";
import { existingReadDispatchForOwner } from "./httpContract.ts";

function fixture() {
  const input = { inventory: { id: "inventory-1", sku: "B005795", quantity: 0 },
    draft: { id: "draft-1", inventoryId: "inventory-1", title: "Saved title",
      description: "Saved description", price: 0, condition: "LIKE_NEW", shippingMethod: "KAZAI",
      images: [{ storageKey: "inventory/private.jpg", sortOrder: 0 }], updatedAt: "2026-10-04T01:00:00Z" },
    channelListing: null, shopId: "shopABCDEFGH", remoteId: "productABCDEFGH",
    requestedBy: "owner@example.test" };
  return { job: buildExistingReadJob(input), binding: { inventoryId: input.inventory.id,
    shopId: input.shopId, remoteId: input.remoteId, source: "USER_REVIEWED_UI",
    requestedBy: input.requestedBy } };
}

test("owner gets only the immutable READ_EXISTING comparison inputs", () => {
  const { job, binding } = fixture();
  const dispatch = existingReadDispatchForOwner(job, binding, "owner@example.test");
  assert.deepEqual(dispatch, { requestId: job.requestId, operation: "READ_EXISTING",
    accountReference: binding.shopId, remoteId: binding.remoteId, inventoryCode: "B005795",
    expectedFields: { title: "Saved title", description: "Saved description", quantity: 0, priceYen: 0 } });
  assert.equal(JSON.stringify(dispatch).includes("inventory/private.jpg"), false);
});

test("another ADMIN, changed binding, or damaged snapshot receives no job", () => {
  const { job, binding } = fixture();
  assert.equal(existingReadDispatchForOwner(job, binding, "other@example.test"), null);
  assert.equal(existingReadDispatchForOwner(job, { ...binding, remoteId: "anotherProduct123" },
    "owner@example.test"), null);
  assert.equal(existingReadDispatchForOwner({ ...job, snapshotJson: "{}" }, binding,
    "owner@example.test"), null);
  assert.equal(existingReadDispatchForOwner({ ...job, operation: "CREATE_PRODUCT" }, binding,
    "owner@example.test"), null);
});
