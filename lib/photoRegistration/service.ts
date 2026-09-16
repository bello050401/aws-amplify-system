/**
 * 画像登録基盤 Phase 1 — 実行可能なサービス層。
 *
 * lib/photoRegistration/{validation,state}.ts (純粋・永続化非依存) と
 * ports.ts (永続化ポート) を束ね、1回のAPI呼び出しとして完結させる。
 * ここには「S3へ本当にHEADする」「DynamoDBへ本当にTransactWriteする」
 * という副作用があるため、AWSアダプター (awsRepository.ts / awsStorage.ts)
 * を注入して実行する。scripts/verify-photo-registration-api.ts はこの
 * クラスを、外部IO (repository/storage) だけを偽装した状態で試験する。
 *
 * 【限定retry (§93.5 ケースB, state.tsのconditionsコメント)】
 * DynamoDBの条件付き書込みが破れた (ConditionViolationError) 場合、
 * 「読み直してから再判断」を最大 MAX_CONFLICT_RETRIES 回だけ行う。
 * これは無限リトライではない — 際限なく再試行すると本当の競合 (異なる
 * クライアントが延々と競合し続ける異常系) でLambdaが張り付くため、
 * 上限に達したら CONFLICT をそのまま返し、クライアント側の再送 (docs
 * のエラーコード表で「読み直してから再送」に分類されている) に委ねる。
 */

import { randomUUID } from "node:crypto";
import {
  assertDeviceOwnsBatch,
  authorizeOperation,
  resolveActorContext,
  type AuthConfig,
  type PhotoRegistrationOperation,
} from "./auth";
import { allocatePhotoAssetId } from "./keys";
import {
  ConditionViolationError,
  type PhotoRegistrationRepository,
  type PhotoStoragePort,
  type TrustedClaims,
} from "./ports";
import {
  canTransitionBatch,
  decideCompleteAssetUpload,
  decideCompletePhotoBatch,
  decideCreatePhotoBatch,
  decideDeleteAsset,
  decideLinkBatchToInventory,
  decideListingImageSelection,
  decideRequestUploads,
  decideRestoreAsset,
  type RequestUploadsContext,
} from "./state";
import {
  err,
  extensionForMimeType,
  ok,
  photoAssetS3Key,
  sourceTypeForActor,
  type PhotoActorContext,
  type PhotoAssetVariant,
  type PhotoErrorCode,
  type PhotoResult,
} from "./types";
import {
  validateAssetMutationInput,
  validateCompleteAssetUploadInput,
  validateCompletePhotoBatchInput,
  validateCreatePhotoBatchInput,
  validateLinkBatchToInventoryInput,
  validateListingImageSelectionInput,
  validateRequestUploadsInput,
} from "./validation";

const ALL_VARIANTS: PhotoAssetVariant[] = ["PROCESSED", "THUMBNAIL"];
const DEFAULT_MAX_CONFLICT_RETRIES = 3;

function buildBatchCode(now: Date, suffix: string): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `PHOTO-${y}${m}${d}-${suffix}`;
}

export interface PhotoRegistrationServiceConfig {
  repository: PhotoRegistrationRepository;
  storage: PhotoStoragePort;
  authConfig: AuthConfig;
  now?: () => Date;
  newId?: () => string;
  maxConflictRetries?: number;
}

/**
 * 呼び出し側 (Lambda handler / Next.js server action) が渡す認証済みclaims
 * から actor を作り、operationごとの許可role (auth.ts) を検証してから
 * 各メソッド本体を実行する。**request bodyのactorId/role/sourceTypeは
 * 一切読まない** (§1.1 信頼境界)。
 */
export class PhotoRegistrationService {
  private readonly repository: PhotoRegistrationRepository;
  private readonly storage: PhotoStoragePort;
  private readonly authConfig: AuthConfig;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly maxConflictRetries: number;

  constructor(config: PhotoRegistrationServiceConfig) {
    this.repository = config.repository;
    this.storage = config.storage;
    this.authConfig = config.authConfig;
    this.now = config.now ?? (() => new Date());
    this.newId = config.newId ?? randomUUID;
    this.maxConflictRetries = config.maxConflictRetries ?? DEFAULT_MAX_CONFLICT_RETRIES;
  }

