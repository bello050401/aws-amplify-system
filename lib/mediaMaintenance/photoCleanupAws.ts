import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
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
) {
  const key = (p: DeletedPhoto) => ({ PK: p.PK, SK: p.SK });
  const condition =
    "isDeleted = :yes AND #status = :deleted AND listingSelectionCount = :zero";
  const names = { "#status": "status" },
    values = { ":yes": true, ":deleted": "DELETED", ":zero": 0 };
  return purgeDeletedPhotos(
    {
      listDeleted: async () => {
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
                " AND deletedAt = :previous AND attribute_not_exists(purgedAt)",
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
          let keyMarker: string | undefined, versionMarker: string | undefined;
          do {
            const page = await s3.send(
              new ListObjectVersionsCommand({
                Bucket: bucket,
                Prefix: exact,
                KeyMarker: keyMarker,
                VersionIdMarker: versionMarker,
              }),
            );
            for (const object of [
              ...(page.Versions || []),
              ...(page.DeleteMarkers || []),
            ])
              if (object.Key === exact)
                await s3.send(
                  new DeleteObjectCommand({
                    Bucket: bucket,
                    Key: exact,
                    VersionId: object.VersionId,
                  }),
                );
            keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
            versionMarker = page.IsTruncated
              ? page.NextVersionIdMarker
              : undefined;
          } while (keyMarker);
        }
      },
      finish: async (p, at) => {
        await db.send(
          new UpdateCommand({
            TableName: table,
            Key: key(p),
            UpdateExpression: "SET purgedAt = :at",
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
