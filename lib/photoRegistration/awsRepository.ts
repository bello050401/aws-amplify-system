/**
 * 画像登録基盤 Phase 1 — DynamoDBアダプター (実行可能、未デプロイ)。
 *
 * lib/photoRegistration/ports.ts の PhotoRegistrationRepository を実装する。
 * ここが state.ts の AtomicCondition (説明用の述語) を、実際の
 * ConditionExpression / TransactWriteItems へ翻訳する唯一の場所。
 *
 * 【単一テーブル設計】lib/photoRegistration/keys.ts 参照。テーブル自体は
 * まだAWS上に存在しない (docs/photo-registration-deployment-plan.md)。
 * `DynamoDBDocumentClient` はコンストラクタで注入する — 実運用では
 * amplify/functions/photo-registration/handler.ts が生成して渡し、
 * scripts/verify-photo-registration-api.ts では実際にConditionExpressionを
 * 評価するフェイクclientを注入して試験する (どちらも同じこのクラスを通る)。
 *
 * 【Scan禁止 (§4.5)】このファイルはQueryCommand/GetCommand/
 * TransactWriteCommandのみを使う。ScanCommandは一切importしない。
 *
 * 【TransactWriteItemsの件数】1 chunkは最大25 Asset (MAX_UPLOAD_REQUEST_CHUNK)。
 * 新規Assetは1件につき最大3 item (Asset本体 + clientAssetId冪等ガード +
 * hash冪等ガード) + PhotoBatch更新1件 = 最大 76 item。DynamoDBの
 * TransactWriteItems上限(2024年時点で100 action/トランザクション)以内に
 * 収まる設計であることをここに明記する — 実デプロイ時にAWSの現行上限を
 * 再確認すること (仕様が変わればMAX_UPLOAD_REQUEST_CHUNKも見直す)。
 */

import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import {
  type DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  allocatePhotoAssetId,
  assetClientIdempotencyKey,
  assetHashIdempotencyKey,
  assetKey,
  assetPrefix,
  batchInventoryIndexKey,
  batchKey,
  batchStatusIndexKey,
  listingSelectionRowKey,
  listingSelectionRowPrefix,
  listingSelectionStateKey,
  parseBatchIdFromPhotoAssetId,
  sessionIdempotencyKey,
} from "./keys";
import {
  ConditionViolationError,
  type BatchListPage,
  type InventoryLookup,
  type PhotoRegistrationRepository,
} from "./ports";
import type {
  PhotoAssetSourceType,
  PhotoAssetStatus,
  PhotoAssetView,
  PhotoBatchStatus,
  PhotoBatchView,
} from "./types";
import type {
  CompleteAssetDecision,
  CompletePhotoBatchDecision,
  CreatePhotoBatchDecision,
  DeleteAssetDecision,
  LinkBatchDecision,
  ListingSelectionDecision,
  RequestUploadsDecision,
  RestoreAssetDecision,
} from "./state";

// ─────────────────────────────────────────────────────────────────────────
// item <-> ドメイン型の変換 (manifestはトップレベル属性へ平坦化する。
// ConditionExpressionが `expectedAssetCount = :v` のような単純比較で書ける
// ようにするため — ネストしたmapだと `#m.#exp = :v` のようにExpression
// AttributeNamesの階層が増え、動的組み立てのミスが起きやすくなる)。
// ─────────────────────────────────────────────────────────────────────────

interface BatchItem {
  PK: string;
  SK: string;
  entityType: "PhotoBatch";
  id: string;
  batchCode: string;
  status: PhotoBatchStatus;
  localImportSessionId: string;
  sourceDeviceId: string | null;
  sourceSdCardId: string | null;
  clientVersion: string | null;
  inventoryId: string | null;
  expectedAssetCount: number;
  originalExpectedAssetCount: number;
  registeredAssetCount: number;
  completedAssetCount: number;
  failedAssetCount: number;
  revision: number;
  openRevisionRevision: number | null;
  openRevisionExpectedDelta: number | null;
  createdAt: string;
  updatedAt: string;
  uploadedAt: string | null;
  linkedAt: string | null;
  GSI1PK?: string;
  GSI1SK?: string;
  GSI2PK?: string;
  GSI2SK?: string;
}