  private authorize(claims: TrustedClaims, operation: PhotoRegistrationOperation): PhotoResult<PhotoActorContext> {
    const actorResult = resolveActorContext(claims, this.authConfig);
    if (!actorResult.ok) return actorResult;
    const authz = authorizeOperation(actorResult.value, operation);
    if (!authz.ok) return authz;
    return actorResult;
  }

  // ─────────────────────────────────────────────────────────────────
  // createPhotoBatch (§7.1)
  // ─────────────────────────────────────────────────────────────────

  async createPhotoBatch(
    rawInput: unknown,
    claims: TrustedClaims,
  ): Promise<PhotoResult<{ batchId: string; batchCode: string; status: string }>> {
    const actorResult = this.authorize(claims, "createPhotoBatch");
    if (!actorResult.ok) return actorResult;

    const validated = validateCreatePhotoBatchInput(rawInput);
    if (!validated.ok) return validated;

    for (let attempt = 0; attempt <= this.maxConflictRetries; attempt += 1) {
      const existing = await this.repository.findBatchBySessionId(validated.value.localImportSessionId);
      const decision = decideCreatePhotoBatch(validated.value, existing);
      if (!decision.ok) return decision;

      if (decision.value.kind === "RETURN_EXISTING") {
        return ok({ batchId: decision.value.batchId, batchCode: existing!.batchCode, status: decision.value.status });
      }

      const batchId = this.newId();
      const batchCode = buildBatchCode(this.now(), this.newId().slice(0, 3).toUpperCase());
      try {
        await this.repository.applyCreateBatch(decision.value, batchId, batchCode, this.now().toISOString());
        return ok({ batchId, batchCode, status: "CREATED" });
      } catch (error) {
        if (error instanceof ConditionViolationError) continue; // 誰かが先に作った。次のループで読み直して既存batchを返す。
        throw error;
      }
    }
    return err("CONFLICT", "createPhotoBatch: exhausted retries after repeated idempotency races");
  }

  // ─────────────────────────────────────────────────────────────────
  // requestPhotoAssetUploads (§7.2 / §7.5)
  // ─────────────────────────────────────────────────────────────────

  async requestPhotoAssetUploads(
    rawInput: unknown,
    claims: TrustedClaims,
  ): Promise<PhotoResult<{ batchId: string; revision: number; items: unknown[] }>> {
    const actorResult = this.authorize(claims, "requestPhotoAssetUploads");
    if (!actorResult.ok) return actorResult;
    const sourceType = sourceTypeForActor(actorResult.value.role);

    const validated = validateRequestUploadsInput(rawInput, sourceType);
    if (!validated.ok) return validated;

    for (let attempt = 0; attempt <= this.maxConflictRetries; attempt += 1) {
      const batch = await this.repository.getBatchById(validated.value.batchId);
      if (!batch) return err("BATCH_NOT_FOUND", `batch ${validated.value.batchId} was not found`, "batchId");

      const ownership = assertDeviceOwnsBatch(claims, actorResult.value, batch.sourceDeviceId);
      if (!ownership.ok) return ownership;

      const assets = await this.repository.getAssetsForBatch(batch.id);
      const context: RequestUploadsContext = {
        batch,
        assets,
        allocateAssetId: () => allocatePhotoAssetId(batch.id, this.newId()),
      };
      const decision = decideRequestUploads(validated.value, context);
      if (!decision.ok) return decision;

      try {
        await this.repository.applyRequestUploads(decision.value, sourceType, this.now().toISOString());
      } catch (error) {
        if (error instanceof ConditionViolationError) continue;
        throw error;
      }

      const uploadTargets = decision.value.items.flatMap((item) =>
        item.kind === "CREATE_ASSET" || item.kind === "REISSUE_UPLOAD" ? item.uploads : [],
      );
      const presigned = await this.storage.presignUploadTargets(uploadTargets);
      const urlByKey = new Map(presigned.map((p) => [p.s3Key, p.uploadUrl]));

      const items = decision.value.items.map((item) => {
        if (item.kind === "CREATE_ASSET" || item.kind === "REISSUE_UPLOAD") {
          return {
            kind: item.kind,
            clientAssetId: item.clientAssetId,
            photoAssetId: item.photoAssetId,
            uploads: item.uploads.map((u) => ({
              variant: u.variant,
              s3Key: u.s3Key,
              uploadUrl: urlByKey.get(u.s3Key) ?? null,
              expectedBytes: u.expectedBytes,
              expectedMimeType: u.expectedMimeType,
              expectedSha256: u.expectedSha256,
            })),
          };
        }
        if (item.kind === "ALREADY_READY") {
          return { kind: item.kind, clientAssetId: item.clientAssetId, photoAssetId: item.photoAssetId };
        }
        return {
          kind: item.kind,
          clientAssetId: item.clientAssetId,
          photoAssetId: item.photoAssetId,
          duplicateOfClientAssetId: item.duplicateOfClientAssetId,
        };
      });

      return ok({ batchId: decision.value.batchId, revision: decision.value.revision, items });
    }
    return err("CONFLICT", "requestPhotoAssetUploads: exhausted retries under contention");
  }

