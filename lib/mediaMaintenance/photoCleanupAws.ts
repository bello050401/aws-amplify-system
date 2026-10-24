import {deleteAllPhotoObjectVersions} from "./deletePhotoObject";
import {originalObjectKey} from "../photoRegistration/originalRetention";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
} from "@aws-sdk/client-s3";
import {
  photoAssetS3Key,
  extensionForMimeType,
} from "../photoRegistration/types";
import { purgeDeletedPhotos, type DeletedPhoto } from "./photoCleanup";

export async function cleanupPhotoAssets(
  db: DynamoDBDocumentClient,
  s3: S3Client,
  table: string,
  bucket: string,
  now = Date.now(),
  onlyBatchIds?: ReadonlySet<string>,
  onlyAssetIds?: ReadonlySet<string>,
) {
  const key = (p: DeletedPhoto) => ({ PK: p.PK, SK: p.SK });
  const condition =
    "isDeleted = :yes AND #status = :deleted AND listingSelectionCount = :zero";
  const names = { "#status": "status" },
    values = { ":yes": true, ":deleted": "DELETED", ":zero": 0 };
  return purgeDeletedPhotos(
    {
      listDeleted: async () => {
        if (onlyBatchIds) {
          const rows: DeletedPhoto[] = [];
          for (const id of onlyBatchIds) {
            if (!/^[0-9a-f-]{36}$/i.test(id)) throw Error("Invalid batch id");
            let after: Record<string, unknown> | undefined;
            do {
              const page = await db.send(new QueryCommand({ TableName: table, ConsistentRead: true,
                KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
                ExpressionAttributeValues: { ":pk": `BATCH#${id}`, ":prefix": "ASSET#" }, ExclusiveStartKey: after }));
              rows.push(...((page.Items as DeletedPhoto[]) ?? []).filter(p => p.isDeleted));
              after = page.LastEvaluatedKey;
            } while (after);
          }
          return onlyAssetIds ? rows.filter(p => onlyAssetIds.has(p.id)) : rows;
        }
        let after: Record<string, unknown> | undefined;
        const rows: DeletedPhoto[] = [];
        do {
          const page = await db.send(
            new ScanCommand({
              TableName: table,
              ConsistentRead: true,
              FilterExpression: "entityType = :type AND isDeleted = :yes",
              ExpressionAttributeValues: {
                ":type": "PhotoAsset",
                ":yes": true,
              },
              ExclusiveStartKey: after,
            }),
          );
          rows.push(...((page.Items as DeletedPhoto[]) || []));
          after = page.LastEvaluatedKey;
        } while (after);
        return rows;
      },
      markDeletionObserved: async (p, at) => {
        try {
          await db.send(
            new UpdateCommand({
              TableName: table,
              Key: key(p),
              UpdateExpression: "SET deletedAt = :at",
              ConditionExpression:
                condition + " AND attribute_not_exists(deletedAt)",
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: { ...values, ":at": at },
            }),
          );
        } catch (e) {
          if (!(
            e instanceof Error && e.name === "ConditionalCheckFailedException"
          ))
            throw e;
        }
      },
      claim: async (p, at) => {
        try {
          await db.send(
            new UpdateCommand({
              TableName: table,
              Key: key(p),
              UpdateExpression:
                "SET purgeStartedAt = if_not_exists(purgeStartedAt, :at)",
              ConditionExpression:
                condition +
                " AND deletedAt = :previous AND attribute_not_exists(purgeRecheckedAt)",
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: {
                ...values,
                ":at": at,
                ":previous": p.deletedAt,
              },
            }),
          );
          return true;
        } catch (e) {
          if (
            e instanceof Error &&
            e.name === "ConditionalCheckFailedException"
          )
            return false;
          throw e;
        }
      },
      removeAllVersions: async (p) => {
        if (
          !/^[0-9a-f-]{36}$/i.test(p.photoBatchId) ||
          !p.id.startsWith(p.photoBatchId + "#A#") ||
          p.id.includes("/")
        )
          throw Error("Invalid photo key");
        for (const [variant, mime] of [
          ["PROCESSED", p.declaredProcessedMimeType],
          ["THUMBNAIL", p.declaredThumbnailMimeType],
        ] as const) {
          const exact = photoAssetS3Key(
            p.photoBatchId,
            p.id,
            variant,
            extensionForMimeType(mime),
          );
          await deleteAllPhotoObjectVersions(s3,bucket,exact);
        }
        await deleteAllPhotoObjectVersions(s3,bucket,originalObjectKey(p.photoBatchId,p.id));
      },
      finish: async (p, at) => {
        await db.send(
          new UpdateCommand({
            TableName: table,
            Key: key(p),
            UpdateExpression: "SET purgedAt = if_not_exists(purgedAt, :at)" + (Date.parse(at) >= Date.parse(p.deletedAt!) + 16*60*1000 ? ", purgeRecheckedAt = :at" : ""),
            ConditionExpression:
              condition +
              " AND deletedAt = :previous AND attribute_exists(purgeStartedAt)",
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: {
              ...values,
              ":at": at,
              ":previous": p.deletedAt,
            },
          }),
        );
      },
    },
    now,
  );
}
