/**
 * 画像登録基盤 Phase 1 — DynamoDB単一テーブル設計のキー生成 (純粋)。
 *
 * lib/photoRegistration/awsRepository.ts (実装) と
 * scripts/verify-photo-registration-api.ts (試験) の両方が、同じキー規則を
 * 共有する必要があるため、ここへ集約する。AWS SDKへは依存しない。
 *
 * 【設計判断: photoAssetIdへbatchIdを埋め込む】
 * completePhotoAssetUpload / deletePhotoAsset / restorePhotoAsset の入力は
 * `photoAssetId` のみで `batchId` を含まない (docs/photo-registration-api-v1.md
 * §3.3/3.6)。単一テーブルでPhotoAssetの物理キーを `PK=BATCH#<batchId>,
 * SK=ASSET#<seq>#<assetId>` にすると、batchIdが分からない限りGetItemできない。
 * 逆引き用GSIを増やす代わりに、採番の時点で `photoAssetId` 自体へ
 * `<batchId>#A#<ulid>` の形でbatchIdを埋め込む。これにより
 * `parseBatchIdFromPhotoAssetId` だけでGetItem対象のPKが確定し、追加の
 * GSI・追加の結果整合な読み取りが不要になる。
 */

const BATCH_ASSET_SEPARATOR = "#A#";

/** DynamoDBの単一テーブルにおける論理エンティティの物理キー。 */
export interface TableKey {
  PK: string;
  SK: string;
}

export function batchKey(batchId: string): TableKey {
  return { PK: `BATCH#${batchId}`, SK: `BATCH#${batchId}` };
}

/** SESSION#<id> は types.ts の batchIdempotencyKey と同じ文字列にする (契約上の決定的キー)。 */
export function sessionIdempotencyKey(sessionId: string): TableKey {
  return { PK: `SESSION#${sessionId}`, SK: `SESSION#${sessionId}` };
}

/**
 * sequenceは6桁ゼロ埋め (300枚上限に対して十分な桁数)。
 * begins_with("ASSET#") のQueryがsequence順に返るようにするための文字列ソート用。
 */
function paddedSequence(sequence: number): string {
  return String(sequence).padStart(6, "0");
}

export function assetKey(batchId: string, sequence: number, photoAssetId: string): TableKey {
  return { PK: `BATCH#${batchId}`, SK: `ASSET#${paddedSequence(sequence)}#${photoAssetId}` };
}

export function assetPrefix(batchId: string): { PK: string; skPrefix: string } {
  return { PK: `BATCH#${batchId}`, skPrefix: "ASSET#" };
}

/** requestPhotoAssetUploadsの新規Asset作成を排他するための冪等ガード行 (state.ts AtomicCondition #2)。 */
export function assetClientIdempotencyKey(batchId: string, clientAssetId: string): TableKey {
  return { PK: `BATCH#${batchId}`, SK: `ASSETIDX#CLIENT#${clientAssetId}` };
}

/** 同一batch内のsha256重複検出を排他するための行 (state.ts AtomicCondition #2, §31)。 */
export function assetHashIdempotencyKey(batchId: string, sha256Processed: string): TableKey {
  return { PK: `BATCH#${batchId}`, SK: `ASSETIDX#HASH#${sha256Processed}` };
}

export function listingSelectionStateKey(listingId: string): TableKey {
  return { PK: `LISTING#${listingId}`, SK: "SELECTION_STATE" };
}

export function listingSelectionRowKey(listingId: string, sequence: number, photoAssetId: string): TableKey {
  return { PK: `LISTING#${listingId}`, SK: `SELECTION_ROW#${paddedSequence(sequence)}#${photoAssetId}` };
}

export function listingSelectionRowPrefix(listingId: string): { PK: string; skPrefix: string } {
  return { PK: `LISTING#${listingId}`, skPrefix: "SELECTION_ROW#" };
}

/**
 * GSI1: 未登録一覧 (§4.5 byStatusUploadedAt)。
 * PhotoBatch項目にのみ設定する。他エンティティはGSI1PKを持たせず、
 * このインデックスへ紛れ込ませない。
 */
export function batchStatusIndexKey(status: string, uploadedAtOrCreatedAt: string, batchId: string): { GSI1PK: string; GSI1SK: string } {
  return { GSI1PK: `BATCH_STATUS#${status}`, GSI1SK: `${uploadedAtOrCreatedAt}#${batchId}` };
}

/** GSI2: Inventoryに紐づくPhotoBatch一覧 (§4.5 byInventoryLinkedAt)。linkPhotoBatchToInventory成立時のみ付与する。 */
export function batchInventoryIndexKey(inventoryId: string, linkedAt: string, batchId: string): { GSI2PK: string; GSI2SK: string } {
  return { GSI2PK: `BATCH_INVENTORY#${inventoryId}`, GSI2SK: `${linkedAt}#${batchId}` };
}

/** photoAssetIdの採番。batchIdを埋め込むことでGetItem時にbatchIdの再入力を不要にする (ファイル冒頭コメント参照)。 */
export function allocatePhotoAssetId(batchId: string, ulid: string): string {
  return `${batchId}${BATCH_ASSET_SEPARATOR}${ulid}`;
}

export function parseBatchIdFromPhotoAssetId(photoAssetId: string): string | null {
  const index = photoAssetId.indexOf(BATCH_ASSET_SEPARATOR);
  if (index <= 0) return null;
  return photoAssetId.slice(0, index);
}
