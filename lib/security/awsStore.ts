import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SecurityError, type Mutation, type Row, type Store } from "./types";

export class DynamoSecurityStore implements Store {
  private client: DynamoDBDocumentClient;
  constructor(readonly table: string, readonly region: string) {
    this.client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } });
  }
  async get<T extends Row>(id: string) {
    return (await this.client.send(new GetCommand({ TableName: this.table, Key: { id }, ConsistentRead: true }))).Item as T | undefined;
  }
  async write(mutations: Mutation[]) {
    if (!mutations.length || mutations.length > 90) throw new SecurityError("INVALID_TRANSACTION", 500);
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: mutations.map(m => "row" in m ? {
        Put: { TableName: this.table, Item: m.row,
          ConditionExpression: m.expected === null ? "attribute_not_exists(id)" : "#v = :v",
          ...(m.expected === null ? {} : { ExpressionAttributeNames: { "#v": "version" }, ExpressionAttributeValues: { ":v": m.expected } }) },
      } : { Delete: { TableName: this.table, Key: { id: m.deleteId }, ConditionExpression: "#v = :v",
        ExpressionAttributeNames: { "#v": "version" }, ExpressionAttributeValues: { ":v": m.expected } } }) }));
    } catch (e) {
      if ((e as Error).name === "TransactionCanceledException") throw new SecurityError("STALE_RECORD", 409);
      throw new SecurityError("SECURITY_STORE_UNAVAILABLE", 503);
    }
  }
  async list(kind: string, cursor?: string) {
    if (!["device", "user", "event"].includes(kind)) throw new SecurityError("INVALID_QUERY", 400);
    let key: Record<string, string> | undefined;
    if (cursor) {
      try { key = JSON.parse(Buffer.from(cursor, "base64url").toString()); }
      catch { throw new SecurityError("INVALID_CURSOR", 400); }
      if (!key || key.kind !== kind || typeof key.id !== "string" || Object.keys(key).some(k => !["id", "kind"].includes(k)))
        throw new SecurityError("INVALID_CURSOR", 400);
    }
    const result = await this.client.send(new QueryCommand({ TableName: this.table, IndexName: "ByKind",
      KeyConditionExpression: "#k = :k", ExpressionAttributeNames: { "#k": "kind" },
      ExpressionAttributeValues: { ":k": kind, ":now": Math.floor(Date.now() / 1000) },
      FilterExpression: "attribute_not_exists(expiresAt) OR expiresAt > :now",
      Limit: 50, ScanIndexForward: false, ExclusiveStartKey: key }));
    return { items: (result.Items ?? []) as Row[],
      cursor: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64url") : undefined };
  }
  async rate(key: string, limit: number, windowSeconds: number, now: number) {
    const start = Math.floor(now / windowSeconds) * windowSeconds;
    try {
      await this.client.send(new UpdateCommand({ TableName: this.table, Key: { id: "rate#" + key + "#" + start },
        UpdateExpression: "SET expiresAt = :expiry ADD attempts :one",
        ConditionExpression: "attribute_not_exists(attempts) OR attempts < :limit",
        ExpressionAttributeValues: { ":expiry": start + windowSeconds * 2, ":one": 1, ":limit": limit } }));
    } catch (e) {
      if ((e as Error).name === "ConditionalCheckFailedException") throw new SecurityError("TOO_MANY_REQUESTS", 429);
      throw new SecurityError("SECURITY_STORE_UNAVAILABLE", 503);
    }
  }
}
