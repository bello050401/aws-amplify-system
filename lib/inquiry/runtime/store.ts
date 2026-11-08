import {redactInquiryRecord} from '@/lib/messaging/contactPrivacy';
import "server-only";
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { runtimeConfig } from "@/lib/inquiry/runtime/config";
export { runtimeConfig } from "@/lib/inquiry/runtime/config";
export type { RuntimeConfig } from "@/lib/inquiry/runtime/config";
import { eventKey, nextDue, scopeKey, LEASE_MS, inquiryActivityAt } from "./policy";
import type { LineWebhookEvent } from "@/lib/messaging/line/types";
import type { processInquiryAndNotify } from "@/lib/inquiry/autoReply";

const db = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: "us-west-2" }),
  { marshallOptions: { removeUndefinedValues: true } },
);
export type EventPayload =
  | { channel: "LINE"; account: string; event: LineWebhookEvent }
  | {
      channel: "MERCARI_SHOPS";
      params: Parameters<typeof processInquiryAndNotify>[0];
    };
export type InboxEvent = {
  pk: string;
  sk: string;
  version: number;
  payload: EventPayload;
  receivedAt: number;
  ttl: number;
};
export type InboxState = {
  pk: string;
  sk: "STATE";
  version: number;
  processedVersion?: number;
  firstAt: number;
  dueAt: number;
  lastAt: number;
  activityVersion?: number;
  lockOwner?: string;
  lockUntil?: number;
  conversationId?: string;
  lastEventSk?: string;
  sourceEventSk?: string;
  result?: string;
  reason?: string;
  mode?: "DRAFT" | "STAFF";
  overrideInventoryId?: string;
  overrideVersion?: number;
  lastDeliveryJobId?:string;
};
const conditional = (e: unknown) =>
  ["ConditionalCheckFailedException", "TransactionCanceledException"].includes(
    (e as Error).name,
  );
export async function inquirySettings() {
  return (
    (await getRuntimeRecord("CONFIG")) ?? { enabled: false, notifyStaff: false }
  );
}
export async function stateFor(pk: string): Promise<InboxState | null> {
  return (
    ((
      await db.send(
        new GetCommand({
          TableName: runtimeConfig().table,
          Key: { pk, sk: "STATE" },
          ConsistentRead: true,
        }),
      )
    ).Item as InboxState) ?? null
  );
}
export async function enqueueInquiry(
  channel: string,
  account: string,
  conversation: string,
  id: string,
  payload: EventPayload,
  occurredAt?: string | number,
) {
  payload=redactInquiryRecord(payload);
  const c = runtimeConfig(),
    pk = scopeKey(channel, account, conversation),
    sk = eventKey(id);
  let recorded = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    const prior = (
      await db.send(
        new GetCommand({
          TableName: c.table,
          Key: { pk, sk },
          ConsistentRead: true,
        }),
      )
    ).Item;
    if (prior) {
      recorded = true;
      break;
    }
    const state = await stateFor(pk),
      now = Date.now(),
      version = (state?.version ?? 0) + 1;
    const first =
      state && state.version > (state.processedVersion ?? 0)
        ? state.firstAt
        : now;
    try {
      await db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: c.table,
                Item: {
                  pk,
                  sk,
                  version,
                  payload,
                  receivedAt: now,
                  ttl: Math.ceil(now / 1000) + 30 * 86400,
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Update: {
                TableName: c.table,
                Key: { pk, sk: "STATE" },
                UpdateExpression:
                  "SET #v=:v, firstAt=:first, lastAt=:activity, activityVersion=:activityVersion, dueAt=:due, #result=:queued, kind=:kind, channel=:channel,lastEventSk=:event",
                ConditionExpression: state
                  ? "#v=:old"
                  : "attribute_not_exists(#v)",
                ExpressionAttributeNames: {
                  "#v": "version",
                  "#result": "result",
                },
                ExpressionAttributeValues: {
                  ":v": version,
                  ":first": first,
                  ":activity": inquiryActivityAt(payload.channel === "LINE" ? payload.event.timestamp : occurredAt, state?.activityVersion === 1 ? state.lastAt : undefined, now),
                  ":activityVersion": 1,
                  ":due": nextDue(first, now),
                  ":queued": "QUEUED",
                  ":kind": "INBOX",
                  ":channel": channel,
                  ":event": sk,
                  ...(state ? { ":old": state.version } : {}),
                },
              },
            },
          ],
        }),
      );
      recorded = true;
      break;
    } catch (e) {
      if (!conditional(e)) throw e;
    }
  }
  if (!recorded) throw Error("受信記録が競合しました。再送を待っています。");
  // Only acknowledge the webhook after BOTH durable storage and queue acceptance.
  // If SQS fails, a redelivery queues the existing event without increasing version.
  await new SQSClient({ region: c.region }).send(
    new SendMessageCommand({
      QueueUrl: c.queueUrl,
      MessageBody: JSON.stringify({ pk }),
      DelaySeconds: 5,
    }),
  );
  return pk;
}
export async function claimInquiry(
  pk: string,
): Promise<
  { state: InboxState; owner: string } | { retrySeconds: number } | null
