import test from "node:test";
import assert from "node:assert/strict";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoWebHttpSendReservationRepository } from
  "./webHttpSendReservationRepository.ts";

const tables = { slotTableName: "shop-slot-table",
  attemptTableName: "send-attempt-table" };
const firstSlot = {
  shopId: "shop", revision: 1,
  lastStartedAt: "2026-10-09T00:00:00.000Z",
  sendBeforeAt: "2026-10-09T00:00:04.000Z",
  nextEligibleAt: "2026-10-09T00:00:35.000Z",
  requestId: "a".repeat(64),
  attemptId: "fef2b7ee-cf21-429f-99bf-9439eafab3af",
  requestedBy: "admin@example.com",
};
const attempt = {
  requestId: firstSlot.requestId, inventoryId: "inventory",
  shopId: firstSlot.shopId, snapshotFingerprint: "b".repeat(64),
  attemptId: firstSlot.attemptId, slotRevision: 1,
  reservedAt: firstSlot.lastStartedAt, sendBeforeAt: firstSlot.sendBeforeAt,
  requestedBy: firstSlot.requestedBy, status: "RESERVED_NO_SEND",
};

test("both reads request consistent DynamoDB values", async () => {
  const commands = [];
  const ddb = { send: async command => {
    commands.push(command);
    return { Item: undefined };
  } };
  const repo = new DynamoWebHttpSendReservationRepository(ddb, tables);
  assert.equal(await repo.getSlot("shop"), null);
  assert.equal(await repo.getAttempt(attempt.requestId), null);
  assert.equal(commands.length, 2);
  for (const command of commands) {
    assert.ok(command instanceof GetCommand);
    assert.equal(command.input.ConsistentRead, true);
  }
});

test("new reservation is one conditional transaction with two writes", async () => {
  const commands = [];
  const repo = new DynamoWebHttpSendReservationRepository({
    send: async command => { commands.push(command); return {}; },
  }, tables);
  await repo.transactReserve(null, firstSlot, attempt, firstSlot.lastStartedAt);
  assert.equal(commands.length, 1);
  assert.ok(commands[0] instanceof TransactWriteCommand);
  const input = commands[0].input;
  assert.equal(input.ClientRequestToken, firstSlot.attemptId);
  assert.equal(input.TransactItems.length, 2);
  assert.equal(input.TransactItems[0].Update.TableName, tables.slotTableName);
  assert.match(input.TransactItems[0].Update.ConditionExpression,
    /attribute_not_exists/);
  assert.equal(input.TransactItems[1].Put.TableName, tables.attemptTableName);
  assert.match(input.TransactItems[1].Put.ConditionExpression,
    /attribute_not_exists/);
});

test("later reservation condition checks revision and eligibility atomically", async () => {
  const commands = [];
  const repo = new DynamoWebHttpSendReservationRepository({
    send: async command => { commands.push(command); return {}; },
  }, tables);
  const next = { ...firstSlot, revision: 2,
    lastStartedAt: "2026-10-09T00:00:35.000Z",
    sendBeforeAt: "2026-10-09T00:00:39.000Z",
    nextEligibleAt: "2026-10-09T00:01:10.000Z",
    attemptId: "edbb1fe9-c09b-4cd6-ad24-85c3bb4291a4",
    requestId: "c".repeat(64) };
  await repo.transactReserve(firstSlot, next,
    { ...attempt, requestId: next.requestId, attemptId: next.attemptId,
      slotRevision: 2, reservedAt: next.lastStartedAt,
      sendBeforeAt: next.sendBeforeAt }, next.lastStartedAt);
  const update = commands[0].input.TransactItems[0].Update;
  assert.match(update.ConditionExpression, /#revision = :previousRevision/);
  assert.match(update.ConditionExpression, /#nextEligibleAt <= :now/);
  assert.equal(update.ExpressionAttributeValues[":previousRevision"], 1);
  assert.equal(update.ExpressionAttributeValues[":now"], next.lastStartedAt);
});
