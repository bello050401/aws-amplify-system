/**
 * 画像登録基盤 Phase 1 — 契約・状態遷移の合成試験。
 *
 * 実行:
 *   node scripts/qa/run-verify-with-server-only-noop.cjs scripts/verify-photo-registration-contract.ts
 *
 * 【この試験が示すこと / 示さないこと】
 * 示すこと: lib/photoRegistration/{types,validation,state}.ts が、正本
 * 「自社システム画像登録機能.txt」の境界値・不正入力・再送・競合の**契約**に
 * 対して意図した判断を返すこと。
 *
 * 示さないこと (重要):
 * - DynamoDBの条件付き書込み / TransactWriteItems が実際に原子的に効くこと。
 *   ここでのstateは素のJSオブジェクトで、直列に更新している。競合の防止は
 *   decide* が返す conditions を永続化層が実装して初めて成立する。
 *   本ファイルは「conditionsが宣言されていること」までしか確認していない。
 * - S3にオブジェクトが本当に存在すること。HEADの結果は ObservedS3Object として
 *   合成値を渡しているだけで、S3へは一切アクセスしない。
 * - AppSync / Cognito / IAM の権限。未実装。
 *
 * AWS・ネットワーク・既存データには一切触れない。
 */

import assert from "node:assert/strict";
import {
  MAX_ASSETS_PER_BATCH,
  MAX_PROCESSED_BYTES,
  MAX_UPLOAD_REQUEST_CHUNK,
  photoAssetS3Key,
  type ObservedS3Object,
  type PhotoAssetVariant,
  type PhotoAssetView,
  type PhotoBatchView,
  type PhotoErrorCode,
  type PhotoResult,
} from "../lib/photoRegistration/types";
import {
  validateCompleteAssetUploadInput,
  validateCompletePhotoBatchInput,
  validateCreatePhotoBatchInput,
  validateLinkBatchToInventoryInput,
  validateListingImageSelectionInput,
  validateRequestUploadsInput,
} from "../lib/photoRegistration/validation";
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
  type RequestUploadsDecision,
} from "../lib/photoRegistration/state";

