import {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";

/** Deleted stock must not leave its unselected Photo Station originals forever.
 * A missing parent alone is insufficient: require a recorded inventory deletion.
 * Mark each asset deleted first; the normal seven-day photo grace period follows.
 * Never touch a standalone/unlinked batch or an asset selected for a listing.
 */
export async function markDeletedInventoryPhotos(
  db: DynamoDBDocumentClient,
  photoTable: string,
  inventoryTable: string,
  historyTable: string,
  now = new Date(),
  onlyBatchIds?: ReadonlySet<string>,
) {
  let cursor: Record<string, unknown> | undefined;
  const batches: Record<string, unknown>[] = [];
  do {
    const r = await db.send(
      new ScanCommand({
        TableName: photoTable,
        ConsistentRead: true,
        ExclusiveStartKey: cursor,
        FilterExpression: "entityType = :batch AND #status = :linked",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":batch": "PhotoBatch",
          ":linked": "LINKED",
        },
      }),
    );
    batches.push(...(r.Items || []));
    cursor = r.LastEvaluatedKey;
  } while (cursor);
  const result = { marked: 0, protected: 0, failures: [] as string[] };
  for (const batch of batches) {
    if (onlyBatchIds && !onlyBatchIds.has(String(batch.id))) continue;
    if (
      !/^[0-9a-f-]{36}$/i.test(String(batch.inventoryId)) ||
      batch.openRevisionRevision != null
    )
      continue;
    const owner = await db.send(
      new GetCommand({
        TableName: inventoryTable,
        Key: { id: batch.inventoryId },
        ConsistentRead: true,
      }),
    );
    if (owner.Item) continue;
    let after: Record<string, unknown> | undefined,
      deletion: Record<string, unknown> | undefined;
    do {
      const r = await db.send(
        new QueryCommand({
          TableName: historyTable,
          IndexName: "inventoryHistoriesByInventoryIdAndChangedAt",
          KeyConditionExpression: "inventoryId = :id",
          ExpressionAttributeValues: { ":id": batch.inventoryId },
          ExclusiveStartKey: after,
          ScanIndexForward: false,
        }),
      );
      deletion = r.Items?.find(
        (x) => x.fieldName === "削除" && x.newValue === "削除済み",
      );
      after = deletion ? undefined : r.LastEvaluatedKey;
    } while (after);
    if (!deletion) {
      result.protected++;
      continue;
    }
    let assetCursor: Record<string, unknown> | undefined;
    do {
      const page = await db.send(
        new QueryCommand({
          TableName: photoTable,
          ConsistentRead: true,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: { ":pk": batch.PK, ":prefix": "ASSET#" },
          ExclusiveStartKey: assetCursor,
        }),
      );
      assetCursor = page.LastEvaluatedKey;
      for (const asset of page.Items || []) {
        if (asset.isDeleted) continue;
        if (
          asset.listingSelectionCount !== 0 ||
          !["READY", "FAILED", "UPLOADING"].includes(asset.status)
        ) {
          result.protected++;
          continue;
        }
        try {
          await db.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  ConditionCheck: {
                    TableName: inventoryTable,
                    Key: { id: batch.inventoryId },
                    ConditionExpression: "attribute_not_exists(id)",
                  },
                },
                {
                  ConditionCheck: {
                    TableName: historyTable,
                    Key: { id: deletion.id },
                    ConditionExpression:
                      "inventoryId = :id AND fieldName = :field AND newValue = :deleted",
                    ExpressionAttributeValues: {
                      ":id": batch.inventoryId,
                      ":field": "削除",
                      ":deleted": "削除済み",
                    },
                  },
                },
                {
                  Update: {
                    TableName: photoTable,
                    Key: { PK: asset.PK, SK: asset.SK },
                    UpdateExpression:
                      "SET isDeleted=:yes, #status=:deleted, statusBeforeDelete=:old, deletedAt=:now",
                    ConditionExpression:
                      "isDeleted=:no AND #status=:old AND listingSelectionCount=:zero",
                    ExpressionAttributeNames: { "#status": "status" },
                    ExpressionAttributeValues: {
                      ":yes": true,
                      ":no": false,
                      ":zero": 0,
                      ":deleted": "DELETED",
                      ":old": asset.status,
                      ":now": now.toISOString(),
                    },
                  },
                },
                {
                  Update: {
                    TableName: photoTable,
                    Key: { PK: batch.PK, SK: batch.SK },
                    UpdateExpression:
                      "SET expectedAssetCount=expectedAssetCount-:one, registeredAssetCount=registeredAssetCount-:one, completedAssetCount=completedAssetCount-:complete, failedAssetCount=failedAssetCount-:failed",
                    ConditionExpression:
                      "inventoryId=:owner AND #status=:linked AND attribute_not_exists(openRevisionRevision) AND expectedAssetCount>=:one AND registeredAssetCount>=:one AND completedAssetCount>=:complete AND failedAssetCount>=:failed",
                    ExpressionAttributeNames: { "#status": "status" },
                    ExpressionAttributeValues: {
                      ":owner": batch.inventoryId,
                      ":linked": "LINKED",
                      ":one": 1,
                      ":complete": asset.status === "READY" ? 1 : 0,
                      ":failed": asset.status === "FAILED" ? 1 : 0,
                    },
                  },
                },
              ],
            }),
          );
          result.marked++;
        } catch (e) {
          const reasons = (e as { CancellationReasons?: { Code?: string }[] })
            .CancellationReasons;
          if (
            e instanceof Error &&
            e.name === "TransactionCanceledException" &&
            reasons?.some((r) => r.Code === "ConditionalCheckFailed") &&
            reasons.every(
              (r) =>
                !r.Code ||
                r.Code === "None" ||
                r.Code === "ConditionalCheckFailed",
            )
          ) {
            result.protected++;
            continue;
          }
          result.failures.push(String(asset.id));
        }
      }
    } while (assetCursor);
  }
  return result;
}
