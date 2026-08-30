import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { SharpImageProcessingProvider, ENGINE_VERSION } from "../../../lib/imageProcessing/sharpProcessor";
import { decideAspectRatio, decideResultStatus, DEFAULT_CONFIDENCE_THRESHOLD } from "../../../lib/imageProcessing/pipeline";
import type { ImageClassificationName } from "../../../lib/inventory/imageTypes";

/**
 * BELLO画像自動加工システム §14: ProcessingJobキューを処理する完全
 * 無人Lambda。amplify/functions/pricing-scheduler/handler.tsと同じ
 * 構造(生DynamoDB API直叩き、GSIキー属性に触れないUPDATE限定)を
 * 踏襲しつつ、書き込み先はInventory.images配列ではなく独立行の
 * ImageProcessingVersionへ限定する(amplify/data/resource.tsの
 * InventoryImage customTypeコメント参照——配列の部分更新を避ける
 * 設計判断)。
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const PROCESSING_JOB_TABLE = process.env.PROCESSING_JOB_TABLE_NAME!;
const IMAGE_PROCESSING_VERSION_TABLE = process.env.IMAGE_PROCESSING_VERSION_TABLE_NAME!;
const PHOTO_PROFILE_TABLE = process.env.PHOTO_PROFILE_TABLE_NAME!;
const INVENTORY_TABLE = process.env.INVENTORY_TABLE_NAME!;
const STORAGE_BUCKET = process.env.STORAGE_BUCKET_NAME!;

const provider = new SharpImageProcessingProvider();

// 1回の起動(5分毎)で処理する最大件数。sharp処理+S3 I/Oは商品画像
// 1枚あたり数秒〜十数秒かかり得るため、Lambdaのtimeout(300秒)内に
// 収まる保守的な件数に制限し、余りは次回起動へ回す(handler本体末尾の
// forループ参照)——pricing-schedulerには無い制約(あちらはBASE API
// 呼び出しのみでI/O量が小さいため無制限に全件処理していた)。
const MAX_JOBS_PER_RUN = 20;

interface ProcessingJobRow {
  id: string;
  inventoryId: string;
  imageStorageKey: string;
  triggerType: string;
  idempotencyKey: string;
  status: string;
  attemptCount?: number;
  requestedAdjustments?: Record<string, unknown> | null;
}

interface PhotoProfileRow {
  id: string;
  version: number;
  active?: boolean;
}

async function getBytes(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: STORAGE_BUCKET, Key: key }));
  const chunks: Uint8Array[] = [];
  // @ts-expect-error -- Node runtime's Body is a Readable stream (AsyncIterable), the SDK's browser-oriented type doesn't reflect that
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function putBytes(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: STORAGE_BUCKET, Key: key, Body: body, ContentType: contentType, CacheControl: "public, max-age=31536000, immutable" }));
}

/** ジョブのstatusを更新する——ProcessingJobはGSIを持たない(schema参照)ため、id指定のUpdateItemは常に安全。 */
async function updateJobStatus(id: string, fields: Record<string, unknown>): Promise<void> {
  const sets = Object.keys(fields).map((k, i) => `#${i} = :${i}`);
  const names = Object.fromEntries(Object.keys(fields).map((k, i) => [`#${i}`, k]));
  const values = Object.fromEntries(Object.values(fields).map((v, i) => [`:${i}`, v]));
  await ddb.send(new UpdateCommand({ TableName: PROCESSING_JOB_TABLE, Key: { id }, UpdateExpression: `SET ${sets.join(", ")}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values }));
}

async function getActivePhotoProfile(): Promise<PhotoProfileRow | null> {
  // 想定行数(PhotoProfileはBELLO全体で数件程度)からScanで許容——
  // pricing-schedulerのChannelListing Scanと同じ考え方。
  const res = await ddb.send(new ScanCommand({ TableName: PHOTO_PROFILE_TABLE, FilterExpression: "active = :t", ExpressionAttributeValues: { ":t": true } }));
  return (res.Items?.[0] as PhotoProfileRow | undefined) ?? null;
}

async function nextVersionNumber(imageStorageKey: string): Promise<number> {
  const res = await ddb.send(new ScanCommand({ TableName: IMAGE_PROCESSING_VERSION_TABLE, FilterExpression: "imageStorageKey = :k", ExpressionAttributeValues: { ":k": imageStorageKey } }));
  const versions = (res.Items ?? []).map((i) => (i as { version: number }).version);
  return versions.length > 0 ? Math.max(...versions) + 1 : 1;
}

async function getInventoryClassification(inventoryId: string, imageStorageKey: string): Promise<{ classification: ImageClassificationName; type: string; isPrimary: boolean } | null> {
  const { Item } = await ddb.send(new GetCommand({ TableName: INVENTORY_TABLE, Key: { id: inventoryId } }));
  if (!Item) return null;
  const images = (Item.images ?? []) as { storageKey: string; type?: string; isPrimary?: boolean; classification?: string }[];
  const img = images.find((i) => i.storageKey === imageStorageKey);
  if (!img) return null;
  const type = img.type === "DAMAGE" ? "DAMAGE" : "NORMAL";
  const classification = (img.classification as ImageClassificationName | undefined) ?? (type === "DAMAGE" ? "DAMAGE" : img.isPrimary ? "TOP" : "FULL");
  return { classification, type, isPrimary: Boolean(img.isPrimary) };
}

async function processOne(job: ProcessingJobRow): Promise<void> {
  await updateJobStatus(job.id, { status: "PROCESSING", startedAt: new Date().toISOString(), attemptCount: (job.attemptCount ?? 0) + 1 });

  try {
    const imageInfo = await getInventoryClassification(job.inventoryId, job.imageStorageKey);
    if (!imageInfo) {
      // §11.2: 画像が既に削除された後にジョブだけ残っていたケース。
      // FAILEDではなくDONE扱い(実害が無い、リトライしても解決しない)。
      await updateJobStatus(job.id, { status: "DONE", completedAt: new Date().toISOString(), errorCode: "IMAGE_NOT_FOUND_SKIPPED" });
      return;
    }

    const sourceBuffer = await getBytes(job.imageStorageKey);
    const photoProfile = await getActivePhotoProfile();
    // §6.2: 実測segmentationが無いため常にmeasured=null → decideAspectRatioは安全側のLANDSCAPE_3_2を返す(pipeline.tsのコメント参照)。
    const aspectRatio = decideAspectRatio(null);

    const result = await provider.process({
      sourceBuffer,
      classification: imageInfo.classification,
      aspectRatio,
      adjustments: (job.requestedAdjustments as Record<string, unknown> | undefined) ?? {},
    });

    const masterKey = `inventory/processed/${randomUUID()}.jpg`;
    const webKey = `inventory/processed/${randomUUID()}.webp`;
    const thumbKey = `inventory/thumbnails/${randomUUID()}.jpg`;
    await Promise.all([
      putBytes(masterKey, result.masterJpeg, "image/jpeg"),
      putBytes(webKey, result.webWebp, "image/webp"),
      putBytes(thumbKey, result.thumbnailJpeg, "image/jpeg"),
    ]);

    const status = decideResultStatus({ readBackVerified: result.readBackVerified, compositionConfidence: null, confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD });
    const version = await nextVersionNumber(job.imageStorageKey);

    const versionId = randomUUID();
    await ddb.send(
      new PutCommand({
        TableName: IMAGE_PROCESSING_VERSION_TABLE,
        Item: {
          id: versionId,
          inventoryId: job.inventoryId,
          imageStorageKey: job.imageStorageKey,
          version,
          active: status === "READY", // NEEDS_REVIEWはactiveにしない——採用前のプレビュー扱い(§17「低confidenceを無理にREADYへしない」)
          aspectRatio,
          engineVersion: ENGINE_VERSION,
          photoProfileVersion: photoProfile?.version ?? 0,
          status,
          processedMasterKey: masterKey,
          webKey,
          thumbnailKey: thumbKey,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }),
    );

    if (status === "READY") {
      await supersedeActiveVersionsExcept(job.imageStorageKey, versionId);
    }

    await updateJobStatus(job.id, { status: "DONE", completedAt: new Date().toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[image-processing-worker] job=${job.id} failed:`, err);
    const attemptCount = (job.attemptCount ?? 0) + 1;
    // §14.3 DLQ相当: 3回失敗したジョブはDEAD_LETTERへ落とし、無限リトライしない。RAWは削除しない(このLambdaはRAW自体を扱わない——originalは常にstorageKeyのまま保持される)。
      await updateJobStatus(job.id, {
      status: attemptCount >= 3 ? "DEAD_LETTER" : "FAILED",
      errorMessage: message,
      completedAt: new Date().toISOString(),
    });
  }
}

/** supersedeActiveVersionsの「新versionId以外」版——新しいREADY版を作った直後、それ以外の旧ACTIVEだけを降ろす(自分自身を誤って降ろさない)。 */
async function supersedeActiveVersionsExcept(imageStorageKey: string, exceptId: string): Promise<void> {
  const res = await ddb.send(
    new ScanCommand({
      TableName: IMAGE_PROCESSING_VERSION_TABLE,
      FilterExpression: "imageStorageKey = :k AND active = :t AND id <> :except",
      ExpressionAttributeValues: { ":k": imageStorageKey, ":t": true, ":except": exceptId },
    }),
  );
  for (const item of res.Items ?? []) {
    await ddb.send(new UpdateCommand({ TableName: IMAGE_PROCESSING_VERSION_TABLE, Key: { id: item.id }, UpdateExpression: "SET active = :f, #s = :superseded", ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":f": false, ":superseded": "SUPERSEDED" } }));
  }
}

export const handler = async () => {
  const res = await ddb.send(new ScanCommand({ TableName: PROCESSING_JOB_TABLE, FilterExpression: "#s = :pending", ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":pending": "PENDING" }, Limit: MAX_JOBS_PER_RUN }));
  const jobs = (res.Items ?? []) as ProcessingJobRow[];

  console.log(`[image-processing-worker] ${jobs.length} pending job(s) (max ${MAX_JOBS_PER_RUN}/run).`);
  for (const job of jobs) {
    await processOne(job).catch((err) => console.error(`[image-processing-worker] job=${job.id} unhandled error:`, err));
  }
  return { processedCount: jobs.length };
};
