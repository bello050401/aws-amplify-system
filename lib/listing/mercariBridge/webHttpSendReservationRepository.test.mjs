import test from "node:test";
import assert from "node:assert/strict";
import { GetCommand, TransactWriteCommand, UpdateCommand } from
  "@aws-sdk/lib-dynamodb";
import { DynamoWebHttpSendReservationRepository } from
  "./webHttpSendReservationRepository.ts";
import { webHttpProductStopGuardId } from "./webHttpSendReservation.ts";

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

test("stop reserves shop slot, attempt and product guard in a single transaction", async () => {
  const commands = [];
  const repo = new DynamoWebHttpSendReservationRepository({ send: async c => {
    commands.push(c); return {};
  } }, tables);
  const stop = { ...attempt, remoteProductId: "Product123", productSnapshotId: "revision-1",
    productContentFingerprint: "c".repeat(64) };
  await repo.transactReserve(null, firstSlot, stop, firstSlot.lastStartedAt);
  const writes = commands[0].input.TransactItems;
  assert.equal(writes.length, 3);
  assert.equal(writes[1].Put.ExpressionAttributeValues[":cancelled"], "CANCELLED_NO_SEND");
  assert.equal(writes[2].Put.Item.requestId, webHttpProductStopGuardId(stop.shopId, stop.remoteProductId));
  assert.equal(writes[2].Put.Item.linkedRequestId, attempt.requestId);
  assert.equal(writes[2].Put.Item.inventoryId, attempt.inventoryId);
  assert.equal(writes[2].Put.Item.snapshotFingerprint, attempt.snapshotFingerprint);
  assert.equal(writes[2].Put.ConditionExpression, "attribute_not_exists(#requestId)");
});

test("stop readback commits result and removes only its own pending guard atomically", async () => {
  const commands = [];
  const repo = new DynamoWebHttpSendReservationRepository({ send: async c => {
    commands.push(c); return {};
  } }, tables);
  await repo.verifyProductStop(attempt.requestId, attempt.attemptId, "shop",
    "Product123", "c".repeat(64), "2026-10-13T10:00:00.000Z");
  assert.ok(commands[0] instanceof TransactWriteCommand);
  const [update, remove] = commands[0].input.TransactItems;
  assert.equal(update.Update.ExpressionAttributeValues[":claimed"], "SEND_CLAIMED_RESULT_UNKNOWN");
  assert.equal(update.Update.ExpressionAttributeValues[":verified"], "PRODUCT_STOP_VERIFIED");
  assert.match(update.Update.ConditionExpression, /#productId = :productId/);
  assert.match(update.Update.ConditionExpression, /#fingerprint = :fingerprint/);
  assert.equal(remove.Delete.ExpressionAttributeValues[":requestId"], attempt.requestId);
  assert.equal(remove.Delete.ConditionExpression, "#linkedRequestId = :requestId");
});

test("cancelling an unused stop cannot release an already claimed operation", async () => {
  const commands = [];
  const repo = new DynamoWebHttpSendReservationRepository({ send: async c => {
    commands.push(c); return {};
  } }, tables);
  await repo.cancelUnclaimedProductStop({ ...attempt, remoteProductId: "Product123" });
  const [update, remove] = commands[0].input.TransactItems;
  assert.equal(update.Update.ExpressionAttributeValues[":reserved"], "RESERVED_NO_SEND");
  assert.equal(update.Update.ExpressionAttributeValues[":cancelled"], "CANCELLED_NO_SEND");
  assert.equal(update.Update.ConditionExpression, "#status = :reserved AND #attemptId = :attemptId");
  assert.equal(remove.Delete.ExpressionAttributeValues[":requestId"], attempt.requestId);
});

test("pending stop lookup is consistent and rejects malformed storage", async () => {
  const commands = [];
  let item = { status: "PRODUCT_STOP_PENDING", linkedRequestId: "a".repeat(64) };
  const repo = new DynamoWebHttpSendReservationRepository({ send: async c => {
    commands.push(c); return { Item: item };
  } }, tables);
  assert.equal(await repo.getPendingProductStop("shop", "Product123"), "a".repeat(64));
  assert.equal(commands[0].input.ConsistentRead, true);
  item = { ...item, linkedRequestId: "malformed" };
  await assert.rejects(repo.getPendingProductStop("shop", "Product123"), /INVALID_STOP_GUARD/);
});

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
  assert.equal(input.TransactItems[0].Update.ExpressionAttributeNames["#shopId"],
    "shopId");
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
  assert.equal(Object.hasOwn(update.ExpressionAttributeNames, "#shopId"), false);
  assert.equal(update.ExpressionAttributeValues[":previousRevision"], 1);
  assert.equal(update.ExpressionAttributeValues[":now"], next.lastStartedAt);
});

