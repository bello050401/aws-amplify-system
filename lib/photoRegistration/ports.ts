/**
 * 画像登録基盤 Phase 1 — 永続化層のポート (インターフェースのみ、AWS非依存)。
 *
 * service.ts はこのインターフェースだけを見て動く。実装は2つ:
 * - awsRepository.ts / awsStorage.ts … 実際のDynamoDB/S3アダプター
 * - scripts/verify-photo-registration-api.ts 内のフェイク実装 … 外部IOを
 *   偽装しつつ、DynamoDBの条件付き書込みを実際に評価する試験用実装
 *
 * ここを純粋なインターフェースとして分離することで、「service.tsのロジック」
 * と「AWSへ実際に投げるcommand」を別々に検証できるようにする
 * (state.tsのAtomicConditionが宣言するだけで終わっていた条件を、
 * awsRepository.tsが実際のConditionExpressionへ翻訳する)。
 */

import type {
  ObservedS3Object,
  PhotoActorRole,
  PhotoAssetSourceType,
  PhotoAssetVariant,
  PhotoAssetView,
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
  UploadTarget,
} from "./state";

/**
 * 条件付き書込みが破れた (DynamoDBの ConditionalCheckFailedException 相当)
 * ことを表すエラー。service.tsはこれを捕捉して読み直し・限定retryを行う。
 * violationErrorはstate.tsのAtomicCondition.violationErrorをそのまま運ぶ。
 */
export class ConditionViolationError extends Error {
  constructor(
    public readonly violationError: string,
    message: string,
  ) {
    super(message);
    this.name = "ConditionViolationError";
  }
}

/** Inventoryの実在確認 (画像登録層からはInventory本体を書き換えない、§4.6)。 */
export interface InventoryLookup {
  id: string;
  exists: boolean;
  isDeleted: boolean;
}

export interface BatchListPage {
  items: PhotoBatchView[];
  nextCursor: string | null;
}

export interface PhotoRegistrationRepository {
  /** 決定的な冪等キー (SESSION#<id>) からの一意な参照。GSI検索ではない (§93.5 ケースB)。 */
  findBatchBySessionId(sessionId: string): Promise<PhotoBatchView | null>;
  getBatchById(batchId: string): Promise<PhotoBatchView | null>;
  /** 論理削除済みも含む全Asset (byBatchSequence, §4.5)。Scanではなくbatch PKへのQuery。 */
  getAssetsForBatch(batchId: string): Promise<PhotoAssetView[]>;
  /** photoAssetIdからbatchIdを復元してGetItem (keys.ts parseBatchIdFromPhotoAssetId参照)。 */
  getAssetWithBatch(photoAssetId: string): Promise<{ batch: PhotoBatchView; asset: PhotoAssetView } | null>;
  /** status=READY_FOR_REVIEWかつ未紐付けの一覧 (§4.5 byStatusUploadedAt、§10)。Scan禁止。 */
  listUnregisteredBatches(limit: number, cursor: string | null): Promise<BatchListPage>;
  /** Inventoryに紐づく全PhotoBatch (§4.5 byInventoryLinkedAt、§4.7 複数撮影バッチ)。 */
  listBatchesForInventory(inventoryId: string, limit: number, cursor: string | null): Promise<BatchListPage>;
  getListingSelectionState(listingId: string): Promise<{ selectionRevision: number; currentSelection: string[] }>;
  /** Inventoryの実在・論理削除確認。既存Inventoryテーブルへの参照であり、このリポジトリは書き込まない。 */
  lookupInventory(inventoryId: string): Promise<InventoryLookup>;

  applyCreateBatch(
    decision: Extract<CreatePhotoBatchDecision, { kind: "CREATE_BATCH" }>,
    batchId: string,
    batchCode: string,
    now: string,
  ): Promise<void>;
  applyRequestUploads(
    decision: RequestUploadsDecision,
    sourceType: PhotoAssetSourceType,
    now: string,
  ): Promise<void>;
  applyCompleteAsset(decision: Extract<CompleteAssetDecision, { kind: "MARK_READY" }>): Promise<void>;
  applyFinalize(decision: Extract<CompletePhotoBatchDecision, { kind: "MARK_READY_FOR_REVIEW" }>): Promise<void>;
  applyLink(decision: LinkBatchDecision, now: string): Promise<void>;
  applyDelete(decision: Extract<DeleteAssetDecision, { kind: "SOFT_DELETE" }>): Promise<void>;
  applyRestore(decision: RestoreAssetDecision): Promise<void>;
  applyListingSelection(decision: Extract<ListingSelectionDecision, { kind: "REPLACE_SELECTION" }>): Promise<void>;
}

export interface PresignedUpload extends UploadTarget {
  uploadUrl: string;
}

export interface PhotoStoragePort {
  /** S3への直接presigned PUT発行 (§73)。画像バイナリはAPIサーバーを経由しない。 */
  presignUploadTargets(targets: UploadTarget[]): Promise<PresignedUpload[]>;
  /**
   * completePhotoAssetUpload用のHeadObject (§5.5)。「クライアントが完了と
   * 言っただけ」を裏取りする唯一の手段。s3Keyは呼び出し側 (service.ts) が
   * requestPhotoAssetUploads時点でPhotoAssetView.declaredのmimeTypeから
   * 確定させたものをそのまま渡す — この層で拡張子を再推測しない
   * (Web追加uploadのPNG/WebPでもキーを取り違えないため)。
   */
  headObjects(targets: { variant: PhotoAssetVariant; s3Key: string }[]): Promise<ObservedS3Object[]>;
}

/**
 * 認証済みサーバーコンテキストからの読み取り専用ビュー。
 * クライアントのrequest本体を信用しない (§1.1 信頼境界)。
 */
export interface TrustedClaims {
  userId: string;
  /** Cognito group群。ADMIN/EDITOR/VIEWER/PHOTO_DEVICE のいずれか (未定義グループはVIEWER未満として拒否)。 */
  groups: string[];
  /** PHOTO_DEVICE専用トークンに埋め込まれる端末識別子。STAFF/ADMINセッションではnull。 */
  deviceId: string | null;
}

export interface RoleResolution {
  role: PhotoActorRole;
}