> {
  const state = await stateFor(pk),
    now = Date.now();
  if (!state || state.version <= (state.processedVersion ?? 0)) return null;
  if (state.dueAt > now)
    return { retrySeconds: Math.max(1, Math.ceil((state.dueAt - now) / 1000)) };
  if (state.lockUntil && state.lockUntil > now) return { retrySeconds: 5 };
  const owner = randomUUID();
  try {
    await db.send(
      new UpdateCommand({
        TableName: runtimeConfig().table,
        Key: { pk, sk: "STATE" },
        UpdateExpression:
          "SET lockOwner=:owner, lockUntil=:until, #result=:working",
        ConditionExpression:
          "#v=:v AND (attribute_not_exists(lockUntil) OR lockUntil<:now)",
        ExpressionAttributeNames: { "#v": "version", "#result": "result" },
        ExpressionAttributeValues: {
          ":owner": owner,
          ":until": now + LEASE_MS,
          ":now": now,
          ":v": state.version,
          ":working": "PROCESSING",
        },
      }),
    );
    return { state, owner };
  } catch (e) {
    if (conditional(e)) return { retrySeconds: 5 };
    throw e;
  }
}
export async function eventsFor(state: InboxState) {
  const rows: InboxEvent[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const page = await db.send(
      new QueryCommand({
        TableName: runtimeConfig().table,
        KeyConditionExpression: "pk=:pk AND begins_with(sk,:event)",
        FilterExpression: "#v>:after AND #v<=:before",
        ExpressionAttributeNames: { "#v": "version" },
        ExpressionAttributeValues: {
          ":pk": state.pk,
          ":event": "EVENT#",
          ":after": state.processedVersion ?? 0,
          ":before": state.version,
        },
        ConsistentRead: true,
        ExclusiveStartKey: key,
        Limit: 100,
      }),
    );
    rows.push(...((page.Items ?? []) as InboxEvent[]));
    key = page.LastEvaluatedKey;
    if (rows.length > 200) throw Error("受信件数が多いため確認が必要です。");
  } while (key);
  return rows.sort((a, b) => a.version - b.version);
}
export async function stillCurrent(state: InboxState, owner: string) {
  const c = await stateFor(state.pk);
  return (
    !!c &&
    c.version === state.version &&
    c.lockOwner === owner &&
    (c.lockUntil ?? 0) > Date.now() &&
    c.mode !== "STAFF"
  );
}
export async function finishInquiry(
  state: InboxState,
  owner: string,
  result: string,
  reason: string,
  conversationId?: string,
  sourceEventSk?: string,
) {
  await db.send(
    new UpdateCommand({
      TableName: runtimeConfig().table,
      Key: { pk: state.pk, sk: "STATE" },
      ConditionExpression:
        "lockOwner=:owner AND #version=:v AND lockUntil>:now" +
        (result === "ANSWERABLE"
          ? " AND (attribute_not_exists(#mode) OR #mode<>:staff)"
          : ""),
      UpdateExpression:
        "SET processedVersion=:v, #result=:r, reason=:reason" +
        (conversationId ? ", conversationId=:cid" : "") +
        (sourceEventSk ? ", sourceEventSk=:source" : "") +
        " REMOVE lockOwner,lockUntil",
      ExpressionAttributeNames: {
        "#result": "result",
        "#version": "version",
        ...(result === "ANSWERABLE" ? { "#mode": "mode" } : {}),
      },
      ExpressionAttributeValues: {
        ":owner": owner,
        ":v": state.version,
        ":now": Date.now(),
        ":r": result,
        ":reason": reason,
        ...(result === "ANSWERABLE" ? { ":staff": "STAFF" } : {}),
        ...(conversationId ? { ":cid": conversationId } : {}),
        ...(sourceEventSk ? { ":source": sourceEventSk } : {}),
      },
    }),
  );
}
export async function releaseInquiry(
  state: InboxState,
  owner: string,
  failed = false,
) {
  try {
    await db.send(
      new UpdateCommand({
        TableName: runtimeConfig().table,
        Key: { pk: state.pk, sk: "STATE" },
        ConditionExpression: "lockOwner=:owner",
        UpdateExpression:
          (failed ? "SET #result=:blocked, reason=:reason " : "") +
          "REMOVE lockOwner,lockUntil",
        ...(failed
          ? { ExpressionAttributeNames: { "#result": "result" } }
          : {}),
        ExpressionAttributeValues: {
          ":owner": owner,
          ...(failed
            ? {
                ":blocked": "TECHNICAL_BLOCK",
                ":reason":
                  "接続または処理に失敗しました。受信記録を保持して再試行します。",
              }
            : {}),
        },
      }),
    );
  } catch (e) {
    if (!conditional(e)) throw e;
  }
}
/** Exact-id state records used by send deduplication and mailbox checkpoints. */
export async function getRuntimeRecord(pk: string, sk = "STATE") {
  return (
    await db.send(
      new GetCommand({
        TableName: runtimeConfig().table,
        Key: { pk, sk },
        ConsistentRead: true,
      }),
    )
  ).Item;
}
export async function createRuntimeRecord(item: Record<string, unknown>) {
 item=redactInquiryRecord(item);
  try {
    await db.send(
      new PutCommand({
        TableName: runtimeConfig().table,
        Item: item,
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return true;
  } catch (e) {
    if (conditional(e)) return false;
    throw e;
  }
}
export { db as inquiryDb };