// ─────────────────────────────────────────────────────────────────────────
// ごく小さなテストランナー
// ─────────────────────────────────────────────────────────────────────────

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}\n    ${(error as Error).message.split("\n")[0]}`);
  }
}

function expectOk<T>(result: PhotoResult<T>, label: string): T {
  assert.ok(result.ok, `${label}: expected ok, got ${result.ok ? "" : `${result.error} (${result.message})`}`);
  return result.value;
}

function expectErr(result: PhotoResult<unknown>, code: PhotoErrorCode, label: string): void {
  assert.equal(result.ok, false, `${label}: expected ${code}, got ok`);
  if (!result.ok) assert.equal(result.error, code, `${label}: expected ${code}, got ${result.error}`);
}

// ─────────────────────────────────────────────────────────────────────────
// 合成データ (すべてローカル。実在の在庫・画像・S3キーは一切使わない)
// ─────────────────────────────────────────────────────────────────────────

const BATCH_ID = "batch-TEST0001";
const INVENTORY_ID = "inv-TEST0001";

/** 決定的なダミーsha256 (小文字hex 64桁)。 */
function hash(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

interface RequestItemOverrides {
  clientAssetId?: string;
  fileName?: string;
  processed?: Partial<{ mimeType: unknown; fileSize: unknown; sha256: unknown }>;
  thumbnail?: Partial<{ mimeType: unknown; fileSize: unknown; sha256: unknown }>;
}

function requestItem(seed: number, overrides: RequestItemOverrides = {}): Record<string, unknown> {
  return {
    clientAssetId: overrides.clientAssetId ?? `client-${seed}`,
    fileName: overrides.fileName ?? `DSC0${seed}.JPG`,
    processed: { mimeType: "image/jpeg", fileSize: 1_200_000, sha256: hash(seed), ...overrides.processed },
    thumbnail: { mimeType: "image/jpeg", fileSize: 40_000, sha256: hash(seed + 1_000_000), ...overrides.thumbnail },
  };
}

interface World {
  batch: PhotoBatchView;
  assets: PhotoAssetView[];
  /** PhotoAsset行が持つ想定の参照カウンタ (§68)。ListingImageSelectionのGSI逆引きではない。 */
  refCounts: Map<string, number>;
  nextAssetSerial: number;
}

function newWorld(batchOverrides: Partial<PhotoBatchView> = {}): World {
  return {
    batch: {
      id: BATCH_ID,
      batchCode: "PHOTO-20260916-0001",
      status: "CREATED",
      localImportSessionId: "DESKTOP01-SD02-20260916T103200",
      sourceDeviceId: "BELLO-PHOTO-PC-01",
      sourceSdCardId: "SD-A",
      clientVersion: "1.0.0",
      manifest: { expectedAssetCount: 0, originalExpectedAssetCount: 0, registeredAssetCount: 0, completedAssetCount: 0, failedAssetCount: 0, revision: 0, openRevision: null },
      inventoryId: null,
      ...batchOverrides,
    },
    assets: [],
    refCounts: new Map(),
    nextAssetSerial: 0,
  };
}

/**
 * 決定オブジェクトを合成stateへ適用する。
 * **DynamoDBではない**: 条件付き書込みも並行性も無い、単なる逐次更新。
 */
function applyRequestUploads(
  world: World,
  decision: RequestUploadsDecision,
  sourceType: "PHOTO_STATION" | "WEB_UPLOAD",
): void {
  for (const item of decision.items) {
    if (item.kind !== "CREATE_ASSET") continue;
    world.assets.push({
      id: item.photoAssetId,
      photoBatchId: decision.batchId,
      clientAssetId: item.clientAssetId,
      sequence: item.sequence,
      status: "UPLOADING",
      isDeleted: false,
      statusBeforeDelete: null,
      sourceType,
      declared: item.declared,
      revision: item.revision,
    });
    world.refCounts.set(item.photoAssetId, 0);
  }
  world.batch.manifest.expectedAssetCount += decision.manifestDelta.expected;
  world.batch.manifest.registeredAssetCount += decision.manifestDelta.registered;
  world.nextAssetSerial += decision.manifestDelta.registered;
  if (decision.nextBatchStatus) world.batch.status = decision.nextBatchStatus;
  if (decision.opensRevision) {
    world.batch.manifest.openRevision = { revision: decision.revision, expectedDelta: decision.manifestDelta.expected };
  }
}

/** 25件ずつのchunkに割ってuploadを要求する (§7.5)。1回のMutationへ300件入れない。 */
function uploadAssets(
  world: World,
  seeds: number[],
  sourceType: "PHOTO_STATION" | "WEB_UPLOAD" = "PHOTO_STATION",
): void {
  // createPhotoBatchで予定枚数を固定する挙動の再現。requestUploadsでは増えない。
  if (world.batch.manifest.expectedAssetCount === 0 && world.batch.manifest.registeredAssetCount === 0) {
    world.batch.manifest.expectedAssetCount = seeds.length;
  }
  for (let offset = 0; offset < seeds.length; offset += MAX_UPLOAD_REQUEST_CHUNK) {
    const chunk = seeds.slice(offset, offset + MAX_UPLOAD_REQUEST_CHUNK);
    const input = expectOk(
      validateRequestUploadsInput({ batchId: world.batch.id, assets: chunk.map((s) => requestItem(s)) }, sourceType),
      "uploadAssets/validate",
    );
    const decision = expectOk(
      decideRequestUploads(input, {
        batch: world.batch,
        assets: world.assets,
        allocateAssetId: (index) => `asset-${world.nextAssetSerial + index}`,
      }),
      "uploadAssets/decide",
    );
    applyRequestUploads(world, decision, sourceType);
  }
}

function completionInput(asset: PhotoAssetView, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    photoAssetId: asset.id,
    processed: { sha256: asset.declared.PROCESSED.sha256, fileSize: asset.declared.PROCESSED.fileSize, width: 3000, height: 2000 },
    thumbnail: { sha256: asset.declared.THUMBNAIL.sha256, fileSize: asset.declared.THUMBNAIL.fileSize, width: 400, height: 267 },
    processingVersion: "lightroom-v1",
    ...overrides,
  };
}

/** S3 HEADの成功結果を合成する。実際のHEADは行わない。 */
function observedFor(asset: PhotoAssetView, mutate?: (o: ObservedS3Object) => ObservedS3Object): ObservedS3Object[] {
  const variants: PhotoAssetVariant[] = ["PROCESSED", "THUMBNAIL"];
  return variants.map((variant) => {
    const declared = asset.declared[variant];
    const base: ObservedS3Object = {
      variant,
      exists: true,
      contentLength: declared.fileSize,
      sha256: declared.sha256,
      contentType: declared.mimeType,
    };
    return mutate ? mutate(base) : base;
  });
}

function completeAsset(world: World, asset: PhotoAssetView): void {
  const input = expectOk(validateCompleteAssetUploadInput(completionInput(asset)), "completeAsset/validate");
  const decision = expectOk(
    decideCompleteAssetUpload(input, { batch: world.batch, asset, observed: observedFor(asset) }),
    "completeAsset/decide",
  );
  if (decision.kind !== "MARK_READY") return;
  asset.status = "READY";
  world.batch.manifest.completedAssetCount += decision.manifestDelta.completed;
}

function completeAllUploading(world: World): void {
  for (const asset of world.assets) {
    if (asset.status === "UPLOADING" && !asset.isDeleted) completeAsset(world, asset);
  }
}

function finalize(world: World): PhotoResult<unknown> {
  const input = expectOk(
    validateCompletePhotoBatchInput({
      batchId: world.batch.id,
      imageCountProcessed: world.batch.manifest.expectedAssetCount,
      imageCountUploaded: world.batch.manifest.expectedAssetCount,
    }),
    "finalize/validate",
  );
  const decision = decideCompletePhotoBatch(input, world.batch);
  if (decision.ok && decision.value.kind === "MARK_READY_FOR_REVIEW") {
    world.batch.status = "READY_FOR_REVIEW";
    if (decision.value.closesRevision !== null) world.batch.manifest.revision = decision.value.closesRevision;
    world.batch.manifest.openRevision = null;
  }
  return decision;
}

/** "inv-UNKNOWN" だけを「存在しない在庫」として扱う。それ以外は実在する別商品。 */
function linkTo(world: World, inventoryId = INVENTORY_ID): PhotoResult<unknown> {
  const input = expectOk(
    validateLinkBatchToInventoryInput({ batchId: world.batch.id, inventoryId }),
    "link/validate",
  );
  const decision = decideLinkBatchToInventory(input, {
    batch: world.batch,
    inventory: { id: inventoryId, exists: inventoryId !== "inv-UNKNOWN", isDeleted: inventoryId === "inv-DELETED" },
  });
  if (decision.ok) {
    world.batch.status = "LINKED";
    world.batch.inventoryId = inventoryId;
  }
  return decision;
}

/** 0枚→finalizeまで通す定型。返り値は完成したworld。 */
function reviewedBatch(count: number): World {
  const world = newWorld();
  uploadAssets(world, Array.from({ length: count }, (_, i) => i + 1));
  completeAllUploading(world);
  expectOk(finalize(world), `reviewedBatch(${count})/finalize`);
  return world;
}

// ─────────────────────────────────────────────────────────────────────────
// 1. createPhotoBatch — 入力検証と冪等性 (§7.1 / §8 / §30)
// ─────────────────────────────────────────────────────────────────────────

test("createPhotoBatch: 必須入力の欠落・型不正を拒否", () => {
  expectErr(validateCreatePhotoBatchInput(null), "INVALID_INPUT", "null");
  expectErr(validateCreatePhotoBatchInput({ imageCountOriginal: 1 }), "INVALID_INPUT", "sessionId欠落");
  expectErr(validateCreatePhotoBatchInput({ localImportSessionId: "   ", imageCountOriginal: 1 }), "INVALID_INPUT", "空白のみ");
  expectErr(
    validateCreatePhotoBatchInput({ localImportSessionId: "s1", imageCountOriginal: "24" }),
    "INVALID_INPUT",
    "数値文字列",
  );
  expectErr(
    validateCreatePhotoBatchInput({ localImportSessionId: "s1", imageCountOriginal: 1.5 }),
    "INVALID_INPUT",
    "小数",
  );
  expectErr(
    validateCreatePhotoBatchInput({ localImportSessionId: "s1", imageCountOriginal: -1 }),
    "INVALID_INPUT",
    "負数",
  );
  expectErr(
    validateCreatePhotoBatchInput({ localImportSessionId: "s1", imageCountOriginal: MAX_ASSETS_PER_BATCH + 1 }),
    "INVALID_INPUT",
    "301枚宣言",
  );
});

test("createPhotoBatch: 0枚の取込要求自体は受け付ける (§79 SD差分0枚)", () => {
  const validated = expectOk(
    validateCreatePhotoBatchInput({ localImportSessionId: "s-empty", imageCountOriginal: 0, expectedAssetCount: 0 }),
    "0枚",
  );
  assert.equal(validated.imageCountOriginal, 0);
  assert.equal(validated.expectedAssetCount, 0);
});

test("createPhotoBatch: expectedAssetCountは必須で0〜300、imageCountOriginalを超えない (§7.6)", () => {
  expectErr(
    validateCreatePhotoBatchInput({ localImportSessionId: "s-cap0", imageCountOriginal: 24 }),
    "INVALID_INPUT",
    "expectedAssetCount欠落",
  );
  expectErr(
    validateCreatePhotoBatchInput({ localImportSessionId: "s-cap1", imageCountOriginal: 24, expectedAssetCount: 25 }),
    "INVALID_INPUT",
    "originalを超える予定",
  );
  expectErr(
    validateCreatePhotoBatchInput({ localImportSessionId: "s-cap2", imageCountOriginal: 300, expectedAssetCount: -1 }),
    "INVALID_INPUT",
    "負の予定枚数",
  );
  expectErr(
    validateCreatePhotoBatchInput({ localImportSessionId: "s-cap3", imageCountOriginal: 300, expectedAssetCount: MAX_ASSETS_PER_BATCH + 1 }),
    "INVALID_INPUT",
    "301枚予定",
  );
  const ok300 = expectOk(
    validateCreatePhotoBatchInput({ localImportSessionId: "s-cap4", imageCountOriginal: 300, expectedAssetCount: 300 }),
    "300枚予定ちょうど (原本枚数と一致してもよい)",
  );
  assert.equal(ok300.expectedAssetCount, 300);
});

test("createPhotoBatch: 新規は決定的な冪等キーへの条件付きPutを要求する (§93.5 ケースB)", () => {
  const input = expectOk(
    validateCreatePhotoBatchInput({ localImportSessionId: "s-1", sourceDeviceId: "PC-01", sourceSdCardId: "SD-A", imageCountOriginal: 24, expectedAssetCount: 24 }),
    "validate",
  );
  const decision = expectOk(decideCreatePhotoBatch(input, null), "decide");
  assert.equal(decision.kind, "CREATE_BATCH");
  assert.equal(decision.conditions.length, 1);
  assert.match(decision.conditions[0].predicate, /attribute_not_exists/);
  assert.equal(decision.conditions[0].target, "PhotoIdempotency#SESSION#s-1");
});

test("createPhotoBatch: 同一sessionIdの再送は既存batchを返す (§30)", () => {
  const world = newWorld({ localImportSessionId: "s-1", sourceDeviceId: "PC-01", sourceSdCardId: "SD-A" });
  const input = expectOk(
    validateCreatePhotoBatchInput({ localImportSessionId: "s-1", sourceDeviceId: "PC-01", sourceSdCardId: "SD-A", imageCountOriginal: 24, expectedAssetCount: 0 }),
    "validate",
  );
  const decision = expectOk(decideCreatePhotoBatch(input, world.batch), "decide");
  assert.equal(decision.kind, "RETURN_EXISTING");
  assert.equal(decision.kind === "RETURN_EXISTING" ? decision.batchId : "", BATCH_ID);
});

test("createPhotoBatch: 同一sessionIdで内容が違えばIDEMPOTENCY_CONFLICT", () => {
  const world = newWorld({ localImportSessionId: "s-1", sourceDeviceId: "PC-01", sourceSdCardId: "SD-A" });
  const input = expectOk(
    validateCreatePhotoBatchInput({ localImportSessionId: "s-1", sourceDeviceId: "PC-01", sourceSdCardId: "SD-B", imageCountOriginal: 24, expectedAssetCount: 0 }),
    "validate",
  );
  expectErr(decideCreatePhotoBatch(input, world.batch), "IDEMPOTENCY_CONFLICT", "別SD");
});

test("createPhotoBatch: 同一sessionIdでexpectedAssetCountが変わればIDEMPOTENCY_CONFLICT (§7.6 予定枚数固定)", () => {
  const world = newWorld({
    localImportSessionId: "s-plan",
    sourceDeviceId: "PC-01",
    sourceSdCardId: "SD-A",
    manifest: { expectedAssetCount: 300, originalExpectedAssetCount: 300, registeredAssetCount: 0, completedAssetCount: 0, failedAssetCount: 0, revision: 0, openRevision: null },
  });
  const input = expectOk(
    validateCreatePhotoBatchInput({ localImportSessionId: "s-plan", sourceDeviceId: "PC-01", sourceSdCardId: "SD-A", imageCountOriginal: 300, expectedAssetCount: 250 }),
    "validate",
  );
  expectErr(decideCreatePhotoBatch(input, world.batch), "IDEMPOTENCY_CONFLICT", "予定枚数の後出し変更");
});

test("createPhotoBatch: 追加upload revisionでexpectedAssetCountが増減した後も、元のcreate要求の再送はoriginalExpectedAssetCountと比較する (§7.6 / §13)", () => {
  // revision 0で20枚予定として作成し、追加upload (revision 1) で2枚積んだ状態を再現する。
  // expectedAssetCountは 20 -> 22 に増えるが、originalExpectedAssetCountは作成時の20のまま。
  const world = newWorld({
    localImportSessionId: "s-revised",
    sourceDeviceId: "PC-01",
    sourceSdCardId: "SD-A",
    manifest: {
      expectedAssetCount: 22,
      originalExpectedAssetCount: 20,
      registeredAssetCount: 22,
      completedAssetCount: 22,
      failedAssetCount: 0,
      revision: 1,
      openRevision: null,
    },
  });

  // 元のcreatePhotoBatch要求そのものの再送 (expectedAssetCount=20) は、
  // revisionが進んでいても既存batchを返す (追加/削除が正しい再送を巻き込んで拒否してはいけない)。
  const resendOriginal = expectOk(
    validateCreatePhotoBatchInput({
      localImportSessionId: "s-revised",
      sourceDeviceId: "PC-01",
      sourceSdCardId: "SD-A",
      imageCountOriginal: 20,
      expectedAssetCount: 20,
    }),
    "validate/original",
  );
  const decision = expectOk(decideCreatePhotoBatch(resendOriginal, world.batch), "decide/original再送");
  assert.equal(decision.kind, "RETURN_EXISTING");

  // revision後の現在値(22)を送っても、それはcreate要求の初回値ではないので拒否する。
  const wrongCurrent = expectOk(
    validateCreatePhotoBatchInput({
      localImportSessionId: "s-revised",
      sourceDeviceId: "PC-01",
      sourceSdCardId: "SD-A",
      imageCountOriginal: 22,
      expectedAssetCount: 22,
    }),
    "validate/current値",
  );
  expectErr(decideCreatePhotoBatch(wrongCurrent, world.batch), "IDEMPOTENCY_CONFLICT", "revision後のcurrent値をcreateへ送る");

  // 無関係な値も同様に拒否する。
  const unrelated = expectOk(
    validateCreatePhotoBatchInput({
      localImportSessionId: "s-revised",
      sourceDeviceId: "PC-01",
      sourceSdCardId: "SD-A",
      imageCountOriginal: 300,
      expectedAssetCount: 99,
    }),
    "validate/無関係値",
  );
  expectErr(decideCreatePhotoBatch(unrelated, world.batch), "IDEMPOTENCY_CONFLICT", "無関係な予定枚数");
});

test("createPhotoBatch: clientVersionの差は再送中の更新としてCONFLICTにしない", () => {
  const world = newWorld({ localImportSessionId: "s-1", sourceDeviceId: "PC-01", sourceSdCardId: "SD-A", clientVersion: "1.0.0" });
  const input = expectOk(
    validateCreatePhotoBatchInput({ localImportSessionId: "s-1", sourceDeviceId: "PC-01", sourceSdCardId: "SD-A", clientVersion: "1.1.0", imageCountOriginal: 24, expectedAssetCount: 0 }),
    "validate",
  );
  assert.equal(expectOk(decideCreatePhotoBatch(input, world.batch), "decide").kind, "RETURN_EXISTING");
});

// ─────────────────────────────────────────────────────────────────────────
// 2. requestPhotoAssetUploads — chunk境界と不正入力 (§7.5 / §74 / §75)
// ─────────────────────────────────────────────────────────────────────────

test("requestUploads: chunkは1〜25件。0件はINVALID_INPUT、26件はCHUNK_TOO_LARGE", () => {
  // sourceTypeはrequest本体ではなく、認証済みコンテキストから第2引数で渡す (§36 信頼境界)。
  const base = { batchId: BATCH_ID };
  expectErr(validateRequestUploadsInput({ ...base, assets: [] }, "PHOTO_STATION"), "INVALID_INPUT", "0件");
  expectOk(
    validateRequestUploadsInput({ ...base, assets: Array.from({ length: 25 }, (_, i) => requestItem(i + 1)) }, "PHOTO_STATION"),
    "25件",
  );
  expectErr(
    validateRequestUploadsInput({ ...base, assets: Array.from({ length: 26 }, (_, i) => requestItem(i + 1)) }, "PHOTO_STATION"),
    "CHUNK_TOO_LARGE",
    "26件",
  );
});

test("requestUploads: サイズ境界 (0 byte / 25MB超)", () => {
  const base = { batchId: BATCH_ID };
  expectErr(
    validateRequestUploadsInput({ ...base, assets: [requestItem(1, { processed: { fileSize: 0 } })] }, "PHOTO_STATION"),
    "INVALID_INPUT",
    "0 byte",
  );
  expectErr(
    validateRequestUploadsInput({ ...base, assets: [requestItem(1, { processed: { fileSize: MAX_PROCESSED_BYTES + 1 } })] }, "PHOTO_STATION"),
    "INVALID_INPUT",
    "25MB超",
  );
  expectOk(
    validateRequestUploadsInput({ ...base, assets: [requestItem(1, { processed: { fileSize: MAX_PROCESSED_BYTES } })] }, "PHOTO_STATION"),
    "ちょうど25MB",
  );
});

test("requestUploads: checksumは小文字hex 64桁のみ", () => {
  const base = { batchId: BATCH_ID };
  // hash(255) は "ff" で終わるので大文字化すると実際に別文字列になる (hash(1)だと数字のみで変化しない)。
  for (const bad of [hash(255).toUpperCase(), hash(1).slice(0, 63), `${hash(1)}0`, "", 12345, null]) {
    expectErr(
      validateRequestUploadsInput({ ...base, assets: [requestItem(1, { processed: { sha256: bad } })] }, "PHOTO_STATION"),
      "INVALID_INPUT",
      `sha256=${String(bad).slice(0, 12)}`,
    );
  }
});

test("requestUploads: MIME制限 — Photo StationのprocessedはJPEGのみ、thumbnailは常にJPEG (§74)", () => {
  const station = { batchId: BATCH_ID };
  const web = { batchId: BATCH_ID };
  expectErr(
    validateRequestUploadsInput({ ...station, assets: [requestItem(1, { processed: { mimeType: "image/png" } })] }, "PHOTO_STATION"),
    "INVALID_INPUT",
    "station/png",
  );
  expectErr(
    validateRequestUploadsInput({ ...station, assets: [requestItem(1, { processed: { mimeType: "application/pdf" } })] }, "PHOTO_STATION"),
    "INVALID_INPUT",
    "pdf",
  );
  expectErr(
    validateRequestUploadsInput({ ...station, assets: [requestItem(1, { processed: { mimeType: "image/x-canon-cr2" } })] }, "PHOTO_STATION"),
    "INVALID_INPUT",
    "RAW",
  );
  expectOk(
    validateRequestUploadsInput({ ...web, assets: [requestItem(1, { processed: { mimeType: "image/png" } })] }, "WEB_UPLOAD"),
    "web/png",
  );
  expectErr(
    validateRequestUploadsInput({ ...web, assets: [requestItem(1, { thumbnail: { mimeType: "image/png" } })] }, "WEB_UPLOAD"),
    "INVALID_INPUT",
    "thumbnail/png",
  );
});

test("requestUploads: chunk内のclientAssetId重複・sha256重複は自己矛盾として拒否", () => {
  const base = { batchId: BATCH_ID, sourceType: "PHOTO_STATION" };
  expectErr(
    validateRequestUploadsInput({ ...base, assets: [requestItem(1), requestItem(2, { clientAssetId: "client-1" })] }, "PHOTO_STATION"),
    "INVALID_INPUT",
    "clientAssetId重複",
  );
  expectErr(
    validateRequestUploadsInput({ ...base, assets: [requestItem(1), requestItem(2, { processed: { sha256: hash(1) } })] }, "PHOTO_STATION"),
    "INVALID_INPUT",
    "sha256重複",
  );
});

test("requestUploads: S3キーは photo-batches/{batchId}/{variant}/{assetId} で固定 (§5 / §54)", () => {
  const world = newWorld();
  uploadAssets(world, [1]);
  const asset = world.assets[0];
  assert.equal(photoAssetS3Key(BATCH_ID, asset.id, "PROCESSED"), `photo-batches/${BATCH_ID}/processed/${asset.id}.jpg`);
  assert.equal(photoAssetS3Key(BATCH_ID, asset.id, "THUMBNAIL"), `photo-batches/${BATCH_ID}/thumbnail/${asset.id}.jpg`);
  // 商品名・在庫ID・日本語を含めない。
  assert.ok(!photoAssetS3Key(BATCH_ID, asset.id, "PROCESSED").includes(INVENTORY_ID));
  assert.match(photoAssetS3Key(BATCH_ID, asset.id, "PROCESSED"), /^[\x20-\x7e]+$/);
});

test("PhotoAssetはinventoryIdを持たない (§4.6)", () => {
  const world = reviewedBatch(3);
  expectOk(linkTo(world), "link");
  for (const asset of world.assets) {
    assert.ok(!("inventoryId" in asset), "PhotoAssetにinventoryIdが現れてはいけない");
  }
  assert.equal(world.batch.inventoryId, INVENTORY_ID);
});

// ─────────────────────────────────────────────────────────────────────────
// 3. 枚数境界 0 / 1 / 20 / 100 / 300 / 301 (§79 / §7.6)
// ─────────────────────────────────────────────────────────────────────────

test("0枚: finalizeはEMPTY_BATCHで拒否", () => {
  const world = newWorld();
  expectErr(finalize(world), "EMPTY_BATCH", "0枚finalize");
  assert.equal(world.batch.status, "CREATED");
});

for (const count of [1, 20, 100, 300]) {
  test(`${count}枚: 25件chunkで登録 → 全complete → finalizeでREADY_FOR_REVIEW`, () => {
    const world = reviewedBatch(count);
    assert.equal(world.assets.length, count);
    assert.equal(world.batch.manifest.expectedAssetCount, count);
    assert.equal(world.batch.manifest.completedAssetCount, count);
    assert.equal(world.batch.status, "READY_FOR_REVIEW");
  });
}

test("301枚目: ASSET_LIMIT_EXCEEDED (300枚ちょうどは通る)", () => {
  const world = newWorld();
  uploadAssets(world, Array.from({ length: MAX_ASSETS_PER_BATCH }, (_, i) => i + 1));
  assert.equal(world.assets.length, MAX_ASSETS_PER_BATCH);
  const input = expectOk(
    validateRequestUploadsInput({ batchId: BATCH_ID, assets: [requestItem(9001)] }, "PHOTO_STATION"),
    "validate",
  );
  expectErr(
    decideRequestUploads(input, { batch: world.batch, assets: world.assets, allocateAssetId: () => "asset-extra" }),
    "ASSET_LIMIT_EXCEEDED",
    "301枚目",
  );
});

test("300枚予定・25枚registeredでfinalize拒否、残275枚の再開後にfinalize可能 (§7.6)", () => {
  const world = newWorld();
  // createPhotoBatchでexpectedAssetCount=300を固定した状態を再現する。
  world.batch.manifest.expectedAssetCount = 300;
  uploadAssets(world, Array.from({ length: 25 }, (_, i) => i + 1));
  completeAllUploading(world);
  assert.equal(world.batch.manifest.registeredAssetCount, 25);
  assert.equal(world.batch.manifest.completedAssetCount, 25);
  expectErr(finalize(world), "UPLOAD_NOT_COMPLETE", "25/300のfinalize拒否");
  assert.equal(world.batch.status, "UPLOADING", "不足のままREADY_FOR_REVIEWへ進んではいけない");

  uploadAssets(world, Array.from({ length: 275 }, (_, i) => i + 26));
  completeAllUploading(world);
  assert.equal(world.batch.manifest.registeredAssetCount, 300);
  assert.equal(world.batch.manifest.completedAssetCount, 300);
  expectOk(finalize(world), "残275枚完了後のfinalize");
  assert.equal(world.batch.status, "READY_FOR_REVIEW");
});

test("予定枚数(300未満)を超える受理はASSET_LIMIT_EXCEEDED (§7.6 300枚上限とは別の境界)", () => {
  const world = newWorld();
  world.batch.manifest.expectedAssetCount = 10;
  uploadAssets(world, Array.from({ length: 10 }, (_, i) => i + 1));
  assert.equal(world.assets.length, 10);
  const input = expectOk(
    validateRequestUploadsInput({ batchId: BATCH_ID, assets: [requestItem(9101)] }, "PHOTO_STATION"),
    "validate",
  );
  expectErr(
    decideRequestUploads(input, { batch: world.batch, assets: world.assets, allocateAssetId: () => "asset-over-plan" }),
    "ASSET_LIMIT_EXCEEDED",
    "予定10枚を超える11枚目",
  );
});

test("300枚のlinkでPhotoAssetを1件も書き換えない (§93.5 ケースA)", () => {
  const world = reviewedBatch(300);
  const input = expectOk(
    validateLinkBatchToInventoryInput({ batchId: BATCH_ID, inventoryId: INVENTORY_ID }),
    "validate",
  );
  const decision = expectOk(
    decideLinkBatchToInventory(input, { batch: world.batch, inventory: { id: INVENTORY_ID, exists: true, isDeleted: false } }),
    "decide",
  );
  assert.equal(decision.assetWrites, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// 4. 再送・重複 (§8 / §31 / §30)
// ─────────────────────────────────────────────────────────────────────────

function decideUploads(
  world: World,
  assets: Record<string, unknown>[],
  sourceType: "PHOTO_STATION" | "WEB_UPLOAD" = "PHOTO_STATION",
  additionalExpectedCount: number | null = null,
) {
  const input = expectOk(
    validateRequestUploadsInput({ batchId: world.batch.id, assets, additionalExpectedCount }, sourceType),
    "decideUploads/validate",
  );
  return decideRequestUploads(input, {
    batch: world.batch,
    assets: world.assets,
    // world.nextAssetSerialを基点にする — 同一worldへ複数回decideUploadsを適用しても
    // photoAssetIdが衝突しない (applyRequestUploadsが登録済み数ぶんだけ進める)。
    allocateAssetId: (index) => `asset-new-${world.nextAssetSerial + index}`,
  });
}

test("再送: 同一clientAssetId・同一hashはUPLOADING中ならURL再発行 (同一Asset・同一S3キー)", () => {
  const world = newWorld();
  uploadAssets(world, [1]);
  const original = world.assets[0];
  const decision = expectOk(decideUploads(world, [requestItem(1)]), "再送");
  assert.equal(decision.items.length, 1);
  assert.equal(decision.items[0].kind, "REISSUE_UPLOAD");
  assert.equal(decision.manifestDelta.expected, 0, "再送でexpectedが増えてはいけない");
  const item = decision.items[0];
  assert.ok(item.kind === "REISSUE_UPLOAD");
  assert.equal(item.photoAssetId, original.id);
  assert.equal(item.uploads[0].s3Key, photoAssetS3Key(BATCH_ID, original.id, "PROCESSED"));
});

test("再送: 完了済み(READY)へはupload URLを再発行しない (検証済みS3オブジェクトの上書き防止)", () => {
  const world = newWorld();
  uploadAssets(world, [1]);
  completeAllUploading(world);
  const decision = expectOk(decideUploads(world, [requestItem(1)]), "READY再送");
  assert.equal(decision.items[0].kind, "ALREADY_READY");
  assert.ok(!("uploads" in decision.items[0]));
  assert.equal(decision.manifestDelta.expected, 0);
});

test("再送: 同一clientAssetIdでhashが変わったらIDEMPOTENCY_CONFLICT", () => {
  const world = newWorld();
  uploadAssets(world, [1]);
  expectErr(
    decideUploads(world, [requestItem(1, { processed: { sha256: hash(999) } })]),
    "IDEMPOTENCY_CONFLICT",
    "hash変更",
  );
});

test("重複: batch内の同一sha256は別clientAssetIdならSKIPして既存Assetを返す (§31)", () => {
  const world = newWorld();
  uploadAssets(world, [1]);
  const decision = expectOk(
    decideUploads(world, [requestItem(1, { clientAssetId: "client-dup" })]),
    "重複",
  );
  const item = decision.items[0];
  assert.equal(item.kind, "DUPLICATE_SKIP");
  assert.ok(item.kind === "DUPLICATE_SKIP");
  assert.equal(item.photoAssetId, world.assets[0].id);
  assert.equal(item.duplicateOfClientAssetId, "client-1");
  assert.equal(decision.manifestDelta.expected, 0, "重複はmanifestの予定枚数を増やさない");
});

test("重複: 新規作成時はhashキーへの条件付きPutを要求する (GSI検索だけに頼らない)", () => {
  const world = newWorld();
  // createPhotoBatchでexpectedAssetCount>=1を固定した状態を再現する (0枚予定だと
  // このrequestUploads自体がASSET_LIMIT_EXCEEDEDになり、条件の検証まで届かない)。
  world.batch.manifest.expectedAssetCount = 1;
  const decision = expectOk(decideUploads(world, [requestItem(1)]), "新規");
  const targets = decision.conditions.map((c) => c.target);
  assert.ok(targets.some((t) => t.includes("PhotoAssetHash")), "hash一意化の条件が必要");
  assert.ok(targets.some((t) => t.includes("PhotoAssetIdempotency")), "clientAssetId一意化の条件が必要");
});

test("重複SKIP後のfinalize: クライアントが重複前の枚数を送るとCONFLICT", () => {
  const world = newWorld();
  uploadAssets(world, [1, 2]);
  const skip = expectOk(decideUploads(world, [requestItem(1, { clientAssetId: "client-dup" })]), "重複");
  applyRequestUploads(world, skip, "PHOTO_STATION");
  completeAllUploading(world);
  const input = expectOk(
    validateCompletePhotoBatchInput({ batchId: BATCH_ID, imageCountProcessed: 3, imageCountUploaded: 3 }),
    "validate",
  );
  expectErr(decideCompletePhotoBatch(input, world.batch), "CONFLICT", "重複前の枚数");
  expectOk(finalize(world), "重複除去後の枚数なら通る");
  assert.equal(world.batch.manifest.expectedAssetCount, 2);
});

// ─────────────────────────────────────────────────────────────────────────
// 5. completePhotoAssetUpload (§5.5 / §7.3)
// ─────────────────────────────────────────────────────────────────────────

function uploadingAsset(): { world: World; asset: PhotoAssetView } {
  const world = newWorld();
  uploadAssets(world, [1]);
  return { world, asset: world.assets[0] };
}

test("assetComplete: S3にオブジェクトが無ければUPLOAD_NOT_COMPLETE", () => {
  const { world, asset } = uploadingAsset();
  const input = expectOk(validateCompleteAssetUploadInput(completionInput(asset)), "validate");
  expectErr(
    decideCompleteAssetUpload(input, {
      batch: world.batch,
      asset,
      observed: observedFor(asset, (o) => (o.variant === "THUMBNAIL" ? { ...o, exists: false, contentLength: null, sha256: null } : o)),
    }),
    "UPLOAD_NOT_COMPLETE",
    "thumbnail欠落",
  );
});

test("assetComplete: S3のサイズ不一致・content-type不一致はUPLOAD_NOT_COMPLETE", () => {
  const { world, asset } = uploadingAsset();
  const input = expectOk(validateCompleteAssetUploadInput(completionInput(asset)), "validate");
  expectErr(
    decideCompleteAssetUpload(input, {
      batch: world.batch,
      asset,
      observed: observedFor(asset, (o) => (o.variant === "PROCESSED" ? { ...o, contentLength: 10 } : o)),
    }),
    "UPLOAD_NOT_COMPLETE",
    "サイズ不一致",
  );
  expectErr(
    decideCompleteAssetUpload(input, {
      batch: world.batch,
      asset,
      observed: observedFor(asset, (o) => (o.variant === "PROCESSED" ? { ...o, contentType: "application/octet-stream" } : o)),
    }),
    "UPLOAD_NOT_COMPLETE",
    "content-type不一致",
  );
});

test("assetComplete: checksumを検証できない/一致しないならREADYにしない (§5.5)", () => {
  const { world, asset } = uploadingAsset();
  const input = expectOk(validateCompleteAssetUploadInput(completionInput(asset)), "validate");
  expectErr(
    decideCompleteAssetUpload(input, { batch: world.batch, asset, observed: observedFor(asset, (o) => ({ ...o, sha256: null })) }),
    "UPLOAD_NOT_COMPLETE",
    "checksum取得不能",
  );
  expectErr(
    decideCompleteAssetUpload(input, { batch: world.batch, asset, observed: observedFor(asset, (o) => ({ ...o, sha256: hash(4242) })) }),
    "HASH_MISMATCH",
    "checksum不一致",
  );
});

test("assetComplete: 宣言と異なるhash/サイズの完了報告を拒否", () => {
  const { world, asset } = uploadingAsset();
  const badHash = expectOk(
    validateCompleteAssetUploadInput(
      completionInput(asset, { processed: { sha256: hash(777), fileSize: asset.declared.PROCESSED.fileSize, width: 3000, height: 2000 } }),
    ),
    "validate",
  );
  expectErr(
    decideCompleteAssetUpload(badHash, { batch: world.batch, asset, observed: observedFor(asset) }),
    "HASH_MISMATCH",
    "宣言hashと違う",
  );
  const badSize = expectOk(
    validateCompleteAssetUploadInput(
      completionInput(asset, { processed: { sha256: asset.declared.PROCESSED.sha256, fileSize: 999, width: 3000, height: 2000 } }),
    ),
    "validate",
  );
  expectErr(
    decideCompleteAssetUpload(badSize, { batch: world.batch, asset, observed: observedFor(asset) }),
    "INVALID_INPUT",
    "宣言サイズと違う",
  );
});

test("assetComplete: 寸法の不正値を拒否", () => {
  const { asset } = uploadingAsset();
  expectErr(
    validateCompleteAssetUploadInput(completionInput(asset, { processed: { sha256: asset.declared.PROCESSED.sha256, fileSize: asset.declared.PROCESSED.fileSize, width: 0, height: 2000 } })),
    "INVALID_INPUT",
    "width=0",
  );
  expectErr(
    validateCompleteAssetUploadInput(completionInput(asset, { processed: { sha256: asset.declared.PROCESSED.sha256, fileSize: asset.declared.PROCESSED.fileSize, width: 3000, height: 999999 } })),
    "INVALID_INPUT",
    "height過大",
  );
});

test("assetComplete: 成功時はUPLOADING固定の条件付き更新を要求し、completedを1だけ増やす", () => {
  const { world, asset } = uploadingAsset();
  const input = expectOk(validateCompleteAssetUploadInput(completionInput(asset)), "validate");
  const decision = expectOk(
    decideCompleteAssetUpload(input, { batch: world.batch, asset, observed: observedFor(asset) }),
    "decide",
  );
  assert.equal(decision.kind, "MARK_READY");
  assert.ok(decision.kind === "MARK_READY");
  assert.equal(decision.manifestDelta.completed, 1);
  assert.ok(
    decision.conditions.some((c) => c.target === `PhotoAsset#${asset.id}` && c.predicate.includes("#status = 'UPLOADING'")),
    "二重加算を防ぐ条件が必要",
  );
});

