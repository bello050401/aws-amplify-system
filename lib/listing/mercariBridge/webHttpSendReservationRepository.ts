import "server-only";

import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type {
  WebHttpSendAttempt,
  WebHttpSendReservationRepository,
  WebHttpShopSendSlot,
} from "./webHttpSendReservation.ts";
import { webHttpProductStopGuardId } from "./webHttpSendReservation.ts";
import { WEB_HTTP_MIN_SEND_INTERVAL_MS } from "./webHttpExecutionGate.ts";

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

  /** A completed product write cannot send again. Keep the 30-second interval,
   * but do not also wait for its unused send lease. Unknown results retain the
   * full lease. A late receipt cannot shorten another operation's reservation.
   * Failure here retains the conservative interval; it does not undo success.
   */
  private async completeProductSend(requestId: string, attemptId: string,
    remoteProductId: string, nowIso: string): Promise<void> {
    try {
      const attempt = await this.getAttempt(requestId);
      if (!attempt || attempt.attemptId !== attemptId ||
          attempt.remoteProductId !== remoteProductId ||
          !["PRODUCT_ACKNOWLEDGED", "PRODUCT_STOP_VERIFIED", "PRODUCT_REOPEN_VERIFIED"].includes(attempt.status)) return;
      const slot = await this.getSlot(attempt.shopId);
      const now = Date.parse(nowIso);
      if (!slot || slot.requestId !== requestId || slot.attemptId !== attemptId ||
          slot.revision !== attempt.slotRevision || !Number.isSafeInteger(now) ||
          now < Date.parse(slot.lastStartedAt)) return;
      const nextEligibleAt = new Date(now + WEB_HTTP_MIN_SEND_INTERVAL_MS).toISOString();
      if (Date.parse(nextEligibleAt) >= Date.parse(slot.nextEligibleAt)) return;
      await this.ddb.send(new TransactWriteCommand({ TransactItems: [{ ConditionCheck: {
        TableName: this.tables.attemptTableName, Key: { requestId },
        ConditionExpression: "#s = :completed AND attemptId = :attempt AND remoteProductId = :product AND slotRevision = :revision",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":completed": attempt.status, ":attempt": attemptId,
          ":product": remoteProductId, ":revision": slot.revision },
      } }, { Update: {
        TableName: this.tables.slotTableName, Key: { shopId: attempt.shopId },
        UpdateExpression: "SET sendCompletedAt = :now, nextEligibleAt = :next, updatedAt = :now",
        ConditionExpression: "revision = :revision AND requestId = :request AND attemptId = :attempt AND nextEligibleAt > :next",
        ExpressionAttributeValues: { ":revision": slot.revision, ":request": requestId,
          ":attempt": attemptId, ":now": nowIso, ":next": nextEligibleAt },
      } }] }));
    } catch { /* Keep the original durable lease on conflict or storage failure. */ }
  }

  async getPendingProductStop(shopId: string, productId: string): Promise<string | null> {
    const response = await this.ddb.send(new GetCommand({
      TableName: this.tables.attemptTableName,
      Key: { requestId: webHttpProductStopGuardId(shopId, productId) },
      ConsistentRead: true,
    }));
    if (!response.Item) return null;
    if (response.Item.status !== "PRODUCT_STOP_PENDING" ||
        !/^[a-f0-9]{64}$/.test(response.Item.linkedRequestId)) throw Error("INVALID_STOP_GUARD");
    return response.Item.linkedRequestId;
  }

  /** Save a create receipt before linking it to an inventory or reporting success. */
  async acknowledgeProduct(requestId: string, attemptId: string,
    remoteProductId: string, nowIso: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(requestId) || !/^[A-Za-z0-9]{1,64}$/.test(remoteProductId) ||
        !Number.isFinite(Date.parse(nowIso))) throw Error("INVALID_PRODUCT_RECEIPT");
    await this.ddb.send(new UpdateCommand({
      TableName: this.tables.attemptTableName, Key: { requestId },
      UpdateExpression: "SET #s = :ack, remoteProductId = :id, updatedAt = :now",
      ConditionExpression: "#s = :claimed AND attemptId = :attempt AND attribute_not_exists(remoteProductId)",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":ack": "PRODUCT_ACKNOWLEDGED",
        ":claimed": "SEND_CLAIMED_RESULT_UNKNOWN", ":attempt": attemptId,
        ":id": remoteProductId, ":now": nowIso },
    }));
    await this.completeProductSend(requestId, attemptId, remoteProductId, nowIso);
  }

  /** Record the reviewed, non-secret payload atomically with the one-use claim.
   * CreateProduct can consume its draft, so recovery cannot depend on that draft.
   */
  async claimProductStart(requestId: string, attemptId: string,
    requestJson: string, nowIso: string): Promise<void> {
    if (Buffer.byteLength(requestJson, "utf8") > 100_000) throw Error("INVALID_PRODUCT_INPUT");
    await this.ddb.send(new UpdateCommand({
      TableName: this.tables.attemptTableName, Key: { requestId },
      UpdateExpression: "SET #s = :claimed, productCreateRequestJson = :request, startedAt = :now, updatedAt = :now",
      ConditionExpression: "#s = :reserved AND attemptId = :attempt AND attribute_not_exists(productCreateRequestJson)",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":claimed": "SEND_CLAIMED_RESULT_UNKNOWN", ":reserved": "RESERVED_NO_SEND",
        ":attempt": attemptId, ":request": requestJson, ":now": nowIso },
    }));
  }

  /** A second call with the same reservation fails its status condition. */
  async claimMutationStart(requestId: string, attemptId: string,
    nowIso: string): Promise<void> {
    await this.ddb.send(new UpdateCommand({
      TableName: this.tables.attemptTableName,
      Key: { requestId },
      UpdateExpression: "SET #status = :claimed, #startedAt = :now, " +
        "#updatedAt = :now",
      ConditionExpression: "#status = :reserved AND #attemptId = :attemptId",
      ExpressionAttributeNames: { "#status": "status",
        "#attemptId": "attemptId", "#startedAt": "startedAt",
        "#updatedAt": "updatedAt" },
      ExpressionAttributeValues: { ":reserved": "RESERVED_NO_SEND",
        ":claimed": "SEND_CLAIMED_RESULT_UNKNOWN",
        ":attemptId": attemptId, ":now": nowIso },
    }));
  }

  /** Persist the exact asset acknowledgement; a second or changed result fails. */
  async acknowledgeImageAsset(requestId: string, attemptId: string,
    remoteAssetId: string, preparedJpegSha256: string,
    nowIso: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(requestId) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId) ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(remoteAssetId) ||
        !/^[a-f0-9]{64}$/.test(preparedJpegSha256) ||
        !Number.isFinite(Date.parse(nowIso)))
      throw new Error("INVALID_IMAGE_ACKNOWLEDGEMENT");
    await this.ddb.send(new UpdateCommand({
      TableName: this.tables.attemptTableName,
      Key: { requestId },
      UpdateExpression: "SET #status = :ack, #remoteAssetId = :assetId, " +
        "#preparedJpegSha256 = :sha, #updatedAt = :now",
      ConditionExpression: "#status = :claimed AND #attemptId = :attemptId " +
        "AND attribute_not_exists(#remoteAssetId)",
      ExpressionAttributeNames: { "#status": "status",
        "#attemptId": "attemptId", "#remoteAssetId": "remoteAssetId",
        "#preparedJpegSha256": "preparedJpegSha256",
        "#updatedAt": "updatedAt" },
      ExpressionAttributeValues: { ":claimed": "SEND_CLAIMED_RESULT_UNKNOWN",
        ":ack": "IMAGE_ACKNOWLEDGED", ":attemptId": attemptId,
        ":assetId": remoteAssetId, ":sha": preparedJpegSha256,
        ":now": nowIso },
    }));
  }

  /** An acknowledged create/update becomes usable only after durable storage. */
  async acknowledgeDraftMutation(requestId: string, attemptId: string,
    kind: "CREATE" | "UPDATE", remoteDraftId: string,
    nowIso: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(requestId) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId) ||
        !["CREATE", "UPDATE"].includes(kind) ||
        !/^[A-Za-z0-9]{1,64}$/.test(remoteDraftId) ||
        !Number.isFinite(Date.parse(nowIso)))
      throw new Error("INVALID_DRAFT_ACKNOWLEDGEMENT");
    await this.ddb.send(new UpdateCommand({
      TableName: this.tables.attemptTableName,
      Key: { requestId },
      UpdateExpression: "SET #status = :ack, #remoteDraftId = :draftId, " +
        "#draftMutationKind = :kind, #updatedAt = :now",
      ConditionExpression: "#status = :claimed AND #attemptId = :attemptId " +
        "AND attribute_not_exists(#remoteDraftId)",
      ExpressionAttributeNames: { "#status": "status",
        "#attemptId": "attemptId", "#remoteDraftId": "remoteDraftId",
        "#draftMutationKind": "draftMutationKind",
        "#updatedAt": "updatedAt" },
      ExpressionAttributeValues: { ":claimed": "SEND_CLAIMED_RESULT_UNKNOWN",
        ":ack": "DRAFT_ACKNOWLEDGED", ":attemptId": attemptId,
        ":draftId": remoteDraftId, ":kind": kind, ":now": nowIso },
    }));
  }

  /** Only a fresh, matching readback may record a stop as verified. An ACK or
   * failed/unauthenticated read alone never changes the persisted result.
   */
  async verifyProductStop(requestId: string, attemptId: string, shopId: string,
    remoteProductId: string, productContentFingerprint: string,
    nowIso: string, desiredStatus: "STATUS_OPENED" | "STATUS_UNOPENED" = "STATUS_UNOPENED"): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(requestId) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId) ||
        !/^[A-Za-z0-9]{1,64}$/.test(remoteProductId) ||
        !/^[a-f0-9]{64}$/.test(productContentFingerprint) ||
        !Number.isFinite(Date.parse(nowIso))) throw Error("INVALID_PRODUCT_STOP_RESULT");
    await this.ddb.send(new TransactWriteCommand({ TransactItems: [{ Update: {
      TableName: this.tables.attemptTableName, Key: { requestId },
      UpdateExpression: "SET #status = :verified, #updatedAt = :now",
      ConditionExpression: "#status = :claimed " +
        "AND #attemptId = :attemptId AND #productId = :productId " +
        "AND #fingerprint = :fingerprint" + (desiredStatus === "STATUS_OPENED" ? " AND desiredProductStatus = :desired" :
          " AND (attribute_not_exists(desiredProductStatus) OR desiredProductStatus = :desired)"),
      ExpressionAttributeNames: { "#status": "status", "#updatedAt": "updatedAt",
        "#attemptId": "attemptId", "#productId": "remoteProductId",
        "#fingerprint": "productContentFingerprint" },
      ExpressionAttributeValues: { ":claimed": "SEND_CLAIMED_RESULT_UNKNOWN",
        ":verified": desiredStatus === "STATUS_OPENED" ? "PRODUCT_REOPEN_VERIFIED" : "PRODUCT_STOP_VERIFIED",
        ":desired": desiredStatus, ":now": nowIso,
        ":attemptId": attemptId, ":productId": remoteProductId,
        ":fingerprint": productContentFingerprint },
    } }, { Delete: {
      TableName: this.tables.attemptTableName,
      Key: { requestId: webHttpProductStopGuardId(shopId, remoteProductId) },
      ConditionExpression: "#linkedRequestId = :requestId",
      ExpressionAttributeNames: { "#linkedRequestId": "linkedRequestId" },
      ExpressionAttributeValues: { ":requestId": requestId },
    } }] }));
    await this.completeProductSend(requestId, attemptId, remoteProductId, nowIso);
  }

  /** This can release a reservation only if no sender ever claimed it. */
  async cancelUnclaimedProductStop(attempt: WebHttpSendAttempt): Promise<void> {
    if (!attempt.remoteProductId) throw Error("INVALID_STOP_ATTEMPT");
    await this.ddb.send(new TransactWriteCommand({ TransactItems: [{ Update: {
      TableName: this.tables.attemptTableName, Key: { requestId: attempt.requestId },
      UpdateExpression: "SET #status = :cancelled",
      ConditionExpression: "#status = :reserved AND #attemptId = :attemptId",
      ExpressionAttributeNames: { "#status": "status", "#attemptId": "attemptId" },
      ExpressionAttributeValues: { ":reserved": "RESERVED_NO_SEND",
        ":cancelled": "CANCELLED_NO_SEND", ":attemptId": attempt.attemptId },
    } }, { Delete: {
      TableName: this.tables.attemptTableName,
      Key: { requestId: webHttpProductStopGuardId(attempt.shopId, attempt.remoteProductId) },
      ConditionExpression: "#linkedRequestId = :requestId",
      ExpressionAttributeNames: { "#linkedRequestId": "linkedRequestId" },
      ExpressionAttributeValues: { ":requestId": attempt.requestId },
    } }] }));
  }

  async transactReserve(previous: WebHttpShopSendSlot | null,
    next: WebHttpShopSendSlot, attempt: WebHttpSendAttempt,
    nowIso: string): Promise<void> {
    const names = {
      ...(!previous ? { "#shopId": "shopId" } : {}),
      "#revision": "revision",
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
            "#createdAt = if_not_exists(#createdAt, :now), #updatedAt = :now REMOVE sendCompletedAt",
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
          ConditionExpression: attempt.remoteProductId ?
            "attribute_not_exists(#requestId) OR #status = :cancelled" :
            "attribute_not_exists(#requestId)",
          ExpressionAttributeNames: { "#requestId": "requestId",
            ...(attempt.remoteProductId ? { "#status": "status" } : {}) },
          ...(attempt.remoteProductId ? {
            ExpressionAttributeValues: { ":cancelled": "CANCELLED_NO_SEND" },
          } : {}),
        } },
        ...(attempt.remoteProductId ? [{ Put: {
          TableName: this.tables.attemptTableName,
          // Same physical table, separate hashed key. Keep the model's required
          // fields so an administrative GraphQL list cannot fail on this row.
          Item: { ...attempt,
            requestId: webHttpProductStopGuardId(attempt.shopId, attempt.remoteProductId),
            status: "PRODUCT_STOP_PENDING", linkedRequestId: attempt.requestId,
            createdAt: nowIso, updatedAt: nowIso },
          ConditionExpression: "attribute_not_exists(#requestId)",
          ExpressionAttributeNames: { "#requestId": "requestId" },
        } }] : []),
      ],
    }));
  }
}
