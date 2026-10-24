import {TemporaryOriginals} from "../../../lib/photoRegistration/temporaryOriginals";
import {cleanupExpiredOriginals} from "../../../lib/mediaMaintenance/originalPhotoCleanup";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  GetBucketVersioningCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import {
  MEDIA_REFERENCE_MODELS,
  liveMediaReferenceRows,
  type StoredImage,
  type OrphanObservation,
} from "../../../lib/mediaMaintenance/core";
import { sweepUnusedImages } from "../../../lib/mediaMaintenance/sweep";
import { cleanupPhotoAssets } from "../../../lib/mediaMaintenance/photoCleanupAws";
import { markArchivedPhotoBatches } from "../../../lib/mediaMaintenance/archivedPhotoBatches";
import { markDeletedInventoryPhotos } from "../../../lib/mediaMaintenance/deletedInventoryPhotos";
import {
  retireExpiredVersions,
  type VersionLifecycleRow,
} from "../../../lib/imageProcessing/versionLifecycle";
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
async function scan(table: string) {
  let key: Record<string, unknown> | undefined;
  const rows: Record<string, unknown>[] = [];
  do {
    const page = await db.send(
      new ScanCommand({
        TableName: table,
        ConsistentRead: true,
        ExclusiveStartKey: key,
      }),
    );
    rows.push(...(page.Items || []));
    key = page.LastEvaluatedKey;
  } while (key);
  return rows;
}
export const handler = async () => {
  const bucket = process.env.MEDIA_BUCKET_NAME,
    table = process.env.MEDIA_OBSERVATION_TABLE_NAME;
  const tableNames: Record<string, string> = JSON.parse(
    process.env.MEDIA_REFERENCE_TABLES || "{}",
  );
  if (
    !bucket ||
    !table ||
    MEDIA_REFERENCE_MODELS.some((model) => !tableNames[model])
  )
    throw Error("Media maintenance configuration incomplete");
  // DeleteObject on versioned buckets would leave chargeable versions behind.
  // Refuse rather than falsely report deletion; Photo Station has its own policy.
  if (
    (await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }))).Status
  )
    throw Error("Inventory bucket versioning requires version-aware cleanup");
  const versionTable = tableNames.ImageProcessingVersion;
  const retired = await retireExpiredVersions(
    db,
    versionTable,
    (await scan(versionTable)) as unknown as VersionLifecycleRow[],
  );
  console.log(JSON.stringify({ kind: "EXPIRED_IMAGE_VERSIONS", retired }));
  const result = await sweepUnusedImages({
    readReferences: async () =>
      liveMediaReferenceRows(
        Object.fromEntries(
          await Promise.all(
            MEDIA_REFERENCE_MODELS.map(async (m) => [
              m,
              await scan(tableNames[m]),
            ]),
          ),
        ),
      ),
    listObjects: async () => {
      let token: string | undefined;
      const rows: StoredImage[] = [];
      do {
        const page = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: "inventory/",
            ContinuationToken: token,
          }),
        );
        for (const o of page.Contents || [])
          if (o.Key && o.ETag && o.LastModified)
            rows.push({
              key: o.Key,
              etag: o.ETag,
              modifiedAt: o.LastModified.toISOString(),
              size: o.Size || 0,
            });
        token = page.NextContinuationToken;
      } while (token);
      return rows;
    },
    listObservations: async () =>
      (await scan(table)) as unknown as OrphanObservation[],
    observe: async (o, old, now) => {
      await db.send(
        new PutCommand({
          TableName: table,
          Item: { id: o.key, etag: o.etag, firstSeenAt: now },
          ConditionExpression: old
            ? "etag = :etag"
            : "attribute_not_exists(id)",
          ExpressionAttributeValues: old ? { ":etag": old.etag } : undefined,
        }),
      );
    },
    forget: async (o) => {
      await db.send(
        new DeleteCommand({
          TableName: table,
          Key: { id: o.id },
          ConditionExpression: "etag = :etag AND firstSeenAt = :first",
          ExpressionAttributeValues: {
            ":etag": o.etag,
            ":first": o.firstSeenAt,
          },
        }),
      );
    },
    remove: async (o) => {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: o.key,
          IfMatch: o.etag,
        }),
      );
    },
  });
  console.log(JSON.stringify({ kind: "MEDIA_MAINTENANCE", ...result }));
  if (result.failures.length)
    throw Error(
      `Image cleanup failed for ${result.failures.length} objects; retained for retry`,
    );
  if (process.env.PHOTO_MEDIA_CLEANUP_ENABLED === "true") {
    const photoTable = process.env.PHOTO_REGISTRATION_TABLE_NAME,
      photoBucket = process.env.PHOTO_REGISTRATION_BUCKET_NAME;
    if (!photoTable || !photoBucket)
      throw Error("Photo cleanup configuration incomplete");
    const historyTable = process.env.MEDIA_INVENTORY_HISTORY_TABLE_NAME;
    if (!historyTable)
      throw Error("Photo cleanup requires inventory deletion history");
    const orphanResult = await markDeletedInventoryPhotos(
      db,
      photoTable,
      tableNames.Inventory,
      historyTable,
    );
    console.log(
      JSON.stringify({ kind: "DELETED_INVENTORY_PHOTOS", ...orphanResult }),
    );
    if (orphanResult.failures.length)
      throw Error("Deleted inventory photo cleanup failed; retry required");
    const temporaryResult=await new TemporaryOriginals({db,s3,table:photoTable,bucket:photoBucket,auth:{photoDeviceGroupDeployed:false}}).cleanup();
    console.log(JSON.stringify({kind:"TEMPORARY_ORIGINALS",...temporaryResult}));
    if(temporaryResult.failures.length)throw Error("Temporary original cleanup failed");
    const originalResult = await cleanupExpiredOriginals(db,s3,photoTable,photoBucket);
    console.log(JSON.stringify({kind:"EXPIRED_ORIGINAL_PHOTOS",...originalResult}));
    if(originalResult.failures.length)throw Error("Original photo expiration failed; retained for retry");
    const archivedResult = await markArchivedPhotoBatches(db, photoTable);
    console.log(JSON.stringify({ kind: "ARCHIVED_PHOTO_BATCHES", ...archivedResult }));
    const photoResult = await cleanupPhotoAssets(
      db,
      s3,
      photoTable,
      photoBucket,
    );
    console.log(
      JSON.stringify({ kind: "PHOTO_MEDIA_MAINTENANCE", ...photoResult }),
    );
    if (photoResult.failures.length || archivedResult.failures.length)
      throw Error("Photo cleanup failed; durable claims retained for retry");
  }
  return result;
};
