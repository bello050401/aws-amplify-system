import assert from "node:assert/strict";
import test from "node:test";
import { buildExistingReadJob, reserveExistingReadRequest } from "./readRequest.ts";

const input = () => ({
  inventory: { id: "inventory-1", sku: "B005795", quantity: 0 },
  draft: { id: "draft-1", inventoryId: "inventory-1", title: "BELLO saved title",
    description: "BELLO saved description", price: 0, condition: "LIKE_NEW", shippingMethod: "KAZAI",
    images: [{ storageKey: "inventory/example.jpg", sortOrder: 0 }], updatedAt: "2026-10-04T01:00:00Z" },
  channelListing: null,
  shopId: "shopABCDEFGH", remoteId: "productABCDEFGH", requestedBy: "admin@example.test",
});

function memoryRepo() {
  const bindings = new Map();
  const jobs = new Map();
  return {
    bindings, jobs,
    async getBinding(id) { return bindings.get(id) ?? null; },
    async createBinding(row) {
      await Promise.resolve();
      if (bindings.has(row.inventoryId)) throw new Error("conditional conflict");
      bindings.set(row.inventoryId, row);
    },
    async getJob(id) { return jobs.get(id) ?? null; },
    async createJob(row) {
      await Promise.resolve();
      if (jobs.has(row.requestId)) throw new Error("conditional conflict");
      jobs.set(row.requestId, row);
    },
  };
}

test("same reviewed snapshot reserves only one existing-product read, including simultaneous clicks", async () => {
  const repo = memoryRepo();
  const [first, second] = await Promise.all([
    reserveExistingReadRequest(input(), repo), reserveExistingReadRequest(input(), repo),
  ]);
  assert.deepEqual(first, second);
  assert.deepEqual(first.ok, false);
  assert.equal(first.code, "CONNECTOR_NOT_CONFIGURED");
  assert.equal(repo.bindings.size, 1);
  assert.equal(repo.jobs.size, 1);
  const job = [...repo.jobs.values()][0];
  assert.equal(job.operation, "READ_EXISTING");
  assert.equal(job.status, "CONNECTOR_NOT_CONFIGURED");
});

test("one inventory cannot be rebound to a different shop or remote product", async () => {
  const repo = memoryRepo();
  await reserveExistingReadRequest(input(), repo);
  for (const changed of [{ shopId: "anotherShop123" }, { remoteId: "anotherProduct123" }]) {
    await assert.rejects(reserveExistingReadRequest({ ...input(), ...changed }, repo),
      { code: "BINDING_CONFLICT" });
  }
  assert.equal(repo.jobs.size, 1);
});

test("a second ADMIN cannot reserve a job owned by the first ADMIN", async () => {
  const repo = memoryRepo();
  await reserveExistingReadRequest(input(), repo);
  await assert.rejects(reserveExistingReadRequest({ ...input(), requestedBy: "another@example.test" }, repo),
    { code: "BINDING_CONFLICT" });
  assert.equal(repo.jobs.size, 1);
});

test("reviewed QA values are separate from the saved draft and change only the immutable read snapshot", async () => {
  const original = input();
  const originalDraft = structuredClone(original.draft);
  const repo = memoryRepo();
  const reviewedOverrides = { reason: "Existing private QA product reviewed in merchant UI",
    title: "【検証専用・現物なし・販売不可】BELLO連携動作確認 B005795",
    description: "BELLO連携動作確認用。現物なし・販売不可。公開禁止。", priceYen: 90000 };
  const result = await reserveExistingReadRequest({ ...original, reviewedOverrides }, repo);
  const snapshot = JSON.parse(repo.jobs.get(result.requestId).snapshotJson);
  assert.equal(snapshot.expected.priceYen, 90000);
  assert.equal(snapshot.draftValues.priceYen, 0);
  assert.equal(snapshot.reviewedOverrides.reason, reviewedOverrides.reason);
  assert.deepEqual(original.draft, originalDraft);
  assert.notEqual(result.requestId, buildExistingReadJob(original).requestId);
  assert.equal(snapshot.imageRefs[0].storageKey, "inventory/example.jpg");
});

test("a new saved draft revision creates a new read request without changing the binding", async () => {
  const repo = memoryRepo();
  const first = await reserveExistingReadRequest(input(), repo);
  const changed = input();
  changed.draft.updatedAt = "2026-10-04T02:00:00Z";
  const second = await reserveExistingReadRequest(changed, repo);
  assert.notEqual(first.requestId, second.requestId);
  assert.equal(repo.bindings.size, 1);
  assert.equal(repo.jobs.size, 2);
});

test("storage failure is explicit; a read request is never reported as executed", async () => {
  const repo = memoryRepo();
  repo.createJob = async () => { throw new Error("offline"); };
  await assert.rejects(reserveExistingReadRequest(input(), repo), { code: "STORAGE_UNAVAILABLE" });
  assert.equal(repo.jobs.size, 0);
});

test("an override cannot smuggle a different operation or bind another draft", async () => {
  const repo = memoryRepo();
  await assert.rejects(reserveExistingReadRequest({ ...input(), reviewedOverrides:
    { reason: "test", operation: "CREATE_PRODUCT" } }, repo), { code: "INVALID_INPUT" });
  const wrongDraft = input();
  wrongDraft.draft.inventoryId = "other-inventory";
  await assert.rejects(reserveExistingReadRequest(wrongDraft, repo), { code: "INVALID_INPUT" });
  assert.equal(repo.bindings.size, 0);
  assert.equal(repo.jobs.size, 0);
});

test("a request outside the PC reader identity limits is rejected before binding", async () => {
  const repo = memoryRepo();
  const longRemote = { ...input(), remoteId: "a".repeat(101) };
  await assert.rejects(reserveExistingReadRequest(longRemote, repo), { code: "INVALID_INPUT" });
  const unsupportedCode = input();
  unsupportedCode.inventory.sku = "B 005795";
  await assert.rejects(reserveExistingReadRequest(unsupportedCode, repo), { code: "INVALID_INPUT" });
  assert.equal(repo.bindings.size, 0);
  assert.equal(repo.jobs.size, 0);
});