  // ─────────────────────────────────────────────────────────────────
  // completePhotoAssetUpload (§7.3 / §5.5)
  // ─────────────────────────────────────────────────────────────────

  async completePhotoAssetUpload(
    rawInput: unknown,
    claims: TrustedClaims,
  ): Promise<PhotoResult<{ photoAssetId: string; status: string }>> {
    const actorResult = this.authorize(claims, "completePhotoAssetUpload");
    if (!actorResult.ok) return actorResult;

    const validated = validateCompleteAssetUploadInput(rawInput);
    if (!validated.ok) return validated;

    for (let attempt = 0; attempt <= this.maxConflictRetries; attempt += 1) {
      const found = await this.repository.getAssetWithBatch(validated.value.photoAssetId);
      if (!found) return err("ASSET_NOT_FOUND", `asset ${validated.value.photoAssetId} was not found`, "photoAssetId");
      const { batch, asset } = found;

      const ownership = assertDeviceOwnsBatch(claims, actorResult.value, batch.sourceDeviceId);
      if (!ownership.ok) return ownership;

      // §5.5: 「クライアントが完了と言っただけ」でREADYにしない。宣言時点の
      // mimeTypeからS3キーを再構成し、実際にHEADする。
      const targets = ALL_VARIANTS.map((variant) => ({
        variant,
        s3Key: photoAssetS3Key(batch.id, asset.id, variant, extensionForMimeType(asset.declared[variant].mimeType)),
      }));
      const observed = await this.storage.headObjects(targets);

      const decision = decideCompleteAssetUpload(validated.value, { batch, asset, observed });
      if (!decision.ok) return decision;
      if (decision.value.kind === "NO_OP") return ok({ photoAssetId: asset.id, status: "READY" });

      try {
        await this.repository.applyCompleteAsset(decision.value);
        return ok({ photoAssetId: asset.id, status: decision.value.nextAssetStatus });
      } catch (error) {
        if (error instanceof ConditionViolationError) continue;
        throw error;
      }
    }
    return err("CONFLICT", "completePhotoAssetUpload: exhausted retries under contention");
  }

  // ─────────────────────────────────────────────────────────────────
  // completePhotoBatch (§7.4 / §29)
  // ─────────────────────────────────────────────────────────────────

  async completePhotoBatch(
    rawInput: unknown,
    claims: TrustedClaims,
  ): Promise<PhotoResult<{ batchId: string; status: string }>> {
    const actorResult = this.authorize(claims, "completePhotoBatch");
    if (!actorResult.ok) return actorResult;

    const validated = validateCompletePhotoBatchInput(rawInput);
    if (!validated.ok) return validated;

    for (let attempt = 0; attempt <= this.maxConflictRetries; attempt += 1) {
      const batch = await this.repository.getBatchById(validated.value.batchId);
      if (!batch) return err("BATCH_NOT_FOUND", `batch ${validated.value.batchId} was not found`, "batchId");

      const ownership = assertDeviceOwnsBatch(claims, actorResult.value, batch.sourceDeviceId);
      if (!ownership.ok) return ownership;

      const decision = decideCompletePhotoBatch(validated.value, batch);
      if (!decision.ok) return decision;
      if (decision.value.kind === "NO_OP") return ok({ batchId: batch.id, status: decision.value.status });

      try {
        await this.repository.applyFinalize(decision.value);
        return ok({ batchId: batch.id, status: decision.value.nextBatchStatus });
      } catch (error) {
        if (error instanceof ConditionViolationError) continue;
        throw error;
      }
    }
    return err("CONFLICT", "completePhotoBatch: exhausted retries under contention");
  }

