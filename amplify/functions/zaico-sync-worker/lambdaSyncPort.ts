import {createInventoryPersistence} from '@/lib/inventory/categoryPersistenceCore';
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand, ScanCommand, GetCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { randomUUID, createHash } from "node:crypto";
import sharp from "sharp";
import type { ZaicoSyncPort, InventoryModel, NewInventoryInput, UpdateInventoryInput, ClaimSourceLinkResult } from "@/lib/inventory/zaicoSyncPorts";
import { normalizeMasterName, buildZaicoSourceLinkId } from "@/lib/inventory/zaicoSyncEngine";
import { InventorySaveError } from "@/lib/inventory/conditionalUpdate";

/**
 * BELLO統合業務OS 第五ラウンド §4(P0-A): `ZaicoSyncPort`の
 * Lambda-native実装。生DynamoDB/S3/Secrets Manager/Lambda呼び出しのみ
 * ——AppSync/GraphQL/Cognitoセッションを一切経由しない
 * (amplify/functions/pricing-scheduler/handler.tsと同じ設計)。
 *
 * 【このラウンドで実測・確認した安全性の根拠】`lib/inventory/
 * zaicoSyncPorts.ts`の元コメントは「InventoryはGSI付きのリッチな
 * modelなので、生DynamoDB Itemを検証無しで手書きするのはリスクが
 * ある」としてLambda化を見送っていた。今回、synth-checkが生成する
 * 実CloudFormation(`Custom::AmplifyDynamoDBTable`)を実際にdumpして
 * 確認した結果、Inventoryの5つのGSI(sku/categoryId/statusId/
 * locationId/deletedAt)は全て「素のトップレベル属性をHASHキーとする
 * 単純GSI」であり(ChannelListing等で既に確認済みだったのと同じ構造)、
 * computed/hashed属性は一切無いことが判明した——UPDATE
 * (対象属性だけを明示するUpdateExpression)は完全に安全であることが
 * 確定した。
 *
 * 【残るリスク、正直に】CREATE(新規ZAICO商品)については、Amplify
 * Data(非DataStore、conflictResolution未設定——amplify/data/
 * resource.tsのdefineData呼び出しを確認済み、`_version`等の内部
 * bookkeeping属性は不要と判断できる)がAppSync解決層でItem形状に
 * 依存しない`__typename`合成を行うという一般的なAppSync/DynamoDB
 * 統合の仕組みを根拠にCREATEも実装するが、実際に生成したItemを
 * 本物のAppSync GraphQL経由で読み戻して確認する手段がこのサンドボ
 * ックスには無い(実AWS未接続)。したがって、CREATE経路は
 * LOCAL_IMPLEMENTEDまでとし、AWS_VERIFIEDは実stagingでの実同期実行
 * ・一覧画面での表示確認まで到達して初めて宣言する——完了報告に
 * この区別を明記する。
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({});
const lambdaClient = new LambdaClient({});

const INVENTORY_TABLE = process.env.INVENTORY_TABLE_NAME!;
const CATEGORY_TABLE = process.env.CATEGORY_TABLE_NAME!;
const LOCATION_TABLE = process.env.LOCATION_TABLE_NAME!;
const INVENTORY_HISTORY_TABLE = process.env.INVENTORY_HISTORY_TABLE_NAME!;
const ZAICO_SOURCE_LINK_TABLE = process.env.ZAICO_SOURCE_LINK_TABLE_NAME!;
const STORAGE_BUCKET = process.env.STORAGE_BUCKET_NAME!;
const GENERATE_SKU_FUNCTION_NAME = process.env.GENERATE_SKU_FUNCTION_NAME!;

const THUMBNAIL_MAX_DIMENSION = 320; // lib/inventory/thumbnail.tsと同じ値(server-only境界のため複製 — sharpProcessor.tsと同じ理由)
const THUMBNAIL_JPEG_QUALITY = 72;

async function findExistingBySourceId(sourceInventoryId: string): Promise<InventoryModel | null> {
  // 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §11.3/§11.4: この
  // 関数の以前の実装は`ScanCommand`を`ExclusiveStartKey`ループ無しで
  // 一度だけ呼んでいた——「Lambda側はfetchAllZaicoManaged prefetchを
  // 必ず使う前提なので単発同期以外では呼ばれない」という前提コメントが
  // あったが、前提が崩れた場合(将来の呼び出し追加、または前提自体の
  // 誤り)に備え、Next.js側(lib/inventory/zaicoSyncPorts.ts)と全く同じ
  // 根治を行う: ZaicoSourceLinkの主キー直接get(スキャン不要)を一次
  // 手段とし、リンクが無い既存レコード向けのフォールバックとして
  // 必ずExclusiveStartKeyをループする完全スキャンを残す。
  const linkId = buildZaicoSourceLinkId("ZAICO", sourceInventoryId);
  const linkRes = await ddb.send(new GetCommand({ TableName: ZAICO_SOURCE_LINK_TABLE, Key: { id: linkId } }));
  const link = linkRes.Item as { inventoryId?: string } | undefined;
  if (link?.inventoryId) {
    const invRes = await ddb.send(new GetCommand({ TableName: INVENTORY_TABLE, Key: { id: link.inventoryId } }));
    const inv = invRes.Item as InventoryModel | undefined;
    if (inv && !inv.deletedAt) return inv;
    // リンクは存在するが参照先が壊れている — 安全側のフォールバックスキャンへ進む。
  }
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: INVENTORY_TABLE,
        FilterExpression: "sourceSystem = :z AND sourceInventoryId = :sid",
        ExpressionAttributeValues: { ":z": "ZAICO", ":sid": sourceInventoryId },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );
    const items = (res.Items ?? []) as InventoryModel[];
    const hit = items.find((i) => !i.deletedAt);
    if (hit) return hit;
    lastEvaluatedKey = res.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return null;
}

/**
 * 不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §11.7: DB層での
 * 原子的な新規sourceInventoryId確保。`lib/inventory/zaicoSyncPorts.ts`の
 * `createServerSyncPort`版と全く同じ意味論(idが既に存在すれば失敗)を、
 * 生DynamoDBの`ConditionExpression: "attribute_not_exists(id)"`付き
 * `PutCommand`で実現する——AWS SDKが公式に文書化している標準的な
 * 条件付き書き込みの失敗は`ConditionalCheckFailedException`という
 * 決まった名前の例外になるため、エラーメッセージの文字列一致に頼る
 * 必要がない。
 */
