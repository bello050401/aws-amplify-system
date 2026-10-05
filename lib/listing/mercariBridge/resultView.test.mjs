import assert from "node:assert/strict";
import test from "node:test";
import { buildExistingReadJob } from "./readRequest.ts";
import { existingReadResultsForOwner } from "./resultView.ts";
import { normalizeExistingReadResult } from "./resultAcceptance.ts";

function fixture(remoteId = "productABCDEFGH") {
  const input = { inventory: { id: "inventory-1", sku: "B005795", quantity: 0 },
    draft: { id: "draft-1", inventoryId: "inventory-1", title: "Saved title",
      description: "Saved description", price: 0, condition: "LIKE_NEW", shippingMethod: "KAZAI",
      images: [], updatedAt: "2026-10-04T01:00:00Z" }, channelListing: null,
    shopId: "shopABCDEFGH", remoteId, requestedBy: "owner@example.test" };
  const job = buildExistingReadJob(input);
  const binding = { inventoryId: job.inventoryId, shopId: job.shopId, remoteId: job.remoteId,
    source: "USER_REVIEWED_UI", requestedBy: job.requestedBy };
  const row = normalizeExistingReadResult(job, binding, {
    requestId: job.requestId, attemptId: "01111111-1111-4111-8111-111111111111",
    accountReference: job.shopId, remoteId: job.remoteId, status: "INCOMPLETE",
    comparison: { account: "MATCH", remoteId: "MATCH", visibility: "UNOBSERVED",
      createAllowed: false, fields: { title: "MATCH", quantity: "UNOBSERVED" } },
    reasonCode: null,
  }, "2026-10-04T03:00:00.000Z");
  return { job, binding, row };
}

test("owner sees validated comparison codes without stored JSON", () => {
  const { job, binding, row } = fixture();
  const result = existingReadResultsForOwner(job, binding, "owner@example.test", [row]);
  assert.deepEqual(result[0].fields, { title: "MATCH", quantity: "UNOBSERVED" });
  assert.equal(JSON.stringify(result).includes("comparisonJson"), false);
});

test("another ADMIN and mismatched attempts receive no result", () => {
  const { job, binding, row } = fixture();
  assert.equal(existingReadResultsForOwner(job, binding, "other@example.test", [row]), null);
  assert.equal(existingReadResultsForOwner(job, binding, "owner@example.test",
    [{ ...row, remoteId: "otherProduct123" }]), null);
  assert.equal(existingReadResultsForOwner(job, binding, "owner@example.test",
    [{ ...row, comparisonJson: JSON.stringify({ createAllowed: false, visibility: "UNOBSERVED",
      fields: { title: "<script>" } }) }]), null);
  assert.equal(existingReadResultsForOwner(job, binding, "owner@example.test",
    [{ ...row, comparisonJson: JSON.stringify({ ...JSON.parse(row.comparisonJson), rawPage: "secret" }) }]), null);
});

test("owner sees a pinned HTTP read as an empty read proof, not product fields", () => {
  const { job, binding } = fixture("2JXePE4ke8UCBTj6mxc4cf");
  const row = normalizeExistingReadResult(job, binding, {
    requestId: job.requestId, attemptId: "02222222-2222-4222-8222-222222222222",
    accountReference: job.shopId, remoteId: job.remoteId,
    status: "DIRECT_HTTP_READ_CONFIRMED", comparison: null,
    reasonCode: "PINNED_HTTP_200_MATCHED",
  }, "2026-10-04T04:00:00.000Z");
  assert.deepEqual(existingReadResultsForOwner(job, binding,
    "owner@example.test", [row]), [{
      attemptId: row.attemptId, recordedAt: row.recordedAt,
      status: "DIRECT_HTTP_READ_CONFIRMED", reasonCode: "PINNED_HTTP_200_MATCHED",
      fields: {}, visibility: null, identity: null,
    }]);
});
