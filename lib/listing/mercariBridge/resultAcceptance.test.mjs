import assert from "node:assert/strict";
import test from "node:test";
import { buildExistingReadJob } from "./readRequest.ts";
import { acceptExistingReadResult, normalizeExistingReadResult } from "./resultAcceptance.ts";

const input = () => ({
  inventory: { id: "inventory-1", sku: "B005795", quantity: 0 },
  draft: { id: "draft-1", inventoryId: "inventory-1", title: "Saved BELLO title",
    description: "Saved BELLO description", price: 0, condition: "LIKE_NEW", shippingMethod: "KAZAI",
    images: [{ storageKey: "inventory/example.jpg", sortOrder: 0 }], updatedAt: "2026-10-04T01:00:00Z" },
  channelListing: null, shopId: "shopABCDEFGH", remoteId: "productABCDEFGH",
  requestedBy: "admin@example.test",
});
const FIRST_ATTEMPT = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const SECOND_ATTEMPT = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const now = "2026-10-04T02:00:00.000Z";

function setup() {
  const source = input();
  const job = buildExistingReadJob(source);
  const binding = { inventoryId: source.inventory.id, shopId: source.shopId,
    remoteId: source.remoteId, source: "USER_REVIEWED_UI", requestedBy: source.requestedBy };
  const results = new Map();
  const repo = {
    async getJob(requestId) { return requestId === job.requestId ? job : null; },
    async getBinding(inventoryId) { return inventoryId === binding.inventoryId ? binding : null; },
    async getResult(resultId) { return results.get(resultId) ?? null; },
    async createResult(row) {
      await Promise.resolve();
      if (results.has(row.resultId)) throw Error("conditional conflict");
      results.set(row.resultId, row);
    },
  };
  const envelope = { requestId: job.requestId, attemptId: FIRST_ATTEMPT,
    accountReference: source.shopId, remoteId: source.remoteId,
    status: "AUTH_REQUIRED", comparison: null, reasonCode: "SIGN_IN_REQUIRED" };
  return { job, binding, results, repo, envelope };
}

test("one sanitized attempt is recorded once; a later same-ID read remains separate", async () => {
  const { repo, results, envelope } = setup();
  const [first, retry] = await Promise.all([
    acceptExistingReadResult(envelope, repo, now), acceptExistingReadResult(envelope, repo, now),
  ]);
  assert.equal(first.resultId, retry.resultId);
  assert.equal(results.size, 1);
  assert.equal(first.status, "AUTH_REQUIRED");
  const later = await acceptExistingReadResult({ ...envelope, attemptId: SECOND_ATTEMPT }, repo, now);
  assert.notEqual(first.resultId, later.resultId);
  assert.equal(results.size, 2);
});

test("wrong shop, remote product, or request cannot be saved", async () => {
  const { repo, results, envelope } = setup();
  for (const changed of [
    { accountReference: "otherShop123" }, { remoteId: "otherProduct123" },
    { requestId: "0".repeat(64) },
  ]) {
    await assert.rejects(acceptExistingReadResult({ ...envelope, ...changed }, repo, now));
  }
  assert.equal(results.size, 0);
});

test("the current partial reader cannot claim complete matching or publication", () => {
  const { job, binding, envelope } = setup();
  const comparison = { account: "MATCH", remoteId: "MATCH", visibility: "PRIVATE_OBSERVED",
    createAllowed: false, fields: { inventoryCode: "MATCH", title: "MATCH", description: "MATCH",
      priceYen: "MATCH", quantity: "MATCH", primaryImageIdentity: "MATCH" } };
  assert.throws(() => normalizeExistingReadResult(job, binding, {
    ...envelope, status: "CORE_FIELDS_MATCH", reasonCode: null, comparison,
  }, now), { code: "INVALID_RESULT" });
  assert.throws(() => normalizeExistingReadResult(job, binding, {
    ...envelope, status: "PUBLIC_CONFIRMED", reasonCode: null, comparison,
  }, now), { code: "INVALID_RESULT" });
});

test("valid partial comparison stays incomplete and stores no raw page values", () => {
  const { job, binding, envelope } = setup();
  const comparison = { account: "MATCH", remoteId: "MATCH", visibility: "UNOBSERVED",
    createAllowed: false, fields: { inventoryCode: "MATCH", title: "MATCH", description: "MATCH",
      priceYen: "MATCH", quantity: "UNOBSERVED", primaryImageIdentity: "NO_BELLO_EXPECTATION" } };
  const result = normalizeExistingReadResult(job, binding, { ...envelope,
    status: "INCOMPLETE", comparison, reasonCode: null }, now);
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(JSON.parse(result.comparisonJson).fields.quantity, "UNOBSERVED");
  assert.equal(result.comparisonJson.includes("Saved BELLO title"), false);
  assert.throws(() => normalizeExistingReadResult(job, binding, { ...envelope,
    status: "INCOMPLETE", comparison, reasonCode: null, cookie: "secret" }, now),
  { code: "INVALID_RESULT" });
});

test("one attempt cannot be replaced by a different outcome", async () => {
  const { repo, results, envelope } = setup();
  await acceptExistingReadResult(envelope, repo, now);
  await assert.rejects(acceptExistingReadResult({ ...envelope, status: "UNKNOWN",
    reasonCode: "READ_FAILED" }, repo, now), { code: "RESULT_CONFLICT" });
  assert.equal(results.size, 1);
});
