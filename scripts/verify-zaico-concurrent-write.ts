import assert from "node:assert/strict";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createLambdaSyncPort, ddb } from "../amplify/functions/zaico-sync-worker/lambdaSyncPort";
import { InventorySaveError } from "../lib/inventory/conditionalUpdate";
import type { UpdateInventoryInput } from "../lib/inventory/zaicoSyncPorts";

async function main() {
  const originalSend = ddb.send;
  const oldVersion = "2026-10-17T00:00:00.000Z";
  const record: Record<string, unknown> = { id: "fixture", updatedAt: oldVersion, quantity: 10 };
  let writes = 0, calls = 0, loseReply = false;
  // Execute the real Lambda adapter; replace only the DynamoDB transport.
  ddb.send = (async (command: unknown) => {
    calls++;
    assert.ok(command instanceof UpdateCommand);
    const { ConditionExpression, ExpressionAttributeNames: names, ExpressionAttributeValues: values, UpdateExpression } = command.input;
    assert.equal(ConditionExpression, "#revision = :expectedRevision");
    assert.equal(names?.["#revision"], "updatedAt");
    if (record.updatedAt !== values?.[":expectedRevision"]) {
      const error = new Error("rejected"); error.name = "ConditionalCheckFailedException"; throw error;
    }
    for (const match of (UpdateExpression ?? "").matchAll(/(#f\d+) = (:v\d+)/g)) record[names![match[1]]] = values![match[2]];
    writes++;
    if (loseReply) throw new Error("transport reply lost");
    return {};
  }) as typeof ddb.send;
  try {
    const port = createLambdaSyncPort();
    const input: UpdateInventoryInput = { id: "fixture", expectedUpdatedAt: oldVersion, quantity: 11, images: [], customFields: undefined, updatedBy: "fixture", extendedFields: {} };
    const outcomes = await Promise.allSettled([port.updateInventory(input), port.updateInventory({ ...input, quantity: 20 })]);
    assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
    assert.equal(writes, 1); assert.equal(record.quantity, 11);
    const rejected = outcomes.find(outcome => outcome.status === "rejected") as PromiseRejectedResult;
    assert.equal(rejected.reason.code, "CONFLICT");
    const callsBefore = calls;
    await assert.rejects(port.updateInventory({ ...input, expectedUpdatedAt: "" }), error => error instanceof InventorySaveError && error.code === "CONFLICT");
    assert.equal(calls, callsBefore);
    loseReply = true;
    await assert.rejects(port.updateInventory({ ...input, expectedUpdatedAt: String(record.updatedAt), quantity: 12 }), error => error instanceof InventorySaveError && error.code === "UNCONFIRMED");
    assert.equal(record.quantity, 12); assert.equal(writes, 2);
    console.log("PASS: real scheduled-sync adapter rejects stale/absent versions and distinguishes lost acknowledgement. Mocked DynamoDB only; no live writes.");
  } finally { ddb.send = originalSend; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