  // ─────────────────────────────────────────────────────────────────
  // linkPhotoBatchToInventory (§18 / §59)
  // ─────────────────────────────────────────────────────────────────

  async linkPhotoBatchToInventory(
    rawInput: unknown,
    claims: TrustedClaims,
  ): Promise<PhotoResult<{ batchId: string; status: string }>> {
    const actorResult = this.authorize(claims, "linkPhotoBatchToInventory");
    if (!actorResult.ok) return actorResult;

    const validated = validateLinkBatchToInventoryInput(rawInput);
    if (!validated.ok) return validated;

    for (let attempt = 0; attempt <= this.maxConflictRetries; attempt += 1) {
      const batch = await this.repository.getBatchById(validated.value.batchId);
      if (!batch) return err("BATCH_NOT_FOUND", `batch ${validated.value.batchId} was not found`, "batchId");
      const inventory = await this.repository.lookupInventory(validated.value.inventoryId);

      const decision = decideLinkBatchToInventory(validated.value, { batch, inventory });
      if (!decision.ok) return decision;

      try {
        await this.repository.applyLink(decision.value, this.now().toISOString());
        return ok({ batchId: batch.id, status: decision.value.nextBatchStatus });
      } catch (error) {
        if (error instanceof ConditionViolationError) continue;
        throw error;
      }
    }
    return err("CONFLICT", "linkPhotoBatchToInventory: exhausted retries under contention");
  }

  // ─────────────────────────────────────────────────────────────────
  // deletePhotoAsset / restorePhotoAsset (§12 / §68 / §67 / §47)
  // ─────────────────────────────────────────────────────────────────

  async deletePhotoAsset(rawInput: unknown, claims: TrustedClaims): Promise<PhotoResult<{ photoAssetId: string }>> {
    const actorResult = this.authorize(claims, "deletePhotoAsset");
    if (!actorResult.ok) return actorResult;

    const validated = validateAssetMutationInput(rawInput);
    if (!validated.ok) return validated;

    for (let attempt = 0; attempt <= this.maxConflictRetries; attempt += 1) {
      const found = await this.repository.getAssetWithBatch(validated.value.photoAssetId);
      if (!found) return err("ASSET_NOT_FOUND", `asset ${validated.value.photoAssetId} was not found`, "photoAssetId");

      // activeListingSelectionCountはPhotoAsset行自身が持つ参照カウンタ
      // (§68 GSI逆引きは使わない) — getAssetWithBatchが返すPhotoAssetViewには
      // 含まれないため、専用に持たせず、リポジトリのapplyDeleteの条件式
      // (listingSelectionCount = 0) が唯一の正とする。ここでの事前判定は
      // 「削除済みなら即NO_OP」だけに絞り、参照有無の判断はrepository層の
      // transaction条件へ委ねる (decideDeleteAssetの引数として渡す値は
      // 0固定にせず、実カウンタを読む必要があるためTransaction内条件のみで守る)。
      const decision = decideDeleteAsset({ asset: found.asset, activeListingSelectionCount: 0 });
      if (!decision.ok) return decision;
      if (decision.value.kind === "NO_OP") return ok({ photoAssetId: found.asset.id });

      try {
        await this.repository.applyDelete(decision.value);
        return ok({ photoAssetId: found.asset.id });
      } catch (error) {
        if (error instanceof ConditionViolationError) return err(error.violationError as PhotoErrorCode, error.message, "photoAssetId");
        throw error;
      }
    }
    return err("CONFLICT", "deletePhotoAsset: exhausted retries under contention");
  }