test("assetComplete: 二重送信はNO_OPで冪等 (completedを二重加算しない)", () => {
  const { world, asset } = uploadingAsset();
  completeAsset(world, asset);
  assert.equal(world.batch.manifest.completedAssetCount, 1);
  const input = expectOk(validateCompleteAssetUploadInput(completionInput(asset)), "validate");
  const second = expectOk(
    decideCompleteAssetUpload(input, { batch: world.batch, asset, observed: observedFor(asset) }),
    "2回目",
  );
  assert.equal(second.kind, "NO_OP");
  assert.equal(second.manifestDelta.completed, 0);
});

test("assetComplete: 削除済みAssetの完了報告はASSET_NOT_FOUND", () => {
  const { world, asset } = uploadingAsset();
  asset.isDeleted = true;
  asset.status = "DELETED";
  const input = expectOk(validateCompleteAssetUploadInput(completionInput(asset)), "validate");
  expectErr(decideCompleteAssetUpload(input, { batch: world.batch, asset, observed: observedFor(asset) }), "ASSET_NOT_FOUND", "削除済み");
});

// ─────────────────────────────────────────────────────────────────────────
// 6. completePhotoBatch (§7.4 / §29)
// ─────────────────────────────────────────────────────────────────────────

test("finalize: 完了不足なら拒否し、READY_FOR_REVIEWにしない", () => {
  const world = newWorld();
  uploadAssets(world, [1, 2, 3]);
  completeAsset(world, world.assets[0]);
  expectErr(finalize(world), "UPLOAD_NOT_COMPLETE", "1/3完了");
  assert.equal(world.batch.status, "UPLOADING");
});