async function claimSourceLink(sourceInventoryId: string, inventoryId: string): Promise<ClaimSourceLinkResult> {
  const id = buildZaicoSourceLinkId("ZAICO", sourceInventoryId);
  try {
    await ddb.send(
      new PutCommand({
        TableName: ZAICO_SOURCE_LINK_TABLE,
        Item: { id, sourceSystem: "ZAICO", sourceInventoryId, inventoryId, createdAt: new Date().toISOString() },
        ConditionExpression: "attribute_not_exists(id)",
      }),
    );
    return { claimed: true };
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") {
      const res = await ddb.send(new GetCommand({ TableName: ZAICO_SOURCE_LINK_TABLE, Key: { id } }));
      const existingLink = res.Item as { inventoryId?: string } | undefined;
      if (existingLink?.inventoryId) return { claimed: false, existingInventoryId: existingLink.inventoryId };
    }
    throw err;
  }
}

async function releaseSourceLink(sourceInventoryId: string): Promise<void> {
  const id = buildZaicoSourceLinkId("ZAICO", sourceInventoryId);
  await ddb.send(new DeleteCommand({ TableName: ZAICO_SOURCE_LINK_TABLE, Key: { id } }));
}

async function fetchAllZaicoManaged(): Promise<Map<string, InventoryModel>> {
  const map = new Map<string, InventoryModel>();
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: INVENTORY_TABLE, FilterExpression: "sourceSystem = :z", ExpressionAttributeValues: { ":z": "ZAICO" }, ExclusiveStartKey: lastEvaluatedKey }));
    for (const item of (res.Items ?? []) as (InventoryModel & { sourceInventoryId?: string })[]) {
      if (item.deletedAt || !item.sourceInventoryId) continue;
      map.set(item.sourceInventoryId, item as InventoryModel);
    }
    lastEvaluatedKey = res.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return map;
}

async function findOrCreateMasterEntry(table: string, name: string): Promise<{ id: string; created: boolean }> {
  const trimmed = name.trim();
  const normalized = normalizeMasterName(trimmed);
  const res = await ddb.send(new ScanCommand({ TableName: table }));
  const existing = (res.Items ?? []) as { id: string; name: string; sortOrder?: number }[];
  const match = existing.find((e) => normalizeMasterName(e.name) === normalized);
  if (match) return { id: match.id, created: false };

  const nextSortOrder = existing.length === 0 ? 0 : Math.max(...existing.map((e) => e.sortOrder ?? 0)) + 1;
  const id = randomUUID();
  const now = new Date().toISOString();
  await ddb.send(new PutCommand({ TableName: table, Item: { id, name: trimmed, sortOrder: nextSortOrder, isActive: true, createdAt: now, updatedAt: now } }));
  return { id, created: true };
}

async function generateSku(): Promise<string> {
  const res = await lambdaClient.send(new InvokeCommand({ FunctionName: GENERATE_SKU_FUNCTION_NAME, InvocationType: "RequestResponse", Payload: Buffer.from("{}") }));
  if (res.FunctionError) throw new Error(`SKUの発番に失敗しました(generate-sku Lambda): ${res.FunctionError}`);
  const payload = res.Payload ? Buffer.from(res.Payload).toString("utf-8") : "";
  const sku = JSON.parse(payload) as string; // Lambda runtimeはhandlerの戻り値をJSON.stringifyして返す(文字列なら`"B000001"`のようなJSON文字列)
  if (typeof sku !== "string" || !sku) throw new Error("generate-sku Lambdaから不正な応答を受け取りました。");
  return sku;
}

