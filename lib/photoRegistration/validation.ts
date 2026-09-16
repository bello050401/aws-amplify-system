/**
 * 画像登録基盤 Phase 1 — 入力検証 (純粋)。
 *
 * ここは「送られてきた値の形が契約 (types.ts) を満たすか」だけを見る層で、
 * 永続化された状態 (既存batch / 既存asset / Inventoryの実在) は一切見ない。
 * 状態に依存する判断は state.ts の decide* が行う。
 *
 * API境界なので入力は `unknown` として受け、実際に型を絞る。GraphQLの
 * 型宣言を信用して素通しすると、null許容・数値の取り違え・大文字hash等が
 * そのままDynamoDBの冪等キーに入り込み、同一画像が別Assetとして二重登録
 * される (§8 冪等性の破れ)。
 *
 * 検証を通った値は Validated* 型になり、state.ts はその型しか受け取らない。
 */

import {
  MAX_ASSETS_PER_BATCH,
  MAX_IMAGE_DIMENSION,
  MAX_PROCESSED_BYTES,
  MAX_THUMBNAIL_BYTES,
  MAX_UPLOAD_REQUEST_CHUNK,
  PHOTO_STATION_PROCESSED_MIME_TYPES,
  SHA256_PATTERN,
  THUMBNAIL_MIME_TYPES,
  WEB_UPLOAD_PROCESSED_MIME_TYPES,
  err,
  ok,
  type DeclaredObject,
  type PhotoAssetSourceType,
  type PhotoAssetVariant,
  type PhotoErr,
  type PhotoResult,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────
// 小さな共通検証子
// ─────────────────────────────────────────────────────────────────────────

function asRecord(input: unknown, field: string): PhotoResult<Record<string, unknown>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return err("INVALID_INPUT", `${field} must be an object`, field);
  }
  return ok(input as Record<string, unknown>);
}

/** 空文字・空白のみ・上限超過を弾く。前後の空白は落として正規化する。 */
function requireString(
  source: Record<string, unknown>,
  key: string,
  field: string,
  maxLength: number,
): PhotoResult<string> {
  const raw = source[key];
  if (typeof raw !== "string") return err("INVALID_INPUT", `${field} must be a string`, field);
  const trimmed = raw.trim();
  if (trimmed.length === 0) return err("INVALID_INPUT", `${field} must not be empty`, field);
  if (trimmed.length > maxLength) {
    return err("INVALID_INPUT", `${field} must be at most ${maxLength} characters`, field);
  }
  return ok(trimmed);
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
  field: string,
  maxLength: number,
): PhotoResult<string | null> {
  const raw = source[key];
  if (raw === undefined || raw === null) return ok(null);
  return requireString(source, key, field, maxLength);
}

/**
 * 整数であること。NaN / Infinity / 小数 / 数値文字列をすべて拒否する。
 * 数値文字列を許すと "24" と 24 が別の値として集計に混ざる。
 */
function requireInt(
  source: Record<string, unknown>,
  key: string,
  field: string,
  min: number,
  max: number,
): PhotoResult<number> {
  const raw = source[key];
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return err("INVALID_INPUT", `${field} must be an integer`, field);
  }
  if (raw < min || raw > max) {
    return err("INVALID_INPUT", `${field} must be between ${min} and ${max}`, field);
  }
  return ok(raw);
}

/** sha256は小文字hex 64桁のみ。大文字を自動で小文字化せず拒否する — 送信側の非決定性を契約で消す。 */
function requireSha256(
  source: Record<string, unknown>,
  key: string,
  field: string,
): PhotoResult<string> {
  const raw = source[key];
  if (typeof raw !== "string" || !SHA256_PATTERN.test(raw)) {
    return err("INVALID_INPUT", `${field} must be a lowercase hex sha256 digest`, field);
  }
  return ok(raw);
}

function isErr<T>(result: PhotoResult<T>): result is PhotoErr {
  return result.ok === false;
}

// ─────────────────────────────────────────────────────────────────────────
// createPhotoBatch (§7.1 / §91)
// ─────────────────────────────────────────────────────────────────────────