test("finalize: 失敗Assetが残っていれば拒否 (§7.6 failed==0)", () => {
  const world = reviewedBatch(2);
  world.batch.status = "UPLOADING";
  world.batch.manifest.failedAssetCount = 1;
  expectErr(finalize(world), "UPLOAD_NOT_COMPLETE", "failed>0");
});

test("finalize: 二重送信はNO_OP (再HEADも再集計もしない)", () => {
  const world = reviewedBatch(5);
  const second = expectOk(finalize(world), "2回目");
  assert.equal((second as { kind: string }).kind, "NO_OP");
  assert.equal(world.batch.status, "READY_FOR_REVIEW");
});

test("finalize: ARCHIVEDのbatchは拒否", () => {
  const world = reviewedBatch(2);
  world.batch.status = "ARCHIVED";
  expectErr(finalize(world), "INVALID_STATUS_TRANSITION", "ARCHIVED");
});

// ─────────────────────────────────────────────────────────────────────────
// 7. link (§18 / §59 / §93.5 ケースE)
// ─────────────────────────────────────────────────────────────────────────

test("link: READY_FOR_REVIEW以外は拒否", () => {
  const uploading = newWorld();
  uploadAssets(uploading, [1]);
  expectErr(linkTo(uploading), "INVALID_STATUS_TRANSITION", "UPLOADING中のlink");
  const created = newWorld();
  expectErr(linkTo(created), "INVALID_STATUS_TRANSITION", "CREATEDのlink");
});

