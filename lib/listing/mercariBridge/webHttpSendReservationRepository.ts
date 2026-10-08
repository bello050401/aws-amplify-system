import "server-only";

import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type {
  WebHttpSendAttempt,
  WebHttpSendReservationRepository,
  WebHttpShopSendSlot,
} from "./webHttpSendReservation.ts";

type Tables = {
  slotTableName: string;
  attemptTableName: string;
};

/** Table names and the client are injected; this adapter does not enable sending. */
export class DynamoWebHttpSendReservationRepository
  implements WebHttpSendReservationRepository {
  private readonly ddb: DynamoDBDocumentClient;
  private readonly tables: Tables;

  constructor(
    ddb: DynamoDBDocumentClient,
    tables: Tables,
  ) {
    if (!tables.slotTableName?.trim() || !tables.attemptTableName?.trim() ||
        tables.slotTableName === tables.attemptTableName)
      throw new Error("Distinct reservation table names are required");
    this.ddb = ddb;
    this.tables = tables;
  }

  async getSlot(shopId: string): Promise<WebHttpShopSendSlot | null> {
    const response = await this.ddb.send(new GetCommand({
      TableName: this.tables.slotTableName,
      Key: { shopId },
      ConsistentRead: true,
    }));
    return (response.Item as WebHttpShopSendSlot | undefined) ?? null;
  }

  async getAttempt(requestId: string): Promise<WebHttpSendAttempt | null> {
    const response = await this.ddb.send(new GetCommand({
      TableName: this.tables.attemptTableName,
      Key: { requestId },
      ConsistentRead: true,
    }));
    return (response.Item as WebHttpSendAttempt | undefined) ?? null;
  }

  async transactReserve(previous: WebHttpShopSendSlot | null,
    next: WebHttpShopSendSlot, attempt: WebHttpSendAttempt,
    nowIso: string): Promise<void> {
    const names = {
      "#shopId": "shopId", "#revision": "revision",
      "#lastStartedAt": "lastStartedAt", "#sendBeforeAt": "sendBeforeAt",
      "#nextEligibleAt": "nextEligibleAt", "#requestId": "requestId",
      "#attemptId": "attemptId", "#requestedBy": "requestedBy",
      "#createdAt": "createdAt", "#updatedAt": "updatedAt",
    };
    const values: Record<string, string | number> = {
      ":revision": next.revision,
      ":lastStartedAt": next.lastStartedAt,
      ":sendBeforeAt": next.sendBeforeAt,
      ":nextEligibleAt": next.nextEligibleAt,
      ":requestId": next.requestId,
      ":attemptId": next.attemptId,
      ":requestedBy": next.requestedBy,
      ":now": nowIso,
    };
    if (previous) {
      values[":previousRevision"] = previous.revision;
      values[":previousAttemptId"] = previous.attemptId;
    }
    await this.ddb.send(new TransactWriteCommand({
      ClientRequestToken: next.attemptId,
      TransactItems: [
        { Update: {
          TableName: this.tables.slotTableName,
          Key: { shopId: next.shopId },
          UpdateExpression: "SET #revision = :revision, #lastStartedAt = :lastStartedAt, " +
            "#sendBeforeAt = :sendBeforeAt, #nextEligibleAt = :nextEligibleAt, " +
            "#requestId = :requestId, #attemptId = :attemptId, " +
            "#requestedBy = :requestedBy, " +
            "#createdAt = if_not_exists(#createdAt, :now), #updatedAt = :now",
          ConditionExpression: previous ?
            "#revision = :previousRevision AND #attemptId = :previousAttemptId " +
              "AND #nextEligibleAt <= :now" :
            "attribute_not_exists(#shopId)",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        } },
        { Put: {
          TableName: this.tables.attemptTableName,
          Item: { ...attempt, createdAt: nowIso, updatedAt: nowIso },
          ConditionExpression: "attribute_not_exists(#requestId)",
          ExpressionAttributeNames: { "#requestId": "requestId" },
        } },
      ],
    }));
  }
}