export interface ValidatedCreatePhotoBatch {
  localImportSessionId: string;
  sourceDeviceId: string | null;
  sourceSdCardId: string | null;
  clientVersion: string | null;
  /** ローカルが検出した差分の**原本**枚数。記録用であり、finalizeの判定には使わない。 */
  imageCountOriginal: number;
  /**
   * **この取込で登録する予定の枚数** (重複除去後)。ここで固定し、以後
   * requestUploadsでは増やさない (§7.6)。途中再開時に「300枚予定 / 25枚登録」
   * と不足を表示できるのはこの固定値があるため。原本枚数以下であること
   * (重複を除いた結果が原本より増えることはない)。
   */
  expectedAssetCount: number;
}

export function validateCreatePhotoBatchInput(input: unknown): PhotoResult<ValidatedCreatePhotoBatch> {
  const record = asRecord(input, "input");
  if (isErr(record)) return record;
  const source = record.value;

  const localImportSessionId = requireString(source, "localImportSessionId", "localImportSessionId", 200);
  if (isErr(localImportSessionId)) return localImportSessionId;
  const sourceDeviceId = optionalString(source, "sourceDeviceId", "sourceDeviceId", 100);
  if (isErr(sourceDeviceId)) return sourceDeviceId;
  const sourceSdCardId = optionalString(source, "sourceSdCardId", "sourceSdCardId", 100);
  if (isErr(sourceSdCardId)) return sourceSdCardId;
  const clientVersion = optionalString(source, "clientVersion", "clientVersion", 50);
  if (isErr(clientVersion)) return clientVersion;
  // 0枚 (§79 SD差分0枚) の取込要求自体は受け付ける。0枚batchをREADY_FOR_REVIEW
  // へ進められないことは state.ts の decideCompletePhotoBatch が判断する。
  const imageCountOriginal = requireInt(source, "imageCountOriginal", "imageCountOriginal", 0, MAX_ASSETS_PER_BATCH);
  if (isErr(imageCountOriginal)) return imageCountOriginal;
  const expectedAssetCount = requireInt(source, "expectedAssetCount", "expectedAssetCount", 0, MAX_ASSETS_PER_BATCH);
  if (isErr(expectedAssetCount)) return expectedAssetCount;
  if (expectedAssetCount.value > imageCountOriginal.value) {
    return err(
      "INVALID_INPUT",
      "expectedAssetCount must not exceed imageCountOriginal",
      "expectedAssetCount",
    );
  }

  return ok({
    localImportSessionId: localImportSessionId.value,
    sourceDeviceId: sourceDeviceId.value,
    sourceSdCardId: sourceSdCardId.value,
    clientVersion: clientVersion.value,
    imageCountOriginal: imageCountOriginal.value,
    expectedAssetCount: expectedAssetCount.value,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// requestPhotoAssetUploads (§7.2 / §7.5 / §91)
// ─────────────────────────────────────────────────────────────────────────

export interface ValidatedUploadAssetRequest {
  clientAssetId: string;
  fileName: string;
  /** PROCESSED / THUMBNAIL の両方を必須で宣言させる。片方だけのAssetは作らせない (types.ts PhotoAssetVariant参照)。 */
  declared: Record<PhotoAssetVariant, DeclaredObject>;
}

export interface ValidatedUploadRequest {
  batchId: string;
  /** 認証主体から導出した値。request本体の申告ではない (types.ts sourceTypeForActor)。 */
  sourceType: PhotoAssetSourceType;
  assets: ValidatedUploadAssetRequest[];
  /**
   * 追加upload (§13) のrevisionを開く時だけ必須。そのrevisionで追加する
   * 予定枚数を開始時に固定する。openRevisionが既にある場合は同じ値の再送のみ
   * 許し、二重加算しない。通常のuploadではnull。
   */
  additionalExpectedCount: number | null;
}

function allowedProcessedMimeTypes(sourceType: PhotoAssetSourceType): readonly string[] {
  return sourceType === "PHOTO_STATION"
    ? PHOTO_STATION_PROCESSED_MIME_TYPES
    : WEB_UPLOAD_PROCESSED_MIME_TYPES;
}

function validateDeclaredObject(
  input: unknown,
  field: string,
  allowedMimeTypes: readonly string[],
  maxBytes: number,
): PhotoResult<DeclaredObject> {
  const record = asRecord(input, field);
  if (isErr(record)) return record;
  const source = record.value;

  const mimeType = requireString(source, "mimeType", `${field}.mimeType`, 100);
  if (isErr(mimeType)) return mimeType;
  if (!allowedMimeTypes.includes(mimeType.value)) {
    return err(
      "INVALID_INPUT",
      `${field}.mimeType must be one of ${allowedMimeTypes.join(", ")}`,
      `${field}.mimeType`,
    );
  }
  // 0 byteのオブジェクトは「uploadできたが中身が無い」状態と区別できないため最小1。
  const fileSize = requireInt(source, "fileSize", `${field}.fileSize`, 1, maxBytes);
  if (isErr(fileSize)) return fileSize;
  const sha256 = requireSha256(source, "sha256", `${field}.sha256`);
  if (isErr(sha256)) return sha256;

  return ok({ mimeType: mimeType.value, fileSize: fileSize.value, sha256: sha256.value });
}

/**
 * chunkの形式検証。
 *
 * - 1〜25件 (§7.5)。0件は「何も要求していない」ので不正、26件はCHUNK_TOO_LARGE。
 * - chunk内でのclientAssetId重複、chunk内でのprocessed sha256重複はどちらも
 *   INVALID_INPUT。**chunkをまたいだ** 同一hashの再送は正常系 (重複SKIP) だが、
 *   同じ要求の中に同じ画像が2回入っているのは送信側の自己矛盾であり、
 *   どちらのclientAssetIdへ紐づけるかを決められない。
 *
 * `sourceType` は引数で受け取る — 認証済みサーバーコンテキストから導出した
 * 値であり、request本体の `sourceType` は読まない (端末がWEB_UPLOADを名乗って
 * 確認済みbatchへ追加するのを防ぐ)。
 */
export function validateRequestUploadsInput(
  input: unknown,
  sourceType: PhotoAssetSourceType,
): PhotoResult<ValidatedUploadRequest> {
  const record = asRecord(input, "input");
  if (isErr(record)) return record;
  const source = record.value;

  const batchId = requireString(source, "batchId", "batchId", 100);
  if (isErr(batchId)) return batchId;

  let additionalExpectedCount: number | null = null;
  if (source.additionalExpectedCount !== undefined && source.additionalExpectedCount !== null) {
    const parsed = requireInt(source, "additionalExpectedCount", "additionalExpectedCount", 1, MAX_ASSETS_PER_BATCH);
    if (isErr(parsed)) return parsed;
    additionalExpectedCount = parsed.value;
  }

  const rawAssets = source.assets;
  if (!Array.isArray(rawAssets)) return err("INVALID_INPUT", "assets must be an array", "assets");
  if (rawAssets.length === 0) return err("INVALID_INPUT", "assets must not be empty", "assets");
  if (rawAssets.length > MAX_UPLOAD_REQUEST_CHUNK) {
    return err(
      "CHUNK_TOO_LARGE",
      `assets must contain at most ${MAX_UPLOAD_REQUEST_CHUNK} items per request`,
      "assets",
    );
  }

  const assets: ValidatedUploadAssetRequest[] = [];
  const seenClientAssetIds = new Set<string>();
  const seenProcessedHashes = new Set<string>();

  for (let index = 0; index < rawAssets.length; index += 1) {
    const field = `assets[${index}]`;
    const item = asRecord(rawAssets[index], field);
    if (isErr(item)) return item;

    const clientAssetId = requireString(item.value, "clientAssetId", `${field}.clientAssetId`, 200);
    if (isErr(clientAssetId)) return clientAssetId;
    if (seenClientAssetIds.has(clientAssetId.value)) {
      return err("INVALID_INPUT", `${field}.clientAssetId is duplicated within the request`, `${field}.clientAssetId`);
    }
    seenClientAssetIds.add(clientAssetId.value);

    const fileName = requireString(item.value, "fileName", `${field}.fileName`, 255);
    if (isErr(fileName)) return fileName;

    const processed = validateDeclaredObject(
      item.value.processed,
      `${field}.processed`,
      allowedProcessedMimeTypes(sourceType),
      MAX_PROCESSED_BYTES,
    );
    if (isErr(processed)) return processed;

    const thumbnail = validateDeclaredObject(
      item.value.thumbnail,
      `${field}.thumbnail`,
      THUMBNAIL_MIME_TYPES,
      MAX_THUMBNAIL_BYTES,
    );
    if (isErr(thumbnail)) return thumbnail;

    if (seenProcessedHashes.has(processed.value.sha256)) {
      return err(
        "INVALID_INPUT",
        `${field}.processed.sha256 is duplicated within the request`,
        `${field}.processed.sha256`,
      );
    }
    seenProcessedHashes.add(processed.value.sha256);

    assets.push({
      clientAssetId: clientAssetId.value,
      fileName: fileName.value,
      declared: { PROCESSED: processed.value, THUMBNAIL: thumbnail.value },
    });
  }

  return ok({ batchId: batchId.value, sourceType, assets, additionalExpectedCount });
}

// ─────────────────────────────────────────────────────────────────────────
// completePhotoAssetUpload (§7.3 / §5.5 / §91)
// ─────────────────────────────────────────────────────────────────────────

export interface ValidatedVariantCompletion {
  sha256: string;
  fileSize: number;
  width: number;
  height: number;
}

export interface ValidatedCompleteAssetUpload {
  photoAssetId: string;
  completions: Record<PhotoAssetVariant, ValidatedVariantCompletion>;
  processingVersion: string | null;
}

function validateVariantCompletion(
  input: unknown,
  field: string,
  maxBytes: number,
): PhotoResult<ValidatedVariantCompletion> {
  const record = asRecord(input, field);
  if (isErr(record)) return record;
  const source = record.value;

  const sha256 = requireSha256(source, "sha256", `${field}.sha256`);
  if (isErr(sha256)) return sha256;
  const fileSize = requireInt(source, "fileSize", `${field}.fileSize`, 1, maxBytes);
  if (isErr(fileSize)) return fileSize;
  const width = requireInt(source, "width", `${field}.width`, 1, MAX_IMAGE_DIMENSION);
  if (isErr(width)) return width;
  const height = requireInt(source, "height", `${field}.height`, 1, MAX_IMAGE_DIMENSION);
  if (isErr(height)) return height;

  return ok({ sha256: sha256.value, fileSize: fileSize.value, width: width.value, height: height.value });
}

export function validateCompleteAssetUploadInput(input: unknown): PhotoResult<ValidatedCompleteAssetUpload> {
  const record = asRecord(input, "input");
  if (isErr(record)) return record;
  const source = record.value;

  const photoAssetId = requireString(source, "photoAssetId", "photoAssetId", 100);
  if (isErr(photoAssetId)) return photoAssetId;

  const processed = validateVariantCompletion(source.processed, "processed", MAX_PROCESSED_BYTES);
  if (isErr(processed)) return processed;
  const thumbnail = validateVariantCompletion(source.thumbnail, "thumbnail", MAX_THUMBNAIL_BYTES);
  if (isErr(thumbnail)) return thumbnail;

  const processingVersion = optionalString(source, "processingVersion", "processingVersion", 50);
  if (isErr(processingVersion)) return processingVersion;

  return ok({
    photoAssetId: photoAssetId.value,
    completions: { PROCESSED: processed.value, THUMBNAIL: thumbnail.value },
    processingVersion: processingVersion.value,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// completePhotoBatch (§7.4 / §29)
// ─────────────────────────────────────────────────────────────────────────

export interface ValidatedCompletePhotoBatch {
  batchId: string;
  /** クライアントが主張する枚数。サーバー側のmanifestと突き合わせるためだけに使い、これで上書きしない。 */
  imageCountProcessed: number;
  imageCountUploaded: number;
}

export function validateCompletePhotoBatchInput(input: unknown): PhotoResult<ValidatedCompletePhotoBatch> {
  const record = asRecord(input, "input");
  if (isErr(record)) return record;
  const source = record.value;

  const batchId = requireString(source, "batchId", "batchId", 100);
  if (isErr(batchId)) return batchId;
  const imageCountProcessed = requireInt(source, "imageCountProcessed", "imageCountProcessed", 0, MAX_ASSETS_PER_BATCH);
  if (isErr(imageCountProcessed)) return imageCountProcessed;
  const imageCountUploaded = requireInt(source, "imageCountUploaded", "imageCountUploaded", 0, MAX_ASSETS_PER_BATCH);
  if (isErr(imageCountUploaded)) return imageCountUploaded;

  return ok({
    batchId: batchId.value,
    imageCountProcessed: imageCountProcessed.value,
    imageCountUploaded: imageCountUploaded.value,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// link / delete / restore (§18 / §12 / §68)
// ─────────────────────────────────────────────────────────────────────────

/** 実行主体 (actorId/role) は含めない — PhotoActorContext として認証側から渡す。 */
export interface ValidatedLinkBatchToInventory {
  batchId: string;
  inventoryId: string;
}

export function validateLinkBatchToInventoryInput(input: unknown): PhotoResult<ValidatedLinkBatchToInventory> {
  const record = asRecord(input, "input");
  if (isErr(record)) return record;
  const source = record.value;

  const batchId = requireString(source, "batchId", "batchId", 100);
  if (isErr(batchId)) return batchId;
  const inventoryId = requireString(source, "inventoryId", "inventoryId", 100);
  if (isErr(inventoryId)) return inventoryId;
  return ok({ batchId: batchId.value, inventoryId: inventoryId.value });
}

/** 同上。削除・復元の権限判定は PhotoActorContext.role で行う。 */
export interface ValidatedAssetMutation {
  photoAssetId: string;
}

export function validateAssetMutationInput(input: unknown): PhotoResult<ValidatedAssetMutation> {
  const record = asRecord(input, "input");
  if (isErr(record)) return record;
  const source = record.value;

  const photoAssetId = requireString(source, "photoAssetId", "photoAssetId", 100);
  if (isErr(photoAssetId)) return photoAssetId;

  return ok({ photoAssetId: photoAssetId.value });
}

// ─────────────────────────────────────────────────────────────────────────
// Listing画像選択 (§21 / §22 / §45)
// ─────────────────────────────────────────────────────────────────────────

export interface ValidatedListingImageSelection {
  listingId: string;
  /** 選択順 = 出品順。index 0 がメイン画像 (§45「1枚目 = メイン」)。 */
  photoAssetIds: string[];
}

/**
 * チャネル上限 (§22) は契約側にハードコードせず、呼び出し元が設定値として渡す。
 * 各ECのAPI仕様が未確定なため、上限を定数化すると変更のたびにこの層を触ることになる。
 */
export function validateListingImageSelectionInput(
  input: unknown,
  options: { maxImages: number },
): PhotoResult<ValidatedListingImageSelection> {
  const record = asRecord(input, "input");
  if (isErr(record)) return record;
  const source = record.value;

  const listingId = requireString(source, "listingId", "listingId", 100);
  if (isErr(listingId)) return listingId;

  const rawIds = source.photoAssetIds;
  if (!Array.isArray(rawIds)) return err("INVALID_INPUT", "photoAssetIds must be an array", "photoAssetIds");
  // 0件は「この出品では画像を使わない」という正当な選択 (既存の下書き画像を使う場合を含む)。
  if (rawIds.length > options.maxImages) {
    return err(
      "CHANNEL_IMAGE_LIMIT_EXCEEDED",
      `photoAssetIds must contain at most ${options.maxImages} items for this channel`,
      "photoAssetIds",
    );
  }

  const photoAssetIds: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < rawIds.length; index += 1) {
    const field = `photoAssetIds[${index}]`;
    const raw = rawIds[index];
    if (typeof raw !== "string" || raw.trim().length === 0) {
      return err("INVALID_INPUT", `${field} must be a non-empty string`, field);
    }
    const id = raw.trim();
    // 同じ画像を2回選ぶと出品側で枚数と順序が破綻する。
    if (seen.has(id)) return err("INVALID_INPUT", `${field} is duplicated`, field);
    seen.add(id);
    photoAssetIds.push(id);
  }

  return ok({ listingId: listingId.value, photoAssetIds });
}