test("link: 存在しないInventoryはINVENTORY_NOT_FOUND", () => {
  const world = reviewedBatch(2);
  expectErr(linkTo(world, "inv-UNKNOWN"), "INVENTORY_NOT_FOUND", "未知のinventory");
  assert.equal(world.batch.inventoryId, null);
});

test("link: 二者同時linkは条件付き更新で片方だけが成立する", () => {
  const world = reviewedBatch(2);
  const input = expectOk(
    validateLinkBatchToInventoryInput({ batchId: BATCH_ID, inventoryId: INVENTORY_ID }),
    "validate",
  );
  // 同じ「読み取り時点の状態」から2人が判断すると、どちらもLINKを返す。
  // 二重確定を防ぐのは決定側ではなく、決定が要求する条件式の方である。
  const first = expectOk(decideLinkBatchToInventory(input, { batch: world.batch, inventory: { id: INVENTORY_ID, exists: true, isDeleted: false } }), "1人目");
  const second = expectOk(decideLinkBatchToInventory(input, { batch: world.batch, inventory: { id: INVENTORY_ID, exists: true, isDeleted: false } }), "2人目");
  for (const decision of [first, second]) {
    assert.ok(
      decision.conditions.some(
        (c) => c.target === `PhotoBatch#${BATCH_ID}` && c.predicate.includes("attribute_not_exists(inventoryId)") && c.violationError === "BATCH_ALREADY_LINKED",
      ),
      "未紐付けを条件にした更新でなければ後勝ちで上書きされる",
    );
    assert.ok(decision.conditions.some((c) => c.target === `Inventory#${INVENTORY_ID}`), "Inventory実在も同一transactionで条件化する");
  }
  // 片方が確定した後は、読み直した状態でBATCH_ALREADY_LINKEDになる。
  expectOk(linkTo(world), "確定");
  expectErr(linkTo(world), "BATCH_ALREADY_LINKED", "2人目の再試行");
  expectErr(linkTo(world, "inv-OTHER"), "BATCH_ALREADY_LINKED", "別商品への付け替え");
});

