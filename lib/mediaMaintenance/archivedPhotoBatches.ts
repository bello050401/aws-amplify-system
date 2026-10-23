import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

/** Archive is a durable deletion request, not just a hidden list entry.
 * Each claim checks the parent and reference count in the same transaction.
 * A crash is safe: the daily worker resumes remaining assets. */
export async function markArchivedPhotoBatchAssets(db: DynamoDBDocumentClient, table: string, batchId: string, now = new Date()) {
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) throw Error("Invalid batch id");
  const batchKey = { PK: `BATCH#${batchId}`, SK: `BATCH#${batchId}` };
  const { Item: batch } = await db.send(new GetCommand({ TableName: table, Key: batchKey, ConsistentRead: true }));
  const result = { marked: 0, protected: 0, failures: [] as string[] };
  if (!batch || batch.status !== "ARCHIVED" || batch.inventoryId || batch.openRevisionRevision != null) return result;
  const deletedAt = typeof batch.deletedAt === "string" && Number.isFinite(Date.parse(batch.deletedAt))
    ? batch.deletedAt : now.toISOString();
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await db.send(new QueryCommand({ TableName: table, ConsistentRead: true,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": batchKey.PK, ":prefix": "ASSET#" }, ExclusiveStartKey: cursor }));
    cursor = page.LastEvaluatedKey;
    for (const asset of page.Items ?? []) {
      if (asset.isDeleted) continue;
      if (asset.listingSelectionCount !== 0 || !["READY", "UPLOADING", "FAILED", "FLAGGED"].includes(asset.status)) { result.protected++; continue; }
      try {
        await db.send(new TransactWriteCommand({ TransactItems: [
          { ConditionCheck: { TableName: table, Key: batchKey,
            ConditionExpression: "#status = :archived AND attribute_not_exists(inventoryId) AND attribute_not_exists(openRevisionRevision)",
            ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":archived": "ARCHIVED" } } },
          { Update: { TableName: table, Key: { PK: asset.PK, SK: asset.SK },
            UpdateExpression: "SET isDeleted = :yes, #status = :deleted, statusBeforeDelete = :old, deletedAt = :at, purgeStartedAt = :at",
            ConditionExpression: "isDeleted = :no AND #status = :old AND listingSelectionCount = :zero",
            ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: {
              ":yes": true, ":no": false, ":zero": 0, ":deleted": "DELETED", ":old": asset.status, ":at": deletedAt } } },
        ] }));
        result.marked++;
      } catch (error) {
        // Preserve conflicts for investigation; never delete a referenced asset.
        result.failures.push(String(asset.id));
      }
    }
  } while (cursor);
  return result;
}

export async function markArchivedPhotoBatches(db: DynamoDBDocumentClient, table: string, now = new Date()) {
  let cursor: Record<string, unknown> | undefined;
  const total = { marked: 0, protected: 0, failures: [] as string[] };
  do {
    const page = await db.send(new ScanCommand({ TableName: table, ConsistentRead: true,
      FilterExpression: "entityType = :batch AND #status = :archived", ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":batch": "PhotoBatch", ":archived": "ARCHIVED" }, ExclusiveStartKey: cursor }));
    cursor = page.LastEvaluatedKey;
    for (const batch of page.Items ?? []) {
      const result = await markArchivedPhotoBatchAssets(db, table, String(batch.id), now);
      total.marked += result.marked; total.protected += result.protected; total.failures.push(...result.failures);
    }
  } while (cursor);
  return total;
}
