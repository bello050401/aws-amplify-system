import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { SharpImageProcessingProvider, ENGINE_VERSION } from "../../../lib/imageProcessing/sharpProcessor";
import { BedrockVisionAnalyzer } from "../../../lib/imageProcessing/vision/bedrockVisionAnalyzer";
import { BudgetedVisionAnalyzer } from "../../../lib/imageProcessing/vision/budgetedAnalyzer";
import type { VisionAnalysisResult } from "../../../lib/imageProcessing/vision/types";
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

/**
 * AI Vision(難例だけの意味解析フォールバック)の有効化。
 *
 * ## 既定で無効にしてある理由
 *
 * AIを足すこと自体は品質改善ではない(§56)。実際、提示された参照写真4枚は
 * 露出補正を被写体検出の前へ動かした時点でローカル解析だけで解決しており、
 * AIは1枚も呼ばれない。環境変数で明示的に有効化したときだけ使う。
 *
 * ## 予算を必ず通す理由
 *
 * このLambdaのtimeoutは300秒で、1回の起動で最大${MAX_JOBS_PER_RUN}件を処理する。
 * Vision解析は1件あたり最大20秒×2回試行=40秒かかり得るため、難例が続くと
 * 20件×40秒=800秒となり**Lambdaごとtimeoutして加工結果が1件も残らない**。
 * AIを入れたせいで従来動いていた処理を壊すことになる。BudgetedVisionAnalyzerで
 * 「1起動あたり何件・何秒まで」を先に決め、使い切ったら静かにローカルへ戻す。
 *
 * ## キャッシュ
 *
 * モジュールスコープのMapをwarm containerで共有する。同じ画像を再加工した
 * ときに二重で課金しないため(§35)。プロセスが再利用される間だけ生きる
 * 揮発キャッシュで、正しさには影響しない(外れてもAPIを呼び直すだけ)。
 */
const VISION_ENABLED = process.env.BELLO_VISION_ENABLED === "true";
const VISION_MAX_CALLS_PER_RUN = Number(process.env.BELLO_VISION_MAX_CALLS_PER_RUN ?? "3");
const VISION_MAX_MS_PER_RUN = Number(process.env.BELLO_VISION_MAX_MS_PER_RUN ?? "90000");

const visionCache = new Map<string, VisionAnalysisResult>();

/**
 * 予算は1起動ごとに使い切る形にしたいので、解析器はhandlerの中で作る
 * (モジュールスコープで作ると、warm containerで予算が復活しないまま
 *  2回目以降の起動がAIを一切使えなくなる)。キャッシュだけは共有する。
 */
function createVisionAnalyzer(): BudgetedVisionAnalyzer | undefined {
  if (!VISION_ENABLED) return undefined;
  return new BudgetedVisionAnalyzer(
    new BedrockVisionAnalyzer({
      modelId: process.env.BELLO_VISION_MODEL_ID,       // 未設定なら us.amazon.nova-lite-v1:0
      region: process.env.BELLO_VISION_REGION,           // 未設定なら BEDROCK_REGION → AWS_REGION → us-west-2
      cache: visionCache,
    }),
    { maxCalls: VISION_MAX_CALLS_PER_RUN, maxTotalMs: VISION_MAX_MS_PER_RUN },
  );
}

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

/**
 * 第五ラウンド§8(P1-C、ZaicoSyncJobとのBackground Job基盤比較で発覚):
 * PENDING→PROCESSINGへの遷移が無条件UpdateItemだったため、5分毎の
 * スケジュール実行が(前回の実行が処理件数超過で長引く等の理由で)
 * 重なった場合、2つのLambda実行が同じPENDING行を両方Scanで拾い、
 * 両方が同じ画像を二重に加工しうる——ZaicoSyncJobのlease機構
 * (amplify/functions/zaico-sync-worker/handler.tsのclaimOrRenewLease)
 * とは異なる形だが、目的は同じ「同じ作業単位を複数の実行主体が同時に
 * 処理しない」という保証。ProcessingJobは1行=1画像の独立した作業単位
 * なので、ZaicoSyncJobのような有効期限付きleaseではなく、
 * 「PENDINGのままである」ことをConditionExpressionで確認してから
 * PROCESSINGへ書き換える、より単純なcompare-and-swapで十分
 * (amplify/functions/generate-skuの採番と同じ「1回限りの遷移」パターン)。
 * 条件が満たせなければ(既に他の実行がPROCESSING以降へ進めていた場合)
 * ConditionalCheckFailedExceptionを捕まえ、二重処理せずスキップする。
 */
async function claimJob(job: ProcessingJobRow): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: PROCESSING_JOB_TABLE,
        Key: { id: job.id },
        UpdateExpression: "SET #s = :processing, startedAt = :now, attemptCount = :attempt",
        ConditionExpression: "#s = :pending",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":processing": "PROCESSING",
          ":pending": "PENDING",
          ":now": new Date().toISOString(),
          ":attempt": (job.attemptCount ?? 0) + 1,
        },
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

async function processOne(job: ProcessingJobRow, provider: SharpImageProcessingProvider): Promise<void> {
  const claimed = await claimJob(job);
  if (!claimed) {
    console.log(`[image-processing-worker] job=${job.id} already claimed by another invocation — skipping (no double-processing).`);
    return;
  }

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

    // AIを使ったか、使えたか、何を避けたかを残す(§49 観測)。
    // これが無いと「有効化したつもりで実は一度も呼ばれていない」に気付けない。
    const v = result.diagnostics.vision;
    if (v.requested) {
    console.log(
      `[image-processing-worker] vision: requested=${v.requested} trigger=${v.trigger ?? "-"} applied=${v.applied} model=${v.modelId ?? "-"} latency=${v.latencyMs ?? "-"}ms avoid=${v.avoidRegions.length}`,
    );
    }

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

  // 予算は1起動ぶん。warm containerでも起動ごとに作り直す。
  const analyzer = createVisionAnalyzer();
  const provider = new SharpImageProcessingProvider(analyzer ? { visionAnalyzer: analyzer } : {});

  console.log(
    `[image-processing-worker] ${jobs.length} pending job(s) (max ${MAX_JOBS_PER_RUN}/run); vision=${
      analyzer ? `enabled(${VISION_MAX_CALLS_PER_RUN} calls / ${VISION_MAX_MS_PER_RUN}ms per run)` : "disabled"
    }.`,
  );

  for (const job of jobs) {
    await processOne(job, provider).catch((err) => console.error(`[image-processing-worker] job=${job.id} unhandled error:`, err));
  }

  if (analyzer) {
    const spent = analyzer.state;
    console.log(
      `[image-processing-worker] vision budget: ${spent.calls} call(s) / ${Math.round(spent.elapsedMs)}ms${spent.exhausted ? " (exhausted — remaining jobs used local analysis only)" : ""}`,
    );
  }
  return { processedCount: jobs.length };
};