test("link: 存在確認済みでも論理削除済みInventoryはINVENTORY_NOT_FOUND (§67)", () => {
  const world = reviewedBatch(2);
  expectErr(linkTo(world, "inv-DELETED"), "INVENTORY_NOT_FOUND", "論理削除済みinventory");
  assert.equal(world.batch.inventoryId, null);
});

test("link: 追加uploadが未完了(openRevision)ならUPLOAD_NOT_COMPLETE", () => {
  const world = reviewedBatch(2);
  const decision = expectOk(decideUploads(world, [requestItem(50)], "WEB_UPLOAD", 1), "追加upload");
  applyRequestUploads(world, decision, "WEB_UPLOAD");
  expectErr(linkTo(world), "UPLOAD_NOT_COMPLETE", "revision進行中");
});

// ─────────────────────────────────────────────────────────────────────────
// 8. 追加upload / revision (§13 / §AA 既存画像保全)
// ─────────────────────────────────────────────────────────────────────────

test("追加upload: 既存READY画像を保全したままrevisionを開く", () => {
  const world = reviewedBatch(20);
  const before = world.assets.map((a) => ({ id: a.id, status: a.status, key: photoAssetS3Key(BATCH_ID, a.id, "PROCESSED") }));

  const decision = expectOk(decideUploads(world, [requestItem(101), requestItem(102)], "WEB_UPLOAD", 2), "追加2枚");
  assert.equal(decision.opensRevision, true);
  assert.equal(decision.revision, 1);
  applyRequestUploads(world, decision, "WEB_UPLOAD");

  // batchのstatusはREADY_FOR_REVIEWのまま = 確認済み画像がレビュー対象から外れない。
  assert.equal(world.batch.status, "READY_FOR_REVIEW");
  for (const snapshot of before) {
    const current = world.assets.find((a) => a.id === snapshot.id);
    assert.ok(current, "既存Assetが消えてはいけない");
    assert.equal(current.status, "READY", "既存READY画像の状態が巻き戻ってはいけない");
    assert.equal(current.isDeleted, false);
    assert.equal(photoAssetS3Key(BATCH_ID, current.id, "PROCESSED"), snapshot.key, "S3キーは不変 (§1.3)");
  }
  assert.equal(world.batch.manifest.expectedAssetCount, 22);
  assert.equal(world.batch.manifest.completedAssetCount, 20);

  // 追加分が途中で失敗している間はfinalizeが通らない。既存20枚は無傷のまま。
  completeAsset(world, world.assets[20]);
  expectErr(finalize(world), "UPLOAD_NOT_COMPLETE", "追加1枚未完");
  assert.equal(world.assets.filter((a) => a.status === "READY").length, 21);

  completeAllUploading(world);
  expectOk(finalize(world), "追加完了後のfinalize");
  assert.equal(world.batch.manifest.revision, 1);
  assert.equal(world.batch.manifest.openRevision, null);
  assert.equal(world.assets.length, 22);
});

