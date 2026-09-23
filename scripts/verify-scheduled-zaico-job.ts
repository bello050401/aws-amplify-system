import assert from "node:assert/strict";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { queueZaicoDelta } from "../amplify/functions/sales-aggregate-scheduler/handler";

const baseline = "2026-09-23T00:00:00.000Z";
const job = { id: "zaico-full-sync-singleton", status: "COMPLETED", lastSuccessfulSyncAt: baseline,
  failedSourceIds: JSON.stringify({ ids: ["retry-me"], trusted: true }) };
let writes = 0;
const client = { send: async (command: GetCommand | UpdateCommand) => {
  if (command instanceof GetCommand) return { Item: job };
  assert.ok(command instanceof UpdateCommand);
  writes++;
  assert.equal(command.input.TableName, "isolated-job-table");
  assert.match(command.input.ConditionExpression!, /lastSuccessfulSyncAt = :baseline/);
  assert.equal(command.input.ExpressionAttributeValues![":since"], "2026-09-22T23:55:00.000Z");
  assert.equal(command.input.ExpressionAttributeValues![":delta"], "DELTA");
  return {};
} };
async function main() {
  assert.equal(await queueZaicoDelta(client as never, "isolated-job-table"), "queued");
  assert.equal(writes, 1);
  job.status = "RUNNING";
  assert.equal(await queueZaicoDelta(client as never, "isolated-job-table"), "no-trusted-completed-baseline");
  assert.equal(writes, 1);
  console.log("scheduled ZAICO job: conditional queue and running guard passed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