/**
 * DynamoDBは `attribute_not_exists` でnull/absentを区別する — 明示的に
 * `null` を書き込んだ属性は「存在する (NULL型)」ため `attribute_not_exists`
 * が常にfalseになる (link/openRevisionの条件が機能しなくなる致命的な差)。
 * そのため書込み側は null 値のキーを**属性ごと省略**し (`omitNulls`)、
 * 読み取り側は欠けている属性を `?? null` で正規化する。両方が必須。
 */
function omitNulls<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null) (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

function batchViewFromItem(item: BatchItem): PhotoBatchView {
  return {
    id: item.id,
    batchCode: item.batchCode,
    status: item.status,
    localImportSessionId: item.localImportSessionId,
    sourceDeviceId: item.sourceDeviceId ?? null,
    sourceSdCardId: item.sourceSdCardId ?? null,
    clientVersion: item.clientVersion ?? null,
    inventoryId: item.inventoryId ?? null,
    manifest: {
      expectedAssetCount: item.expectedAssetCount,
      originalExpectedAssetCount: item.originalExpectedAssetCount,
      registeredAssetCount: item.registeredAssetCount,
      completedAssetCount: item.completedAssetCount,
      failedAssetCount: item.failedAssetCount,
      revision: item.revision,
      openRevision:
        item.openRevisionRevision == null || item.openRevisionExpectedDelta == null
          ? null
          : { revision: item.openRevisionRevision, expectedDelta: item.openRevisionExpectedDelta },
    },
  };
}

interface AssetItem {
  PK: string;
  SK: string;
  entityType: "PhotoAsset";
  id: string;
  photoBatchId: string;
  clientAssetId: string;
  sequence: number;
  status: PhotoAssetStatus;
  isDeleted: boolean;
  statusBeforeDelete: PhotoAssetStatus | null;
  sourceType: PhotoAssetSourceType;
  revision: number;
  listingSelectionCount: number;
  declaredProcessedMimeType: string;
  declaredProcessedFileSize: number;
  declaredProcessedSha256: string;
  declaredThumbnailMimeType: string;
  declaredThumbnailFileSize: number;
  declaredThumbnailSha256: string;
}

function assetViewFromItem(item: AssetItem): PhotoAssetView {
  return {
    id: item.id,
    photoBatchId: item.photoBatchId,
    clientAssetId: item.clientAssetId,
    sequence: item.sequence,
    status: item.status,
    isDeleted: item.isDeleted,
    statusBeforeDelete: item.statusBeforeDelete ?? null,
    sourceType: item.sourceType,
    revision: item.revision,
    declared: {
      PROCESSED: {
        mimeType: item.declaredProcessedMimeType,
        fileSize: item.declaredProcessedFileSize,
        sha256: item.declaredProcessedSha256,
      },
      THUMBNAIL: {
        mimeType: item.declaredThumbnailMimeType,
        fileSize: item.declaredThumbnailFileSize,
        sha256: item.declaredThumbnailSha256,
      },
    },
  };
}

/** ConditionalCheckFailed/TransactionCanceled(条件由来)を ConditionViolationError へ正規化する。 */
function isConditionFailure(error: unknown): boolean {
  if (error instanceof ConditionalCheckFailedException) return true;
  if (error instanceof TransactionCanceledException) {
    return (error.CancellationReasons ?? []).some((r) => r.Code === "ConditionalCheckFailed");
  }
  return false;
}

/**
 * conditions配列の先頭要素をトランザクション失敗時の代表エラーとして使う。
 * TransactWriteCommandのCancellationReasonsは各TransactItemに1対1対応するが、
 * ここでは「このtransactionが失敗したら呼び出し側は読み直す」という契約
 * (state.tsコメント) を守れば十分で、どのitemが破れたかまでは呼び出し側の
 * 挙動を変えない。violationErrorは呼び出し側 (service.ts) が読む。
 */
function conditionErrorFor(conditions: { violationError: string }[], fallback: string, message: string): ConditionViolationError {
  const violation = conditions[0]?.violationError ?? fallback;
  return new ConditionViolationError(violation, message);
}

export interface DynamoPhotoRegistrationRepositoryConfig {
  ddb: DynamoDBDocumentClient;
  /** 単一テーブルの物理名。未設定でこのクラスを構築させない (呼び出し側でfail closed、handler.ts参照)。 */
  tableName: string;
  /** 既存Inventoryテーブルの物理名。§4.6: このリポジトリはInventory本体を書き換えない。read-onlyの実在確認のみ。 */
  inventoryTableName: string;
  now: () => Date;
}

export class DynamoPhotoRegistrationRepository implements PhotoRegistrationRepository {
  private readonly ddb: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly inventoryTableName: string;
  private readonly now: () => Date;

  constructor(config: DynamoPhotoRegistrationRepositoryConfig) {
    if (!config.tableName) throw new Error("PhotoRegistration table name is not configured (fail closed)");
    if (!config.inventoryTableName) throw new Error("Inventory table name is not configured (fail closed)");
    this.ddb = config.ddb;
    this.tableName = config.tableName;
    this.inventoryTableName = config.inventoryTableName;
    this.now = config.now;
  }

  async findBatchBySessionId(sessionId: string): Promise<PhotoBatchView | null> {
    const idem = await this.ddb.send(
      new GetCommand({ TableName: this.tableName, Key: sessionIdempotencyKey(sessionId) }),
    );
    const batchId = idem.Item?.batchId as string | undefined;
    if (!batchId) return null;
    return this.getBatchById(batchId);
  }

  async getBatchById(batchId: string): Promise<PhotoBatchView | null> {
    const result = await this.ddb.send(new GetCommand({ TableName: this.tableName, Key: batchKey(batchId) }));
    if (!result.Item) return null;
    return batchViewFromItem(result.Item as BatchItem);
  }

  async getAssetsForBatch(batchId: string): Promise<PhotoAssetView[]> {
    const { PK, skPrefix } = assetPrefix(batchId);
    const result = await this.ddb.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :pfx)",
        ExpressionAttributeValues: { ":pk": PK, ":pfx": skPrefix },
      }),
    );
    return (result.Items ?? []).map((item) => assetViewFromItem(item as AssetItem));
  }

  async getAssetWithBatch(photoAssetId: string): Promise<{ batch: PhotoBatchView; asset: PhotoAssetView } | null> {
    const batchId = parseBatchIdFromPhotoAssetId(photoAssetId);
    if (!batchId) return null;
    const [batch, assets] = await Promise.all([this.getBatchById(batchId), this.getAssetsForBatch(batchId)]);
    if (!batch) return null;
    const asset = assets.find((a) => a.id === photoAssetId);
    if (!asset) return null;
    return { batch, asset };
  }

  private encodeCursor(key: Record<string, unknown> | undefined): string | null {
    if (!key) return null;
    return Buffer.from(JSON.stringify(key)).toString("base64url");
  }

  private decodeCursor(cursor: string | null): Record<string, unknown> | undefined {
    if (!cursor) return undefined;
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  }

  async listUnregisteredBatches(limit: number, cursor: string | null): Promise<BatchListPage> {
    const result = await this.ddb.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": "BATCH_STATUS#READY_FOR_REVIEW" },
        Limit: limit,
        ExclusiveStartKey: this.decodeCursor(cursor),
        ScanIndexForward: false, // uploadedAt DESC (§10)
      }),
    );
    return {
      items: (result.Items ?? []).map((item) => batchViewFromItem(item as BatchItem)),
      nextCursor: this.encodeCursor(result.LastEvaluatedKey),
    };
  }

  async listBatchesForInventory(inventoryId: string, limit: number, cursor: string | null): Promise<BatchListPage> {
    const result = await this.ddb.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI2",
        KeyConditionExpression: "GSI2PK = :pk",
        ExpressionAttributeValues: { ":pk": `BATCH_INVENTORY#${inventoryId}` },
        Limit: limit,
        ExclusiveStartKey: this.decodeCursor(cursor),
        ScanIndexForward: false, // linkedAt DESC (§4.7)
      }),
    );
    return {
      items: (result.Items ?? []).map((item) => batchViewFromItem(item as BatchItem)),
      nextCursor: this.encodeCursor(result.LastEvaluatedKey),
    };
  }

  async getListingSelectionState(listingId: string): Promise<{ selectionRevision: number; currentSelection: string[] }> {
    const { PK, skPrefix } = listingSelectionRowPrefix(listingId);
    const [state, rows] = await Promise.all([
      this.ddb.send(new GetCommand({ TableName: this.tableName, Key: listingSelectionStateKey(listingId) })),
      this.ddb.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :pfx)",
          ExpressionAttributeValues: { ":pk": PK, ":pfx": skPrefix },
        }),
      ),
    ]);
    return {
      selectionRevision: (state.Item?.selectionRevision as number | undefined) ?? 0,
      currentSelection: (rows.Items ?? []).map((item) => item.photoAssetId as string),
    };
  }

  /**
   * 既存Inventoryテーブルへの read-only 参照 (§4.6)。
   * `deletedAt` (nullable timestamp) を論理削除フラグとして扱う —
   * amplify/data/resource.ts の Inventory モデルが GSI キーとして
   * `deletedAt` を持つ実装 (amplify/backend.ts zaicoSyncWorker 権限コメント
   * 参照) に合わせた前提。**このリポジトリはInventoryへ一切書き込まない**。
   */
  async lookupInventory(inventoryId: string): Promise<InventoryLookup> {
    const result = await this.ddb.send(
      new GetCommand({ TableName: this.inventoryTableName, Key: { id: inventoryId } }),
    );
    if (!result.Item) return { id: inventoryId, exists: false, isDeleted: false };
    return { id: inventoryId, exists: true, isDeleted: result.Item.deletedAt != null };
  }

  // ───────────────────────────────────────────────────────────────────
  // 書込み系。すべてTransactWriteCommand — 「読んでから素のPut/Update」は
  // 使わない (§93.5 ケースB)。
  // ───────────────────────────────────────────────────────────────────

  async applyCreateBatch(
    decision: Extract<CreatePhotoBatchDecision, { kind: "CREATE_BATCH" }>,
    batchId: string,
    batchCode: string,
    now: string,
  ): Promise<void> {
    const batchItem: BatchItem = {
      ...batchKey(batchId),
      entityType: "PhotoBatch",
      id: batchId,
      batchCode,
      status: "CREATED",
      localImportSessionId: decision.input.localImportSessionId,
      sourceDeviceId: decision.input.sourceDeviceId,
      sourceSdCardId: decision.input.sourceSdCardId,
      clientVersion: decision.input.clientVersion,
      inventoryId: null,
      expectedAssetCount: decision.input.expectedAssetCount,
      originalExpectedAssetCount: decision.input.expectedAssetCount,
      registeredAssetCount: 0,
      completedAssetCount: 0,
      failedAssetCount: 0,
      revision: 0,
      openRevisionRevision: null,
      openRevisionExpectedDelta: null,
      createdAt: now,
      updatedAt: now,
      uploadedAt: null,
      linkedAt: null,
      ...batchStatusIndexKey("CREATED", now, batchId),
    };
    try {
      await this.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: { ...sessionIdempotencyKey(decision.input.localImportSessionId), batchId },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            { Put: { TableName: this.tableName, Item: omitNulls(batchItem as unknown as Record<string, unknown>) } },
          ],
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) throw conditionErrorFor(decision.conditions, "CONFLICT", "createPhotoBatch idempotency race");
      throw error;
    }
  }

  async applyRequestUploads(decision: RequestUploadsDecision, sourceType: PhotoAssetSourceType, now: string): Promise<void> {
    const createItems = decision.items.filter((i) => i.kind === "CREATE_ASSET");
    if (createItems.length === 0 && decision.manifestDelta.registered === 0 && !decision.opensRevision) return;

    const transactItems: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]> = [];

    for (const item of createItems) {
      if (item.kind !== "CREATE_ASSET") continue;
      const assetItem: AssetItem = {
        ...assetKey(parseBatchIdFromPhotoAssetId(item.photoAssetId) ?? "", item.sequence, item.photoAssetId),
        entityType: "PhotoAsset",
        id: item.photoAssetId,
        photoBatchId: decision.batchId,
        clientAssetId: item.clientAssetId,
        sequence: item.sequence,
        status: "UPLOADING",
        isDeleted: false,
        statusBeforeDelete: null,
        sourceType,
        revision: item.revision,
        listingSelectionCount: 0,
        declaredProcessedMimeType: item.declared.PROCESSED.mimeType,
        declaredProcessedFileSize: item.declared.PROCESSED.fileSize,
        declaredProcessedSha256: item.declared.PROCESSED.sha256,
        declaredThumbnailMimeType: item.declared.THUMBNAIL.mimeType,
        declaredThumbnailFileSize: item.declared.THUMBNAIL.fileSize,
        declaredThumbnailSha256: item.declared.THUMBNAIL.sha256,
      };
      transactItems.push(
        { Put: { TableName: this.tableName, Item: omitNulls(assetItem as unknown as Record<string, unknown>) } },
        {
          Put: {
            TableName: this.tableName,
            Item: { ...assetClientIdempotencyKey(decision.batchId, item.clientAssetId), photoAssetId: item.photoAssetId },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        {
          Put: {
            TableName: this.tableName,
            Item: { ...assetHashIdempotencyKey(decision.batchId, item.declared.PROCESSED.sha256), photoAssetId: item.photoAssetId },
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
      );
    }

    // state.ts の conditions[] (説明用predicate文字列) から読取時のstatus/expected/
    // registeredAssetCount上限を取り出し、実際のConditionExpressionへ埋め込む。
    // 並行するchunkが先に受理されていれば #status/expectedAssetCount の不一致、
    // または下のregisteredAssetCount上限でConditionalCheckFailedになる。
    const batchCondition = decision.conditions.find((c) => c.target.startsWith("PhotoBatch#"));
    const readStatus = batchCondition ? /#status = '([^']+)'/.exec(batchCondition.predicate)?.[1] : undefined;
    const readExpected = batchCondition ? Number(/expectedAssetCount = (\d+)/.exec(batchCondition.predicate)?.[1]) : undefined;
    // state.ts の predicate は `registeredAssetCount <= (planLimit - created)` まで
    // 含んでいる — 300枚上限 (§93.5修正指示) を「読み取り時の値と比較する」だけの
    // #status/expectedAssetCount条件に頼らず、commit時点の実際のregisteredAssetCount
    // に対して条件式で予約する。これが無いと、2つの並行requestが同じ
    // expectedAssetCountを読んだまま両方ともUpdateを通過し、301枚目が作られ得る。
    const maxRegistered = batchCondition ? Number(/registeredAssetCount <= (\d+)/.exec(batchCondition.predicate)?.[1]) : undefined;

    const setClauses = ["updatedAt = :now"];
    const conditionClauses: string[] = [];
    const updateValues: Record<string, unknown> = { ":now": now };

    if (createItems.length > 0) {
      setClauses.push("registeredAssetCount = registeredAssetCount + :created");
      updateValues[":created"] = createItems.length;
      conditionClauses.push("#status = :readStatus", "expectedAssetCount = :readExpected");
      updateValues[":readStatus"] = readStatus;
      updateValues[":readExpected"] = readExpected;
      if (maxRegistered !== undefined && !Number.isNaN(maxRegistered)) {
        conditionClauses.push("registeredAssetCount <= :maxRegistered");
        updateValues[":maxRegistered"] = maxRegistered;
      }
    }
    if (decision.opensRevision) {
      setClauses.push("expectedAssetCount = expectedAssetCount + :delta", "openRevisionRevision = :rev", "openRevisionExpectedDelta = :delta");
      updateValues[":delta"] = decision.manifestDelta.expected;
      updateValues[":rev"] = decision.revision;
      conditionClauses.push("attribute_not_exists(openRevisionRevision)");
    }
    if (decision.nextBatchStatus) {
      setClauses.push("#status = :nextStatus", "GSI1PK = :gsi1pk", "GSI1SK = :gsi1sk", "uploadedAt = if_not_exists(uploadedAt, :now)");
      updateValues[":nextStatus"] = decision.nextBatchStatus;
      updateValues[":gsi1pk"] = `BATCH_STATUS#${decision.nextBatchStatus}`;
      updateValues[":gsi1sk"] = `${now}#${decision.batchId}`;
    }

    transactItems.push({
      Update: {
        TableName: this.tableName,
        Key: batchKey(decision.batchId),
        UpdateExpression: `SET ${setClauses.join(", ")}`,
        ...(conditionClauses.length > 0 ? { ConditionExpression: conditionClauses.join(" AND ") } : {}),
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: updateValues,
      },
    });

    try {
      await this.ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
    } catch (error) {
      if (isConditionFailure(error)) throw conditionErrorFor(decision.conditions, "CONFLICT", "requestPhotoAssetUploads condition race");
      throw error;
    }
  }

  async applyCompleteAsset(decision: Extract<CompleteAssetDecision, { kind: "MARK_READY" }>): Promise<void> {
    const batchId = parseBatchIdFromPhotoAssetId(decision.photoAssetId);
    if (!batchId) throw new Error(`photoAssetId ${decision.photoAssetId} has no embedded batchId`);
    const assetCondition = decision.conditions.find((c) => c.target.startsWith("PhotoAsset#"));
    const batchCondition = decision.conditions.find((c) => c.target.startsWith("PhotoBatch#"));
    const readStatus = assetCondition ? /#status = '([^']+)'/.exec(assetCondition.predicate)?.[1] : undefined;
    const maxCompleted = batchCondition ? Number(/completedAssetCount <= (\d+)/.exec(batchCondition.predicate)?.[1]) : undefined;

    const sk = await this.findAssetSk(batchId, decision.photoAssetId);
    if (!sk) throw new Error(`asset ${decision.photoAssetId} not found`);
    try {
      await this.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: { PK: `BATCH#${batchId}`, SK: sk },
                UpdateExpression: "SET #status = :ready",
                ConditionExpression: "#status = :readStatus AND isDeleted = :false",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":ready": decision.nextAssetStatus, ":readStatus": readStatus, ":false": false },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: batchKey(batchId),
                UpdateExpression: "SET completedAssetCount = completedAssetCount + :one, failedAssetCount = failedAssetCount + :failedDelta",
                ...(maxCompleted !== undefined && !Number.isNaN(maxCompleted) ? { ConditionExpression: "completedAssetCount <= :max" } : {}),
                ExpressionAttributeValues: {
                  ":one": 1,
                  ":failedDelta": decision.manifestDelta.failed,
                  ...(maxCompleted !== undefined && !Number.isNaN(maxCompleted) ? { ":max": maxCompleted } : {}),
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) throw conditionErrorFor(decision.conditions, "CONFLICT", "completePhotoAssetUpload condition race");
      throw error;
    }
  }

  /** decideCompleteAssetUpload/decideDeleteAsset/decideRestoreAssetはSKを持たないPhotoAssetViewしか運ばないため、Update前にSKを引く。 */
  private async findAssetSk(batchId: string, photoAssetId: string): Promise<string | null> {
    const { PK, skPrefix } = assetPrefix(batchId);
    const result = await this.ddb.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :pfx)",
        FilterExpression: "id = :id",
        ExpressionAttributeValues: { ":pk": PK, ":pfx": skPrefix, ":id": photoAssetId },
      }),
    );
    const item = result.Items?.[0] as { SK: string } | undefined;
    return item?.SK ?? null;
  }

  async applyFinalize(decision: Extract<CompletePhotoBatchDecision, { kind: "MARK_READY_FOR_REVIEW" }>): Promise<void> {
    const condition = decision.conditions[0];
    const statusMatch = /#status = '([^']+)'/.exec(condition.predicate)?.[1];
    const revisionMatch = Number(/revision = (\d+)/.exec(condition.predicate)?.[1]);
    const expectedMatch = Number(/expectedAssetCount = (\d+)/.exec(condition.predicate)?.[1]);
    const now = this.now().toISOString();

    try {
      await this.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: batchKey(decision.batchId),
                UpdateExpression:
                  "SET #status = :next, revision = :closedRevision, GSI1PK = :gsi1pk, GSI1SK = :gsi1sk, updatedAt = :now REMOVE openRevisionRevision, openRevisionExpectedDelta",
                ConditionExpression:
                  "#status = :readStatus AND revision = :readRevision AND expectedAssetCount = :readExpected AND registeredAssetCount = :readExpected AND completedAssetCount = :readExpected AND failedAssetCount = :zero",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":next": decision.nextBatchStatus,
                  ":closedRevision": decision.closesRevision ?? revisionMatch,
                  ":gsi1pk": `BATCH_STATUS#${decision.nextBatchStatus}`,
                  ":gsi1sk": `${now}#${decision.batchId}`,
                  ":now": now,
                  ":readStatus": statusMatch,
                  ":readRevision": revisionMatch,
                  ":readExpected": expectedMatch,
                  ":zero": 0,
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) throw conditionErrorFor(decision.conditions, "CONFLICT", "completePhotoBatch condition race");
      throw error;
    }
  }

  async applyLink(decision: LinkBatchDecision, now: string): Promise<void> {
    const batchCondition = decision.conditions.find((c) => c.target.startsWith("PhotoBatch#"));
    const inventoryCondition = decision.conditions.find((c) => c.target.startsWith("Inventory#"));
    try {
      await this.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: batchKey(decision.batchId),
                UpdateExpression: "SET inventoryId = :inv, #status = :linked, linkedAt = :now, GSI2PK = :gsi2pk, GSI2SK = :gsi2sk, updatedAt = :now",
                ConditionExpression: "attribute_not_exists(inventoryId) AND #status = :readyStatus AND attribute_not_exists(openRevisionRevision)",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":inv": decision.inventoryId,
                  ":linked": decision.nextBatchStatus,
                  ":now": now,
                  ":readyStatus": "READY_FOR_REVIEW",
                  ...batchInventoryIndexKeyValues(decision.inventoryId, now, decision.batchId),
                },
              },
            },
            {
              // 「存在確認してからUpdate」ではなく、同一transaction内のConditionCheckで
              // link成立と同時に確定させる (state.tsコメント参照)。
              ConditionCheck: {
                TableName: this.inventoryTableName,
                Key: { id: decision.inventoryId },
                ConditionExpression: "attribute_exists(id) AND attribute_not_exists(deletedAt)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) {
        // TransactWriteの複数conditionのどちらが破れたかはCancellationReasonsで
        // 判別できるが、ここでは呼び出し側の再読込で両方とも正しい結論に落ちる
        // (BATCH_ALREADY_LINKED or INVENTORY_NOT_FOUND) ため、代表エラーを返す。
        throw conditionErrorFor([...(batchCondition ? [batchCondition] : []), ...(inventoryCondition ? [inventoryCondition] : [])], "CONFLICT", "link condition race");
      }
      throw error;
    }
  }

  async applyDelete(decision: Extract<DeleteAssetDecision, { kind: "SOFT_DELETE" }>): Promise<void> {
    const batchId = parseBatchIdFromPhotoAssetId(decision.photoAssetId);
    if (!batchId) throw new Error(`photoAssetId ${decision.photoAssetId} has no embedded batchId`);
    const sk = await this.findAssetSk(batchId, decision.photoAssetId);
    if (!sk) throw new Error(`asset ${decision.photoAssetId} not found`);
    try {
      await this.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: { PK: `BATCH#${batchId}`, SK: sk },
                UpdateExpression: "SET isDeleted = :true, #status = :deleted, statusBeforeDelete = :prev",
                ConditionExpression: "isDeleted = :false AND #status = :readStatus AND listingSelectionCount = :zero",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":true": true,
                  ":false": false,
                  ":deleted": "DELETED",
                  ":prev": decision.statusBeforeDelete,
                  ":readStatus": decision.statusBeforeDelete,
                  ":zero": 0,
                },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: batchKey(batchId),
                UpdateExpression:
                  "SET expectedAssetCount = expectedAssetCount + :expDelta, registeredAssetCount = registeredAssetCount + :regDelta, completedAssetCount = completedAssetCount + :compDelta, failedAssetCount = failedAssetCount + :failDelta",
                ExpressionAttributeValues: {
                  ":expDelta": decision.manifestDelta.expected,
                  ":regDelta": decision.manifestDelta.registered,
                  ":compDelta": decision.manifestDelta.completed,
                  ":failDelta": decision.manifestDelta.failed,
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) throw conditionErrorFor(decision.conditions, "ASSET_IN_USE", "deletePhotoAsset condition race");
      throw error;
    }
  }

  async applyRestore(decision: RestoreAssetDecision): Promise<void> {
    const batchId = parseBatchIdFromPhotoAssetId(decision.photoAssetId);
    if (!batchId) throw new Error(`photoAssetId ${decision.photoAssetId} has no embedded batchId`);
    const sk = await this.findAssetSk(batchId, decision.photoAssetId);
    if (!sk) throw new Error(`asset ${decision.photoAssetId} not found`);
    try {
      await this.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: { PK: `BATCH#${batchId}`, SK: sk },
                UpdateExpression: "SET isDeleted = :false, #status = :next",
                ConditionExpression: "isDeleted = :true AND #status = :deletedStatus AND statusBeforeDelete = :next",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":false": false, ":true": true, ":deletedStatus": "DELETED", ":next": decision.nextAssetStatus },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: batchKey(batchId),
                UpdateExpression:
                  "SET expectedAssetCount = expectedAssetCount + :expDelta, registeredAssetCount = registeredAssetCount + :regDelta, completedAssetCount = completedAssetCount + :compDelta, failedAssetCount = failedAssetCount + :failDelta",
                ConditionExpression: "expectedAssetCount <= :maxMinusOne",
                ExpressionAttributeValues: {
                  ":expDelta": decision.manifestDelta.expected,
                  ":regDelta": decision.manifestDelta.registered,
                  ":compDelta": decision.manifestDelta.completed,
                  ":failDelta": decision.manifestDelta.failed,
                  ":maxMinusOne": 299,
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isConditionFailure(error)) throw conditionErrorFor(decision.conditions, "CONFLICT", "restorePhotoAsset condition race");
      throw error;
    }
  }

  async applyListingSelection(decision: Extract<ListingSelectionDecision, { kind: "REPLACE_SELECTION" }>): Promise<void> {
    const { PK, skPrefix } = listingSelectionRowPrefix(decision.listingId);
    const existingRows = await this.ddb.send(
      new QueryCommand({ TableName: this.tableName, KeyConditionExpression: "PK = :pk AND begins_with(SK, :pfx)", ExpressionAttributeValues: { ":pk": PK, ":pfx": skPrefix } }),
    );

    const transactItems: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]> = [
      {
        Put: {
          TableName: this.tableName,
          Item: { ...listingSelectionStateKey(decision.listingId), selectionRevision: decision.nextSelectionRevision },
          ConditionExpression: "attribute_not_exists(selectionRevision) OR selectionRevision = :readRevision",
          ExpressionAttributeValues: { ":readRevision": decision.nextSelectionRevision - 1 },
        },
      },
    ];
    for (const item of existingRows.Items ?? []) {
      transactItems.push({ Delete: { TableName: this.tableName, Key: { PK: item.PK, SK: item.SK } } });
    }
    for (const row of decision.rows) {
      transactItems.push({
        Put: {
          TableName: this.tableName,
          Item: { ...listingSelectionRowKey(decision.listingId, row.sequence, row.photoAssetId), photoAssetId: row.photoAssetId, isPrimary: row.isPrimary },
        },
      });
    }
    for (const photoAssetId of decision.refCountIncrements) {
      transactItems.push(await this.selectionRefCountUpdate(photoAssetId, 1));
    }
    for (const photoAssetId of decision.refCountDecrements) {
      transactItems.push(await this.selectionRefCountUpdate(photoAssetId, -1));
    }

    try {
      await this.ddb.send(new TransactWriteCommand({ TransactItems: transactItems }));
    } catch (error) {
      if (isConditionFailure(error)) throw conditionErrorFor(decision.conditions, "CONFLICT", "setListingImageSelection condition race");
      throw error;
    }
  }

  private async selectionRefCountUpdate(photoAssetId: string, delta: 1 | -1) {
    const batchId = parseBatchIdFromPhotoAssetId(photoAssetId);
    if (!batchId) throw new Error(`photoAssetId ${photoAssetId} has no embedded batchId`);
    const sk = await this.findAssetSk(batchId, photoAssetId);
    if (!sk) throw new Error(`asset ${photoAssetId} not found`);
    return {
      Update: {
        TableName: this.tableName,
        Key: { PK: `BATCH#${batchId}`, SK: sk },
        // §68: 選択と削除は同じカウンタを挟む。READY以外・削除済みへの選択は
        // 同一transaction内でここが弾く (decideListingImageSelectionの事前検証と併せて二重に守る)。
        UpdateExpression: "SET listingSelectionCount = listingSelectionCount + :delta",
        ConditionExpression: delta === 1 ? "isDeleted = :false AND #status = :ready" : "listingSelectionCount >= :one",
        ExpressionAttributeNames: delta === 1 ? { "#status": "status" } : undefined,
        ExpressionAttributeValues: delta === 1 ? { ":delta": delta, ":false": false, ":ready": "READY" } : { ":delta": delta, ":one": 1 },
      },
    };
  }
}

function batchInventoryIndexKeyValues(inventoryId: string, linkedAt: string, batchId: string): Record<string, string> {
  const idx = batchInventoryIndexKey(inventoryId, linkedAt, batchId);
  return { ":gsi2pk": idx.GSI2PK, ":gsi2sk": idx.GSI2SK };
}