test("追加upload: 確認済みbatchへPhoto Stationが新規Assetを足すことはできない", () => {
  const world = reviewedBatch(3);
  expectErr(decideUploads(world, [requestItem(201)], "PHOTO_STATION"), "INVALID_STATUS_TRANSITION", "station追加");
  // 既知Assetの再送は確認済みbatchでも通る (通信断後の再送の正常系)。
  const resend = expectOk(decideUploads(world, [requestItem(1)], "PHOTO_STATION"), "既知の再送");
  assert.equal(resend.items[0].kind, "ALREADY_READY");
});

test("追加upload: ARCHIVEDのbatchへは追加できない", () => {
  const world = reviewedBatch(2);
  world.batch.status = "ARCHIVED";
  expectErr(decideUploads(world, [requestItem(301)], "WEB_UPLOAD"), "INVALID_STATUS_TRANSITION", "ARCHIVED追加");
});

test("追加upload: additionalExpectedCount省略でrevisionは開けない (§13 開始時固定)", () => {
  const world = reviewedBatch(2);
  expectErr(
    decideUploads(world, [requestItem(401)], "WEB_UPLOAD"),
    "INVALID_INPUT",
    "additionalExpectedCount未指定でのrevision開始",
  );
});

test("追加upload revision: 開始時に固定した予定数と異なる再送はCONFLICT、同じ値の再送は冪等 (二重加算しない)", () => {
  const world = reviewedBatch(5);
  const opened = expectOk(decideUploads(world, [requestItem(501)], "WEB_UPLOAD", 3), "revisionを開く");
  assert.equal(opened.opensRevision, true);
  assert.equal(opened.revision, 1);
  applyRequestUploads(world, opened, "WEB_UPLOAD");
  assert.deepEqual(world.batch.manifest.openRevision, { revision: 1, expectedDelta: 3 });
  assert.equal(world.batch.manifest.expectedAssetCount, 8);

  // 同じ追加予定数(3)での再送(2枚目)は、開いたrevisionを再利用し二重加算しない。
  const resend = expectOk(decideUploads(world, [requestItem(502)], "WEB_UPLOAD", 3), "同じ予定数の再送");
  assert.equal(resend.opensRevision, false, "既に開いているrevisionを二重に開いてはいけない");
  applyRequestUploads(world, resend, "WEB_UPLOAD");
  assert.equal(world.batch.manifest.expectedAssetCount, 8, "additionalExpectedCountの再送で二重加算されてはいけない");
  assert.equal(world.batch.manifest.registeredAssetCount, 5 + 2);

  // 異なる追加予定数(5)での再送はCONFLICT — どちらが正か決められない。
  expectErr(decideUploads(world, [requestItem(503)], "WEB_UPLOAD", 5), "CONFLICT", "追加予定数の食い違い");

  // 追加分の完了報告が二重に届いてもcompletedは1回しか進まない。
  const added1 = world.assets.find((a) => a.clientAssetId === "client-501")!;
  completeAsset(world, added1);
  assert.equal(world.batch.manifest.completedAssetCount, 6);
  completeAsset(world, added1);
  assert.equal(world.batch.manifest.completedAssetCount, 6, "同一Assetの完了二重通知でcompletedが増えてはいけない");
});

// ─────────────────────────────────────────────────────────────────────────
// 9. 論理削除・復元・使用中削除 (§12 / §68 / §67)
// ─────────────────────────────────────────────────────────────────────────

test("delete: 論理削除はS3を消さず、manifestのexpected/completedを同時に減らす", () => {
  const world = reviewedBatch(3);
  const asset = world.assets[0];
  const decision = expectOk(decideDeleteAsset({ asset, activeListingSelectionCount: 0 }), "delete");
  assert.ok(decision.kind === "SOFT_DELETE");
  assert.equal(decision.deletesS3Object, false);
  assert.deepEqual(decision.manifestDelta, { expected: -1, registered: -1, completed: -1, failed: 0 });

  asset.isDeleted = true;
  asset.statusBeforeDelete = decision.statusBeforeDelete;
  asset.status = "DELETED";
  world.batch.manifest.expectedAssetCount -= 1;
  world.batch.manifest.registeredAssetCount -= 1;
  world.batch.manifest.completedAssetCount -= 1;
  // 削除後もmanifestは整合したまま = 追加uploadのfinalizeが将来通る。
  assert.equal(world.batch.manifest.expectedAssetCount, world.batch.manifest.completedAssetCount);

  const second = expectOk(decideDeleteAsset({ asset, activeListingSelectionCount: 0 }), "2回目");
  assert.equal(second.kind, "NO_OP");
});

test("delete: Listing使用中はブロック (§68 警告で続行させない)", () => {
  const world = reviewedBatch(2);
  expectErr(decideDeleteAsset({ asset: world.assets[0], activeListingSelectionCount: 1 }), "ASSET_IN_USE", "使用中");
  const decision = expectOk(decideDeleteAsset({ asset: world.assets[0], activeListingSelectionCount: 0 }), "未使用");
  assert.ok(decision.kind === "SOFT_DELETE");
  assert.ok(
    decision.conditions.some((c) => c.predicate.includes("listingSelectionCount = 0")),
    "GSI逆引きではなく参照カウンタの条件で排他する",
  );
});

const ADMIN_ACTOR = { actorId: "admin-1", role: "ADMIN" as const };
const STAFF_ACTOR = { actorId: "staff-1", role: "STAFF" as const };

test("restore: 削除前の状態へ戻し、manifestも戻す", () => {
  const world = reviewedBatch(2);
  const asset = world.assets[0];
  expectErr(
    decideRestoreAsset({ asset, batch: world.batch, activeAssetCount: 2, actor: ADMIN_ACTOR }),
    "ASSET_NOT_DELETED",
    "未削除の復元",
  );

  asset.isDeleted = true;
  asset.statusBeforeDelete = "READY";
  asset.status = "DELETED";
  world.batch.manifest.expectedAssetCount -= 1;
  world.batch.manifest.registeredAssetCount -= 1;
  world.batch.manifest.completedAssetCount -= 1;

  const decision = expectOk(decideRestoreAsset({ asset, batch: world.batch, activeAssetCount: 1, actor: ADMIN_ACTOR }), "復元");
  assert.equal(decision.nextAssetStatus, "READY");
  assert.deepEqual(decision.manifestDelta, { expected: 1, registered: 1, completed: 1, failed: 0 });
  assert.equal(world.batch.manifest.expectedAssetCount + decision.manifestDelta.expected, 2);
});

test("restore: 未完了のまま削除されたAssetはREADYへ戻さない", () => {
  const world = newWorld();
  uploadAssets(world, [1]);
  const asset = world.assets[0];
  asset.isDeleted = true;
  asset.statusBeforeDelete = "UPLOADING";
  asset.status = "DELETED";
  const decision = expectOk(decideRestoreAsset({ asset, batch: world.batch, activeAssetCount: 0, actor: ADMIN_ACTOR }), "復元");
  assert.equal(decision.nextAssetStatus, "UPLOADING", "検証なしでREADYにしてはいけない");
});

test("restore: 300枚まで埋まっていればASSET_LIMIT_EXCEEDED", () => {
  const world = reviewedBatch(1);
  const asset = world.assets[0];
  asset.isDeleted = true;
  asset.statusBeforeDelete = "READY";
  asset.status = "DELETED";
  expectErr(
    decideRestoreAsset({ asset, batch: world.batch, activeAssetCount: MAX_ASSETS_PER_BATCH, actor: ADMIN_ACTOR }),
    "ASSET_LIMIT_EXCEEDED",
    "満枠での復元",
  );
});

test("restore: roleは呼び出し側の主張ではなく認証済みコンテキストから受け取る (§47 信頼境界)", () => {
  const world = reviewedBatch(2);
  const asset = world.assets[0];
  asset.isDeleted = true;
  asset.statusBeforeDelete = "READY";
  asset.status = "DELETED";
  expectErr(
    decideRestoreAsset({ asset, batch: world.batch, activeAssetCount: 1, actor: STAFF_ACTOR }),
    "PERMISSION_DENIED",
    "STAFFによる復元は拒否",
  );
  const decision = expectOk(
    decideRestoreAsset({ asset, batch: world.batch, activeAssetCount: 1, actor: ADMIN_ACTOR }),
    "ADMINによる復元は許可",
  );
  assert.equal(decision.nextAssetStatus, "READY");
});