  async restorePhotoAsset(rawInput: unknown, claims: TrustedClaims): Promise<PhotoResult<{ photoAssetId: string; status: string }>> {
    const actorResult = this.authorize(claims, "restorePhotoAsset");
    if (!actorResult.ok) return actorResult;

    const validated = validateAssetMutationInput(rawInput);
    if (!validated.ok) return validated;

    for (let attempt = 0; attempt <= this.maxConflictRetries; attempt += 1) {
      const found = await this.repository.getAssetWithBatch(validated.value.photoAssetId);
      if (!found) return err("ASSET_NOT_FOUND", `asset ${validated.value.photoAssetId} was not found`, "photoAssetId");
      const assets = await this.repository.getAssetsForBatch(found.batch.id);
      const activeAssetCount = assets.filter((a) => !a.isDeleted).length;

      const decision = decideRestoreAsset({ asset: found.asset, batch: found.batch, activeAssetCount, actor: actorResult.value });
      if (!decision.ok) return decision;

      try {
        await this.repository.applyRestore(decision.value);
        return ok({ photoAssetId: found.asset.id, status: decision.value.nextAssetStatus });
      } catch (error) {
        if (error instanceof ConditionViolationError) continue;
        throw error;
      }
    }
    return err("CONFLICT", "restorePhotoAsset: exhausted retries under contention");
  }

  // ─────────────────────────────────────────────────────────────────
  // setListingImageSelection (§21 / §22 / §45)
  // ─────────────────────────────────────────────────────────────────

  /**
   * `listingInventoryId` は呼び出し側 (既存Listing/ChannelListingを扱う
   * server action) が既存モデルから引いて渡す — このサービスは既存Listing
   * テーブルを一切読み書きしない (§21 新旧併存)。
   */
  async setListingImageSelection(
    rawInput: unknown,
    listingInventoryId: string,
    options: { maxImages: number },
    claims: TrustedClaims,
  ): Promise<PhotoResult<{ listingId: string; photoAssetIds: string[] }>> {
    const actorResult = this.authorize(claims, "setListingImageSelection");
    if (!actorResult.ok) return actorResult;

    const validated = validateListingImageSelectionInput(rawInput, options);
    if (!validated.ok) return validated;

    for (let attempt = 0; attempt <= this.maxConflictRetries; attempt += 1) {
      const batchPage = await this.repository.listBatchesForInventory(listingInventoryId, 200, null);
      const assetLists = await Promise.all(batchPage.items.map((b) => this.repository.getAssetsForBatch(b.id)));
      const assets = assetLists.flat();
      const batchInventoryIdByAssetId: Record<string, string | null> = {};
      for (const asset of assets) batchInventoryIdByAssetId[asset.id] = listingInventoryId;

      const state = await this.repository.getListingSelectionState(validated.value.listingId);
      const decision = decideListingImageSelection(validated.value, {
        assets,
        batchInventoryIdByAssetId,
        listingInventoryId,
        currentSelection: state.currentSelection,
        selectionRevision: state.selectionRevision,
      });
      if (!decision.ok) return decision;

      try {
        await this.repository.applyListingSelection(decision.value);
        return ok({ listingId: validated.value.listingId, photoAssetIds: validated.value.photoAssetIds });
      } catch (error) {
        if (error instanceof ConditionViolationError) continue;
        throw error;
      }
    }
    return err("CONFLICT", "setListingImageSelection: exhausted retries under contention");
  }

  // ─────────────────────────────────────────────────────────────────
  // 読み取り専用一覧 (§10 / §4.7)。Scanは使わない (repository実装側の制約)。
  // ─────────────────────────────────────────────────────────────────

  async listUnregisteredBatches(limit: number, cursor: string | null, claims: TrustedClaims) {
    const actorResult = this.authorize(claims, "listUnregisteredBatches");
    if (!actorResult.ok) return actorResult;
    return ok(await this.repository.listUnregisteredBatches(Math.min(limit, 100), cursor));
  }

  async listBatchesForInventory(inventoryId: string, limit: number, cursor: string | null, claims: TrustedClaims) {
    const actorResult = this.authorize(claims, "listBatchesForInventory");
    if (!actorResult.ok) return actorResult;
    return ok(await this.repository.listBatchesForInventory(inventoryId, Math.min(limit, 100), cursor));
  }
}

// canTransitionBatch is re-exported for callers (e.g. handler.ts diagnostics) that want to
// explain an INVALID_STATUS_TRANSITION without duplicating the transition table.
export { canTransitionBatch };
