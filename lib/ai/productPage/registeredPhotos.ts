import "server-only";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { isDirectDataMode } from "@/lib/amplify/dataClient";
import { DynamoPhotoRegistrationRepository } from "@/lib/photoRegistration/awsRepository";
import {
  extensionForMimeType,
  photoAssetS3Key,
} from "@/lib/photoRegistration/types";
import {
  getPhotoRegistrationWebAdapter,
  getWebTrustedClaims,
} from "@/lib/photoRegistration/webAdapter";

/** Web calls retain Cognito authorization; explicitly scoped background jobs use their AWS IAM identity. */
export async function registeredIntroductionPhotos(inventoryId: string) {
  if (!isDirectDataMode()) {
    const adapter = getPhotoRegistrationWebAdapter();
    const claims = adapter ? await getWebTrustedClaims() : null;
    if (!adapter || !claims) return [];
    const result = await adapter.listInventoryPhotoAssets(inventoryId, claims);
    return result.ok ? result.value.assets : [];
  }
  const tableName = process.env.PHOTO_REGISTRATION_TABLE_NAME;
  const inventoryTableName =
    process.env.PHOTO_REGISTRATION_INVENTORY_TABLE_NAME;
  const bucketName = process.env.PHOTO_REGISTRATION_BUCKET_NAME;
  if (!tableName || !inventoryTableName || !bucketName) return [];
  const region = process.env.PHOTO_REGISTRATION_AWS_REGION || "us-west-2";
  const dynamo = new DynamoDBClient({ region });
  const s3 = new S3Client({ region });
  try {
    const repository = new DynamoPhotoRegistrationRepository({
      ddb: DynamoDBDocumentClient.from(dynamo),
      tableName,
      inventoryTableName,
      now: () => new Date(),
    });
    const inventory = await repository.lookupInventory(inventoryId);
    if (!inventory.exists || inventory.isDeleted) return [];
    const assets = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await repository.listBatchesForInventory(
        inventoryId,
        100,
        cursor,
      );
      for (const batch of page.items) {
        // Re-read the base row because the index may lag a relink/archive.
        const current = await repository.getBatchById(batch.id);
        if (current?.inventoryId !== inventoryId || current.status !== "LINKED")
          continue;
        assets.push(...(await repository.getAssetsForBatch(batch.id)));
      }
      cursor = page.nextCursor;
      if (++pages >= 3 && cursor)
        throw new Error("商品写真が多すぎるため確認が必要です。");
    } while (cursor);
    return await Promise.all(
      assets
        .filter((a) => !a.isDeleted && a.status === "READY")
        .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))
        .map(async (a) => ({
          ...a,
          thumbnailUrl: null,
          processedUrl: await getSignedUrl(
            s3,
            new GetObjectCommand({
              Bucket: bucketName,
              Key: photoAssetS3Key(
                a.photoBatchId,
                a.id,
                "PROCESSED",
                extensionForMimeType(a.declared.PROCESSED.mimeType),
              ),
            }),
            { expiresIn: 300 },
          ),
        })),
    );
  } finally {
    dynamo.destroy();
    s3.destroy();
  }
}