// Keep categories, barcode claims and the inventory row in one transaction.
const persistence = createInventoryPersistence(ddb, model => {
  if (!INVENTORY_TABLE.startsWith('Inventory-')) throw new Error('Inventory table is not configured');
  return model + INVENTORY_TABLE.slice('Inventory'.length);
});
async function createInventory(input: NewInventoryInput): Promise<InventoryModel> {
  const {extendedFields, ...fields}=input;
  const saved=await persistence.persistInventoryWithCategories({...fields,...extendedFields,listingPartition:'ACTIVE',listUpdatedAt:new Date().toISOString()});
  return await persistence.getInventoryRaw(saved.id) as InventoryModel;
}
async function updateInventory(input: UpdateInventoryInput): Promise<void> {
  if (!input.expectedUpdatedAt) throw new InventorySaveError('CONFLICT');
  const {expectedUpdatedAt,extendedFields,...fields}=input;
  await persistence.persistInventoryWithCategories({...fields,...extendedFields,listUpdatedAt:new Date().toISOString()},expectedUpdatedAt);
}

async function logHistory(inventoryId: string, changedBy: string | null, changes: { fieldName: string; oldValue: string | null; newValue: string | null }[]): Promise<void> {
  const changedAt = new Date().toISOString();
  await Promise.allSettled(
    changes.map((c) => {
      const item: Record<string, unknown> = { id: randomUUID(), inventoryId, changedAt, fieldName: c.fieldName, createdAt: changedAt, updatedAt: changedAt };
      if (changedBy != null) item.changedBy = changedBy;
      if (c.oldValue != null) item.oldValue = c.oldValue;
      if (c.newValue != null) item.newValue = c.newValue;
      return ddb.send(new PutCommand({ TableName: INVENTORY_HISTORY_TABLE, Item: item }));
    }),
  );
}

async function downloadAndImportImage(url: string): Promise<{ storageKey: string; thumbnailKey: string | null; originalHash: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ZAICOの画像の取得に失敗しました(HTTP ${res.status}): ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const ext = (() => {
    const m = /\.([a-zA-Z0-9]{2,4})(?:\?|$)/.exec(url);
    return m ? `.${m[1].toLowerCase()}` : ".jpg";
  })();
  const storageKey = `inventory/${randomUUID()}${ext}`;
  await s3.send(new PutObjectCommand({ Bucket: STORAGE_BUCKET, Key: storageKey, Body: bytes, CacheControl: "public, max-age=31536000, immutable" }));

  let thumbnailKey: string | null = null;
  try {
    const thumbBuffer = await sharp(bytes)
      .rotate()
      .resize({ width: THUMBNAIL_MAX_DIMENSION, height: THUMBNAIL_MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: THUMBNAIL_JPEG_QUALITY })
      .toBuffer();
    thumbnailKey = `inventory/thumbnails/${randomUUID()}.jpg`;
    await s3.send(new PutObjectCommand({ Bucket: STORAGE_BUCKET, Key: thumbnailKey, Body: thumbBuffer, ContentType: "image/jpeg", CacheControl: "public, max-age=31536000, immutable" }));
  } catch (err) {
    console.error("[zaico-sync-worker] thumbnail generation failed (non-fatal, original still saved):", err);
    thumbnailKey = null;
  }

  const originalHash = createHash("sha256").update(bytes).digest("hex");
  return { storageKey, thumbnailKey, originalHash };
}

async function removeImage(path: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: STORAGE_BUCKET, Key: path }));
  } catch (err) {
    console.error(`[zaico-sync-worker] failed to delete "${path}" (non-fatal):`, err);
  }
}

export function createLambdaSyncPort(): ZaicoSyncPort {
  return {
    findExistingBySourceId,
    fetchAllZaicoManaged,
    findOrCreateCategory: (name) => findOrCreateMasterEntry(CATEGORY_TABLE, name),
    findOrCreateLocation: (name) => findOrCreateMasterEntry(LOCATION_TABLE, name),
    generateSku,
    createInventory,
    updateInventory,
    logHistory,
    downloadAndImportImage,
    removeImage,
    claimSourceLink,
    releaseSourceLink,
  };
}

/** handler.tsのmissing判定sweepが使う——findMissingZaicoManagedInventoryのLambda版。 */
export async function findMissingZaicoManagedInventory(seenSourceIds: Set<string>): Promise<string[]> {
  const missing: string[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: INVENTORY_TABLE, FilterExpression: "sourceSystem = :z", ExpressionAttributeValues: { ":z": "ZAICO" }, ExclusiveStartKey: lastEvaluatedKey }));
    for (const item of (res.Items ?? []) as (InventoryModel & { sourceInventoryId?: string })[]) {
      if (item.deletedAt || !item.sourceInventoryId) continue;
      if (!seenSourceIds.has(item.sourceInventoryId)) missing.push(item.sourceInventoryId);
    }
    lastEvaluatedKey = res.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return missing;
}

export { ddb, INVENTORY_TABLE };
