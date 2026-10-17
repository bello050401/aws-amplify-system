import assert from "node:assert/strict";
import { assertInventoryVersion, writeInventoryRevision, InventorySaveError, type InventoryRevisionWriter } from "../lib/inventory/conditionalUpdate";

async function main() {
  const first = "2026-10-17T00:00:00.000Z", second = "2026-10-17T00:00:01.000Z";
  assert.throws(() => assertInventoryVersion(undefined, first), InventorySaveError);
  assert.throws(() => assertInventoryVersion(first, second), InventorySaveError);
  assertInventoryVersion(first, first);
  let record = { id: "item", quantity: 10, updatedAt: first };
  let writes = 0;
  const writer: InventoryRevisionWriter = async request => {
    assert.equal(request.authMode, "userPool"); assert.match(request.query, /condition: \$condition/);
    if (record.updatedAt !== request.variables.condition.updatedAt.eq) return { errors: [{ errorType: "DynamoDB:ConditionalCheckFailedException" }] };
    record = { ...record, ...request.variables.input, updatedAt: second }; writes++;
    return { data: { updateInventory: { id: record.id, updatedAt: record.updatedAt } } };
  };
  const results = await Promise.allSettled([
    writeInventoryRevision(writer, { id: "item", quantity: 11 }, first),
    writeInventoryRevision(writer, { id: "item", quantity: 20 }, first),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(writes, 1); assert.equal(record.quantity, 11);
  await assert.rejects(writeInventoryRevision(writer, { id: "item", quantity: 11 }, first), error => error instanceof InventorySaveError && error.code === "CONFLICT");
  await assert.rejects(writeInventoryRevision(async () => { throw { errors: [{ errorType: "DynamoDB:ConditionalCheckFailedException" }] }; }, { id: "item" }, first), error => error instanceof InventorySaveError && error.code === "CONFLICT");
  await assert.rejects(writeInventoryRevision(async () => { throw Error("private transport details"); }, { id: "item" }, second), error => error instanceof InventorySaveError && error.code === "UNCONFIRMED" && !error.message.includes("private"));
  await assert.rejects(writeInventoryRevision(async () => ({ data: { updateInventory: { id: "other", updatedAt: second } } }), { id: "item" }, first), InventorySaveError);
  console.log("PASS: stale/missing versions rejected, two-device conflict, duplicate retry blocked, unknown outcomes preserved; mocked storage only.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