test("mutation start is a conditional, durable one-time claim", async () => {
  const commands = [];
  const repo = new DynamoWebHttpSendReservationRepository({
    send: async command => { commands.push(command); return {}; },
  }, tables);
  await repo.claimMutationStart(attempt.requestId, attempt.attemptId,
    "2026-10-09T00:00:01.000Z");
  assert.equal(commands.length, 1);
  assert.ok(commands[0] instanceof UpdateCommand);
  assert.equal(commands[0].input.TableName, tables.attemptTableName);
  assert.equal(commands[0].input.Key.requestId, attempt.requestId);
  assert.match(commands[0].input.ConditionExpression,
    /#status = :reserved AND #attemptId = :attemptId/);
  assert.equal(commands[0].input.ExpressionAttributeValues[":claimed"],
    "SEND_CLAIMED_RESULT_UNKNOWN");
});

test("image acknowledgement is one conditional write tied to claimed attempt", async () => {
  const commands = [];
  const repo = new DynamoWebHttpSendReservationRepository({
    send: async command => { commands.push(command); return {}; },
  }, tables);
  await repo.acknowledgeImageAsset(attempt.requestId, attempt.attemptId,
    "asset_123", "a".repeat(64), "2026-10-09T00:00:02.000Z");
  assert.equal(commands.length, 1);
  assert.ok(commands[0] instanceof UpdateCommand);
  const input = commands[0].input;
  assert.equal(input.Key.requestId, attempt.requestId);
  assert.match(input.ConditionExpression, /#status = :claimed/);
  assert.match(input.ConditionExpression, /attribute_not_exists\(#remoteAssetId\)/);
  assert.equal(input.ExpressionAttributeValues[":assetId"], "asset_123");
  await assert.rejects(() => repo.acknowledgeImageAsset(attempt.requestId,
    attempt.attemptId, "bad/id", "a".repeat(64),
    "2026-10-09T00:00:02.000Z"), /INVALID_IMAGE_ACKNOWLEDGEMENT/);
  assert.equal(commands.length, 1);
});

test("draft acknowledgement stores the exact operation and remote ID", async () => {
  const commands = [];
  const repo = new DynamoWebHttpSendReservationRepository({
    send: async command => { commands.push(command); return {}; },
  }, tables);
  await repo.acknowledgeDraftMutation(attempt.requestId, attempt.attemptId,
    "CREATE", "Draft123", "2026-10-09T00:00:02.000Z");
  assert.equal(commands.length, 1);
  assert.ok(commands[0] instanceof UpdateCommand);
  const input = commands[0].input;
  assert.match(input.ConditionExpression, /#status = :claimed/);
  assert.match(input.ConditionExpression,
    /attribute_not_exists\(#remoteDraftId\)/);
  assert.equal(input.ExpressionAttributeValues[":kind"], "CREATE");
  assert.equal(input.ExpressionAttributeValues[":draftId"], "Draft123");
  await assert.rejects(() => repo.acknowledgeDraftMutation(
    attempt.requestId, attempt.attemptId, "CREATE", "bad/id",
    "2026-10-09T00:00:02.000Z"), /INVALID_DRAFT_ACKNOWLEDGEMENT/);
  assert.equal(commands.length, 1);
});
