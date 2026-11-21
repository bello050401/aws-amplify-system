import { createHash, randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { normalizeSystemErrorSignal, type SystemErrorSignal } from "./contract";

export type ErrorQueueConfig = { table: string; region: string; release: string };
export function errorQueueConfig(env: NodeJS.ProcessEnv = process.env): ErrorQueueConfig | null {
  if (env.BELLO_SYSTEM_ERRORS_ENABLED !== "1") return null;
  const table = env.BELLO_SYSTEM_ERRORS_TABLE || "";
  const release = env.BELLO_SYSTEM_ERRORS_RELEASE || "unknown";
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(table) || !/^(?:[a-f0-9]{7,40}|unknown)$/.test(release)) return null;
  return {table, release, region: env.AWS_REGION || "us-west-2"};
}
export type QueueEvent = SystemErrorSignal & {id: string; release: string; createdAt: string; state: string; attempts: number; taskId?: string; runId?: string; outcome?: string; lease?: string; leaseUntil?: number};
export const queueStates = ["PENDING", "CLAIMED", "DISPATCHED", "NEEDS_OPERATOR", "VERIFIED_LOCAL", "FAILED"] as const;
export async function withQueueDeadline<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const deadline = new Promise<never>((_, reject) => {abort = () => reject(Error('DIAGNOSTIC_DEADLINE'));signal.addEventListener('abort', abort, {once:true});});
  try {return await Promise.race([action(), deadline]);}
  finally {signal.removeEventListener('abort', abort);}
}
export class SystemErrorQueue {
  readonly db: DynamoDBDocumentClient;
  constructor(readonly config: ErrorQueueConfig, db?: DynamoDBDocumentClient) {
    this.db = db || DynamoDBDocumentClient.from(new DynamoDBClient({region: config.region, maxAttempts: 1}), {marshallOptions: {removeUndefinedValues: true}});
  }
  async enqueue(signal: SystemErrorSignal, owner: string, now = Date.now(), deadline = AbortSignal.timeout(1500)) {
    const safe = normalizeSystemErrorSignal(signal);
    if (!safe || !owner) throw Error("INVALID_SIGNAL");
    const createdAt = new Date(now).toISOString();
    const day = createdAt.slice(0, 10), hour = createdAt.slice(0, 13);
    const digest = createHash("sha256").update(JSON.stringify([safe, this.config.release, day])).digest("hex");
    const id = `${createdAt}#${digest}`;
    const actor = createHash("sha256").update(`${day}:${owner}`).digest("hex");
    const expiresAt = Math.floor(now / 1000) + 7 * 86400;
    const event: QueueEvent = {...safe, id, release: this.config.release, createdAt, state: "PENDING", attempts: 0};
    const TableName = this.config.table;
    const budget = (pk: string, maximum: number) => ({Update: {TableName, Key: {pk, sk: "STATE"}, UpdateExpression: "SET expiresAt = :ttl ADD #n :one", ConditionExpression: "attribute_not_exists(#n) OR #n < :max", ExpressionAttributeNames: {"#n": "count"}, ExpressionAttributeValues: {":ttl": expiresAt, ":one": 1, ":max": maximum}}});
    try {
      await withQueueDeadline(() => this.db.send(new TransactWriteCommand({TransactItems: [
        {Put: {TableName, Item: {pk: `DEDUPE#${digest}`, sk: "STATE", eventId: id, expiresAt}, ConditionExpression: "attribute_not_exists(pk)"}},
        budget(`BUDGET#GLOBAL#${hour}`, 100), budget(`BUDGET#${actor}#${hour}`, 10),
        {Put: {TableName, Item: {pk: "ERRORS", sk: id, ...event, expiresAt}, ConditionExpression: "attribute_not_exists(pk)"}},
      ]}), {abortSignal: deadline}), deadline);
      return {accepted: true, duplicate: false};
    } catch (error) {
      if ((error as {name?: string}).name !== "TransactionCanceledException") throw error;
      // A canceled transaction may be contention/permissions, not a duplicate.
      const existing = await withQueueDeadline(() => this.db.send(new GetCommand({TableName, Key: {pk: `DEDUPE#${digest}`, sk: "STATE"}, ConsistentRead: true}), {abortSignal: deadline}), deadline);
      if (existing.Item) return {accepted: true, duplicate: true};
      throw Error("QUEUE_LIMIT_OR_CONFLICT");
    }
  }
  async list(cursor?: string, now = Date.now()) {
    let ExclusiveStartKey: {pk: string; sk: string} | undefined;
    if (cursor) {
      if (cursor.length > 512) throw Error("INVALID_CURSOR");
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (decoded.pk !== "ERRORS" || typeof decoded.sk !== "string" || decoded.sk.length > 140) throw Error("INVALID_CURSOR");
      ExclusiveStartKey = {pk: "ERRORS", sk: decoded.sk};
    }
    const result = await this.db.send(new QueryCommand({TableName: this.config.table, KeyConditionExpression: "pk = :pk AND sk >= :since", ExpressionAttributeValues: {":pk": "ERRORS", ":since": new Date(now - 7 * 86400000).toISOString()}, Limit: 25, ConsistentRead: true, ExclusiveStartKey}));
    const events = (result.Items || []).map(row => this.publicEvent(row));
    return {events, cursor: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64url") : null};
  }
  publicEvent(row: Record<string, unknown>): QueueEvent {
    const safe = normalizeSystemErrorSignal(row);
    if (!safe) throw Error("INVALID_STORED_SIGNAL");
    return {...safe, id: String(row.id), release: String(row.release), createdAt: String(row.createdAt), state: String(row.state), attempts: Number(row.attempts),
      ...(typeof row.taskId === "string" && {taskId: row.taskId}), ...(typeof row.runId === "string" && {runId: row.runId}), ...(typeof row.outcome === "string" && {outcome: row.outcome}),
      ...(typeof row.lease === "string" && {lease: row.lease}), ...(typeof row.leaseUntil === "number" && {leaseUntil: row.leaseUntil})};
  }
  async claim(id: string, now = Date.now()) {
    this.assertId(id);
    const lease = randomUUID();
    const result = await this.db.send(new UpdateCommand({TableName: this.config.table, Key: {pk: "ERRORS", sk: id},
      UpdateExpression: "SET #s = :claimed, lease = :lease, leaseUntil = :until ADD attempts :one",
      ConditionExpression: "attribute_exists(pk) AND expiresAt > :now AND attempts < :max AND (#s = :pending OR (#s = :claimed AND leaseUntil < :nowMs))",
      ExpressionAttributeNames: {"#s": "state"}, ExpressionAttributeValues: {":claimed": "CLAIMED", ":pending": "PENDING", ":lease": lease, ":until": now + 120000, ":one": 1, ":max": 3, ":now": Math.floor(now / 1000), ":nowMs": now}, ReturnValues: "ALL_NEW"}));
    return {event: this.publicEvent(result.Attributes || {}), lease};
  }
  async acknowledge(id: string, lease: string, state: string, taskId?: string, runId?: string, outcome?: string) {
    this.assertId(id);
    if (!/^[a-f0-9-]{36}$/.test(lease) || !["DISPATCHED", "NEEDS_OPERATOR", "VERIFIED_LOCAL", "FAILED"].includes(state) || (taskId && !/^task_[a-f0-9]{18}$/.test(taskId)) || (runId && !/^eco_[a-f0-9]{32}$/.test(runId)) || (outcome && !["PROFILE_REQUIRED", "PROVIDER_BLOCKED", "REPAIR_FAILED", "AWAITING_APPROVAL", "LOCAL_CHECKS_PASSED", "REGISTERED", "DISPATCH_FAILED"].includes(outcome))) throw Error("INVALID_ACK");
    await this.db.send(new UpdateCommand({TableName: this.config.table, Key: {pk: "ERRORS", sk: id},
      UpdateExpression: "SET #s = :state, taskId = :task, runId = :run, outcome = :outcome",
      ConditionExpression: "attribute_exists(pk) AND lease = :lease AND #s IN (:claimed, :dispatched)",
      ExpressionAttributeNames: {"#s": "state"}, ExpressionAttributeValues: {":state": state, ":task": taskId || null, ":run": runId || null, ":outcome": outcome || "REGISTERED", ":lease": lease, ":claimed": "CLAIMED", ":dispatched": "DISPATCHED"}}));
  }
  async retry(id: string, now = Date.now()) {
    this.assertId(id);
    await this.db.send(new UpdateCommand({TableName: this.config.table, Key: {pk: "ERRORS", sk: id}, UpdateExpression: "SET #s = :pending, attempts = :zero REMOVE lease, leaseUntil", ConditionExpression: "attribute_exists(pk) AND (#s = :operator OR (#s = :claimed AND leaseUntil < :now))", ExpressionAttributeNames: {"#s": "state"}, ExpressionAttributeValues: {":pending": "PENDING", ":operator": "NEEDS_OPERATOR", ":claimed": "CLAIMED", ":now": now, ":zero": 0}}));
  }
  async markExhausted(id: string, now = Date.now()) {
    this.assertId(id);
    await this.db.send(new UpdateCommand({TableName:this.config.table,Key:{pk:'ERRORS',sk:id},UpdateExpression:'SET #s = :operator, outcome = :outcome',
      ConditionExpression:'attribute_exists(pk) AND #s = :claimed AND attempts >= :max AND leaseUntil < :now',ExpressionAttributeNames:{'#s':'state'},
      ExpressionAttributeValues:{':operator':'NEEDS_OPERATOR',':outcome':'DISPATCH_FAILED',':claimed':'CLAIMED',':max':3,':now':now}}));
  }
  private assertId(id: string) {if (!/^\d{4}-\d\d-\d\dT[\d:.]+Z#[a-f0-9]{64}$/.test(id)) throw Error("INVALID_ID");}
}