test("restore: 別batchのAssetを渡すとASSET_NOT_FOUND (batchIdの照合)", () => {
  const world = reviewedBatch(2);
  const asset = world.assets[0];
  asset.isDeleted = true;
  asset.statusBeforeDelete = "READY";
  asset.status = "DELETED";
  const otherBatch: PhotoBatchView = { ...world.batch, id: "batch-OTHER0001" };
  expectErr(
    decideRestoreAsset({ asset, batch: otherBatch, activeAssetCount: 1, actor: ADMIN_ACTOR }),
    "ASSET_NOT_FOUND",
    "batch取り違え",
  );
});

test("link: actorUserIdはクライアント入力から検証済み型へ引き継がれない (§47 信頼境界)", () => {
  const input = expectOk(
    validateLinkBatchToInventoryInput({
      batchId: BATCH_ID,
      inventoryId: INVENTORY_ID,
      actorUserId: "attacker-claimed-admin",
      role: "ADMIN",
    }),
    "validate",
  );
  assert.ok(!("actorUserId" in input), "actorUserIdは検証済み型に含まれてはいけない (認証済みコンテキストから取得する)");
  assert.ok(!("role" in input), "roleは検証済み型に含まれてはいけない (クライアントは自己申告できない)");
});

// ─────────────────────────────────────────────────────────────────────────
// 10. Listing画像選択 (§21 / §22 / §45)
// ─────────────────────────────────────────────────────────────────────────

function selectionContext(world: World, inventoryId: string | null = INVENTORY_ID, selectionRevision = 0) {
  return {
    assets: world.assets,
    batchInventoryIdByAssetId: Object.fromEntries(world.assets.map((a) => [a.id, inventoryId])),
    listingInventoryId: INVENTORY_ID,
    currentSelection: [] as string[],
    selectionRevision,
  };
}

test("Listing選択: 順序が出品順、先頭がメイン", () => {
  const world = reviewedBatch(3);
  expectOk(linkTo(world), "link");
  const ids = world.assets.map((a) => a.id);
  const input = expectOk(
    validateListingImageSelectionInput({ listingId: "listing-1", photoAssetIds: [ids[2], ids[0]] }, { maxImages: 10 }),
    "validate",
  );
  const decision = expectOk(decideListingImageSelection(input, selectionContext(world)), "decide");
  assert.deepEqual(
    decision.rows,
    [
      { photoAssetId: ids[2], sequence: 0, isPrimary: true },
      { photoAssetId: ids[0], sequence: 1, isPrimary: false },
    ],
  );
  assert.deepEqual(decision.refCountIncrements, [ids[2], ids[0]]);
  assert.deepEqual(decision.refCountDecrements, []);
});

test("Listing選択: チャネル上限超過・重複はvalidationで拒否 (§22)", () => {
  expectErr(
    validateListingImageSelectionInput({ listingId: "l1", photoAssetIds: ["a", "b", "c"] }, { maxImages: 2 }),
    "CHANNEL_IMAGE_LIMIT_EXCEEDED",
    "上限超過",
  );
  expectErr(
    validateListingImageSelectionInput({ listingId: "l1", photoAssetIds: ["a", "a"] }, { maxImages: 10 }),
    "INVALID_INPUT",
    "重複選択",
  );
  expectOk(validateListingImageSelectionInput({ listingId: "l1", photoAssetIds: [] }, { maxImages: 10 }), "0枚選択は正当");
});

test("Listing選択: 削除済み・未紐付けbatchのAssetは選べない", () => {
  const world = reviewedBatch(2);
  expectOk(linkTo(world), "link");
  world.assets[0].isDeleted = true;
  world.assets[0].status = "DELETED";
  const input = expectOk(
    validateListingImageSelectionInput({ listingId: "l1", photoAssetIds: [world.assets[0].id] }, { maxImages: 10 }),
    "validate",
  );
  expectErr(decideListingImageSelection(input, selectionContext(world)), "INVALID_STATUS_TRANSITION", "削除済み");

  const unlinked = reviewedBatch(1);
  const input2 = expectOk(
    validateListingImageSelectionInput({ listingId: "l1", photoAssetIds: [unlinked.assets[0].id] }, { maxImages: 10 }),
    "validate",
  );
  expectErr(decideListingImageSelection(input2, selectionContext(unlinked, null)), "CONFLICT", "未紐付けbatch");
});

test("Listing選択: 置換は読取時のselectionRevisionを条件にする (同時置換の二重減算防止)", () => {
  const world = reviewedBatch(3);
  expectOk(linkTo(world), "link");
  const ids = world.assets.map((a) => a.id);
  const input = expectOk(
    validateListingImageSelectionInput({ listingId: "listing-rev", photoAssetIds: [ids[0]] }, { maxImages: 10 }),
    "validate",
  );
  // 2人が同じ読取時点(selectionRevision=5, currentSelection=[ids[1]])から置換を試みる。
  const context = { ...selectionContext(world, INVENTORY_ID, 5), currentSelection: [ids[1]] };
  const first = expectOk(decideListingImageSelection(input, context), "1人目");
  const second = expectOk(decideListingImageSelection(input, context), "2人目");
  for (const decision of [first, second]) {
    assert.equal(decision.nextSelectionRevision, 6);
    assert.deepEqual(decision.refCountDecrements, [ids[1]], "同じ旧選択を基準に1回だけ減算する条件になっている");
    assert.ok(
      decision.conditions.some(
        (c) => c.target === "ListingImageSelectionState#listing-rev" && c.predicate === "selectionRevision = 5",
      ),
      "読取時のselectionRevisionが条件になっていなければ、後勝ちの置換がrefCountDecrementsを2回適用してしまう",
    );
  }
});

test("Listing選択: 選択解除は参照カウンタの減算として出る (削除可否と同じカウンタ)", () => {
  const world = reviewedBatch(2);
  expectOk(linkTo(world), "link");
  const ids = world.assets.map((a) => a.id);
  const input = expectOk(
    validateListingImageSelectionInput({ listingId: "l1", photoAssetIds: [ids[1]] }, { maxImages: 10 }),
    "validate",
  );
  const decision = expectOk(
    decideListingImageSelection(input, { ...selectionContext(world), currentSelection: [ids[0]] }),
    "decide",
  );
  assert.deepEqual(decision.refCountIncrements, [ids[1]]);
  assert.deepEqual(decision.refCountDecrements, [ids[0]]);
  // 外した画像は削除できるようになる。外す前は ASSET_IN_USE (上の試験)。
  expectOk(decideDeleteAsset({ asset: world.assets[0], activeListingSelectionCount: 0 }), "解除後の削除");
});

// ─────────────────────────────────────────────────────────────────────────
// 11. 遷移表 (§33)
// ─────────────────────────────────────────────────────────────────────────

test("遷移表: LINKED -> UPLOADING は禁止、ERRORからの再開は許可 (§33 / §28)", () => {
  assert.equal(canTransitionBatch("LINKED", "UPLOADING"), false);
  assert.equal(canTransitionBatch("READY_FOR_REVIEW", "UPLOADING"), false);
  assert.equal(canTransitionBatch("ARCHIVED", "LINKED"), false);
  assert.equal(canTransitionBatch("UPLOADING", "LINKED"), false, "finalizeを飛ばしてlinkできない");
  assert.equal(canTransitionBatch("UPLOADING", "READY_FOR_REVIEW"), true);
  assert.equal(canTransitionBatch("READY_FOR_REVIEW", "LINKED"), true);
  assert.equal(canTransitionBatch("ERROR", "UPLOADING"), true);
  assert.equal(canTransitionBatch("LINKED", "ARCHIVED"), true);
});

// ─────────────────────────────────────────────────────────────────────────
// 結果
// ─────────────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} failed / ${passed} passed\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`✓ photo registration contract: ${passed} checks passed`);
console.log(
  "  注意: これは合成データによる契約・遷移判断の検証であり、DynamoDBの条件付き書込みの原子性、" +
    "S3オブジェクトの実在、Cognito/IAMの権限は一切検証していない (未デプロイ)。",
);
