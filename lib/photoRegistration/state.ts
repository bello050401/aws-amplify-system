/**
 * 画像登録基盤 Phase 1 — 状態遷移の判断 (純粋)。
 *
 * 各 decide* は「現在の状態 (読み取りモデル) + 検証済み入力」を受け取り、
 * **永続化層が何を書けばよいか** を表す決定オブジェクトか、エラーを返す。
 * ここでは一切書き込まない・一切AWSを呼ばない。
 *
 * 【ローカル試験で証明できないこと】
 * 決定オブジェクトの `conditions` は、DynamoDB側で ConditionExpression /
 * TransactWriteItems として実装されなければならない前提条件である。
 * この層は「その条件が守られたなら、この遷移は正しい」と言うだけで、
 * 条件が実際に原子的に効いたかは判定できない。したがって
 * scripts/verify-photo-registration-contract.ts が通ることは、
 * **冪等性・競合防止がAWS上で成立していることの証明にはならない**。
 * 実証はstagingでの実DynamoDB/実S3による検証を要する (未実施)。
 */

import {
  MAX_ASSETS_PER_BATCH,
  assetHashKey,
  assetIdempotencyKey,
  batchIdempotencyKey,
  err,
  extensionForMimeType,
  ok,
  photoAssetS3Key,
  type AtomicCondition,
  type DeclaredObject,
  type PhotoActorContext,
  type PhotoAssetStatus,
  type PhotoAssetVariant,
  type PhotoAssetView,
  type PhotoBatchStatus,
  type PhotoBatchView,
  type PhotoResult,
  type ObservedS3Object,
} from "./types";
import type {
  ValidatedCompleteAssetUpload,
  ValidatedCompletePhotoBatch,
  ValidatedCreatePhotoBatch,
  ValidatedLinkBatchToInventory,
  ValidatedListingImageSelection,
  ValidatedUploadRequest,
} from "./validation";

const ALL_VARIANTS: PhotoAssetVariant[] = ["PROCESSED", "THUMBNAIL"];

/**
 * manifest (§7.6) のカウンタへの増減。Asset行の更新と**同一transaction**で適用すること。
 * expected が動くのは create (固定) と revision を開く時と論理削除/復元だけ。
 * registered (受理済み) と completed (S3検証済み) は別物なので混同しない。
 */
export interface ManifestDelta {
  expected: number;
  registered: number;
  completed: number;
  failed: number;
}

const NO_DELTA: ManifestDelta = { expected: 0, registered: 0, completed: 0, failed: 0 };

// ─────────────────────────────────────────────────────────────────────────
// PhotoBatchの遷移表 (§33)
// ─────────────────────────────────────────────────────────────────────────

/**
 * 許可された遷移のみ。LINKED -> UPLOADING は §33 で明示的に禁止。
 * READY_FOR_REVIEW / LINKED への追加upload (§13) はこの表を使わない —
 * statusを戻さず manifest.openRevision を開く方式にしているため
 * (types.ts PhotoBatchManifest.revision のコメント参照)。
 */
const ALLOWED_BATCH_TRANSITIONS: Record<PhotoBatchStatus, PhotoBatchStatus[]> = {
  CREATED: ["UPLOADING", "ARCHIVED", "ERROR"],
  UPLOADING: ["READY_FOR_REVIEW", "ERROR"],
  READY_FOR_REVIEW: ["LINKED", "ARCHIVED", "ERROR"],
  // 誤登録の解除 (§27) はPhase 2。ここではLINKEDからの出口を整理用のARCHIVEDだけに絞る。
  LINKED: ["ARCHIVED"],
  ARCHIVED: [],
  // §28: 失敗したuploadの再開。自動削除はしない。
  ERROR: ["UPLOADING", "ARCHIVED"],
};

export function canTransitionBatch(from: PhotoBatchStatus, to: PhotoBatchStatus): boolean {
  return ALLOWED_BATCH_TRANSITIONS[from].includes(to);
}

// ─────────────────────────────────────────────────────────────────────────
// createPhotoBatch (§7.1 / §30 / §93.5 ケースB)
// ─────────────────────────────────────────────────────────────────────────

export type CreatePhotoBatchDecision =
  | {
      kind: "CREATE_BATCH";
      idempotencyKey: string;
      status: Extract<PhotoBatchStatus, "CREATED">;
      input: ValidatedCreatePhotoBatch;
      conditions: AtomicCondition[];
    }
  | { kind: "RETURN_EXISTING"; batchId: string; status: PhotoBatchStatus; conditions: AtomicCondition[] };

/**
 * 同一 localImportSessionId の再送では新しいbatchを作らず既存を返す (§30)。
 *
 * `existing` は「決定的な冪等キーで引いた結果」でなければならない。GSIを
 * 検索して無ければCreate、では同時実行で重複batchが生まれる (§93.5 ケースB)
 * ため、CREATE_BATCHの conditions に attribute_not_exists を必ず付ける。
 * 条件が破れた (= 誰かが先に作った) 場合、呼び出し側は読み直して
 * RETURN_EXISTING と同じ応答を返すこと。これが唯一の正しいリトライ経路。
 */
export function decideCreatePhotoBatch(
  input: ValidatedCreatePhotoBatch,
  existing: PhotoBatchView | null,
): PhotoResult<CreatePhotoBatchDecision> {
  const idempotencyKey = batchIdempotencyKey(input.localImportSessionId);

  if (!existing) {
    return ok({
      kind: "CREATE_BATCH",
      idempotencyKey,
      status: "CREATED",
      input,
      conditions: [
        {
          target: `PhotoIdempotency#${idempotencyKey}`,
          predicate: "attribute_not_exists(pk)",
          violationError: "CONFLICT",
        },
      ],
    });
  }

  // 同じsessionIdで「別の取込内容」が来るのは、ローカル側のキー生成が壊れて
  // いるか別SDを同じsessionIdで送っている。黙って既存を返すと、その後の
  // uploadが意図しないbatchへ入るため、ここで止める。
  // clientVersionだけは再送の途中でPhoto Stationが更新され得るので比較しない。
  const conflicts: string[] = [];
  if (existing.sourceDeviceId !== input.sourceDeviceId) conflicts.push("sourceDeviceId");
  if (existing.sourceSdCardId !== input.sourceSdCardId) conflicts.push("sourceSdCardId");
  // 予定枚数の変更も競合。後から減らせると、送り終えていない分を切り捨てて
  // finalizeできてしまう (§7.6 の「途中再開時に不足が分かる」が壊れる)。
  // originalExpectedAssetCount (createPhotoBatchで固定した不変値) と比較する —
  // expectedAssetCountは追加upload revisionや論理削除/復元で増減するため、これと
  // 直接比較すると、追加/削除後に送られた「元のcreate要求そのものの再送」まで
  // IDEMPOTENCY_CONFLICTにしてしまう。不変値なのでrevisionの状態を問わず比較できる。
  if (existing.manifest.originalExpectedAssetCount !== input.expectedAssetCount) {
    conflicts.push("expectedAssetCount");
  }
  if (conflicts.length > 0) {
    return err(
      "IDEMPOTENCY_CONFLICT",
      `localImportSessionId ${input.localImportSessionId} was already used with different ${conflicts.join(", ")}`,
      "localImportSessionId",
    );
  }

  return ok({ kind: "RETURN_EXISTING", batchId: existing.id, status: existing.status, conditions: [] });
}

// ─────────────────────────────────────────────────────────────────────────
// requestPhotoAssetUploads (§7.2 / §7.5 / §31 / §13)
// ─────────────────────────────────────────────────────────────────────────

export interface UploadTarget {
  variant: PhotoAssetVariant;
  s3Key: string;
  /** presigned PUTへ固定すべき値 (§5.5)。Content-Length/Content-Type/checksumを署名条件に含める。 */
  expectedBytes: number;
  expectedMimeType: string;
  expectedSha256: string;
}

export type UploadItemDecision =
  /** 新規PhotoAsset。s3Keyは allocateAssetId が返したIDで確定し、以後不変 (§1.3)。 */
  | {
      kind: "CREATE_ASSET";
      clientAssetId: string;
      photoAssetId: string;
      fileName: string;
      sequence: number;
      revision: number;
      declared: Record<PhotoAssetVariant, DeclaredObject>;
      uploads: UploadTarget[];
      idempotencyKey: string;
      hashKey: string;
    }
  /** 同一clientAssetId・同一hashの再送 (通信断・PC再起動後)。同じAsset・同じキーへURLを再発行する。 */
  | {
      kind: "REISSUE_UPLOAD";
      clientAssetId: string;
      photoAssetId: string;
      uploads: UploadTarget[];
    }
  /** 既に検証済みでREADY。URLを再発行するとS3上の検証済みオブジェクトを上書きできてしまうので発行しない。 */
  | { kind: "ALREADY_READY"; clientAssetId: string; photoAssetId: string }
  /** batch内に同一sha256Processedの別Assetが既にある (§31)。新規作成せず既存を返す。expectedは増えない。 */
  | { kind: "DUPLICATE_SKIP"; clientAssetId: string; photoAssetId: string; duplicateOfClientAssetId: string };

export interface RequestUploadsDecision {
  batchId: string;
  items: UploadItemDecision[];
  /** registered = CREATE_ASSETの件数 (DUPLICATE_SKIP/REISSUEは含まない)。expectedはrevisionを開く時だけ動く。 */
  manifestDelta: ManifestDelta;
  /** CREATED -> UPLOADING の遷移が必要なら次のstatus。不要ならnull。 */
  nextBatchStatus: PhotoBatchStatus | null;
  /** 追加uploadで新しく開く/既に開いているrevision番号。 */
  revision: number;
  opensRevision: boolean;
  conditions: AtomicCondition[];
}

export interface RequestUploadsContext {
  batch: PhotoBatchView;
  /** このbatchの全PhotoAsset (論理削除済みも含む)。sequence採番と重複判定に使う。 */
  assets: PhotoAssetView[];
  /** 新規Assetに与えるID (ULID等) の採番。決定オブジェクトへS3キーまで含めて確定させるために外から注入する。 */
  allocateAssetId: (indexInRequest: number) => string;
}

function buildUploadTargets(
  batchId: string,
  photoAssetId: string,
  declared: Record<PhotoAssetVariant, DeclaredObject>,
): UploadTarget[] {
  return ALL_VARIANTS.map((variant) => {
    const object = declared[variant];
    return {
      variant,
      s3Key: photoAssetS3Key(batchId, photoAssetId, variant, extensionForMimeType(object.mimeType)),
      expectedBytes: object.fileSize,
      expectedMimeType: object.mimeType,
      expectedSha256: object.sha256,
    };
  });
}

/**
 * 25件までのchunkについて、1件ずつ「新規作成 / 再発行 / 完了済み / 重複SKIP」を決める。
 *
 * - 300枚上限は **論理削除されていないAssetの数** で判定する (§12の論理削除が
 *   枠を食い続けないように)。301枚目は ASSET_LIMIT_EXCEEDED。
 * - 同一clientAssetIdでhashが変わった再送は IDEMPOTENCY_CONFLICT。ここを
 *   許すとS3の既存オブジェクトを別の画像で上書きでき、検証済みのcompleted
 *   カウントが嘘になる。
 * - READY_FOR_REVIEW / LINKED のbatchへ **新規Assetを追加できるのは
 *   Web追加upload (§13) だけ**。Photo Stationが確認済みbatchへ勝手に追加
 *   すると、レビュー済みという前提が崩れる。
 */
export function decideRequestUploads(
  input: ValidatedUploadRequest,
  context: RequestUploadsContext,
): PhotoResult<RequestUploadsDecision> {
  const { batch, assets } = context;

  if (batch.id !== input.batchId) {
    return err("BATCH_NOT_FOUND", `batch ${input.batchId} was not found`, "batchId");
  }
  if (batch.status === "ARCHIVED") {
    return err("INVALID_STATUS_TRANSITION", "cannot upload into an ARCHIVED batch", "batchId");
  }

  const byClientAssetId = new Map(assets.map((asset) => [asset.clientAssetId, asset]));
  const activeByProcessedHash = new Map(
    assets.filter((a) => !a.isDeleted).map((a) => [a.declared.PROCESSED.sha256, a]),
  );
  const activeCount = assets.filter((a) => !a.isDeleted).length;
  const nextSequenceBase = assets.reduce((max, a) => Math.max(max, a.sequence), -1) + 1;

  const isAfterReview = batch.status === "READY_FOR_REVIEW" || batch.status === "LINKED";
  const openRevision = batch.manifest.openRevision;
  const opensNewRevision = isAfterReview && openRevision === null;

  // 開いているrevisionへの再送で違う追加予定数を送ってきたら、どちらが正か
  // 決められない。同じ値の再送は冪等に受理し、追加予定を二重加算しない。
  if (openRevision !== null && input.additionalExpectedCount !== null && input.additionalExpectedCount !== openRevision.expectedDelta) {
    return err(
      "CONFLICT",
      `revision ${openRevision.revision} was opened with additionalExpectedCount ${openRevision.expectedDelta}`,
      "additionalExpectedCount",
    );
  }

  const additionalExpected = opensNewRevision ? input.additionalExpectedCount ?? 0 : 0;
  /** この要求までに確定している予定枚数。requestUploadsはここを超えられない。 */
  const planLimit = batch.manifest.expectedAssetCount + additionalExpected;
  const registered = batch.manifest.registeredAssetCount;
  const itemRevision = isAfterReview ? openRevision?.revision ?? batch.manifest.revision + 1 : batch.manifest.revision;

  const items: UploadItemDecision[] = [];
  let created = 0;

  for (const requested of input.assets) {
    const existingByClient = byClientAssetId.get(requested.clientAssetId);

    if (existingByClient) {
      const sameProcessedHash =
        existingByClient.declared.PROCESSED.sha256 === requested.declared.PROCESSED.sha256;
      if (!sameProcessedHash) {
        return err(
          "IDEMPOTENCY_CONFLICT",
          `clientAssetId ${requested.clientAssetId} already exists in this batch with a different processed sha256`,
          "assets",
        );
      }
      if (existingByClient.isDeleted) {
        // 削除済みAssetのclientAssetIdを再利用させない。復元はrestore APIの仕事で、
        // ここで作り直すと同じ冪等キーの行が2つ必要になる。
        return err(
          "IDEMPOTENCY_CONFLICT",
          `clientAssetId ${requested.clientAssetId} refers to a deleted asset; use restore or a new clientAssetId`,
          "assets",
        );
      }
      if (existingByClient.status === "READY") {
        items.push({
          kind: "ALREADY_READY",
          clientAssetId: requested.clientAssetId,
          photoAssetId: existingByClient.id,
        });
        continue;
      }
      items.push({
        kind: "REISSUE_UPLOAD",
        clientAssetId: requested.clientAssetId,
        photoAssetId: existingByClient.id,
        uploads: buildUploadTargets(batch.id, existingByClient.id, existingByClient.declared),
      });
      continue;
    }

    const duplicate = activeByProcessedHash.get(requested.declared.PROCESSED.sha256);
    if (duplicate) {
      items.push({
        kind: "DUPLICATE_SKIP",
        clientAssetId: requested.clientAssetId,
        photoAssetId: duplicate.id,
        duplicateOfClientAssetId: duplicate.clientAssetId,
      });
      continue;
    }

    if (isAfterReview && input.sourceType !== "WEB_UPLOAD") {
      return err(
        "INVALID_STATUS_TRANSITION",
        `batch ${batch.id} is ${batch.status}; only WEB_UPLOAD may add new assets after review`,
        "assets",
      );
    }
    if (opensNewRevision && input.additionalExpectedCount === null) {
      // 追加uploadは「開始時に追加予定数を固定する」操作。固定しないと
      // 追加分がいつ揃ったのか判定できない。
      return err(
        "INVALID_INPUT",
        "additionalExpectedCount is required to open an additional upload revision",
        "additionalExpectedCount",
      );
    }
    if (activeCount + created + 1 > MAX_ASSETS_PER_BATCH) {
      return err(
        "ASSET_LIMIT_EXCEEDED",
        `batch ${batch.id} would exceed ${MAX_ASSETS_PER_BATCH} assets`,
        "assets",
      );
    }
    if (registered + created + 1 > planLimit) {
      // 予定枚数はcreateで固定済み。requestUploadsでは増やさない (§7.6)。
      return err(
        "ASSET_LIMIT_EXCEEDED",
        `batch ${batch.id} plans ${planLimit} assets and already registered ${registered + created}`,
        "assets",
      );
    }

    const photoAssetId = context.allocateAssetId(created);
    const revision = itemRevision;
    items.push({
      kind: "CREATE_ASSET",
      clientAssetId: requested.clientAssetId,
      photoAssetId,
      fileName: requested.fileName,
      sequence: nextSequenceBase + created,
      revision,
      declared: requested.declared,
      uploads: buildUploadTargets(batch.id, photoAssetId, requested.declared),
      idempotencyKey: assetIdempotencyKey(batch.id, requested.clientAssetId),
      hashKey: assetHashKey(batch.id, requested.declared.PROCESSED.sha256),
    });
    created += 1;
  }

  const opensRevision = opensNewRevision && created > 0;
  const revision = isAfterReview
    ? openRevision?.revision ?? batch.manifest.revision + (created > 0 ? 1 : 0)
    : batch.manifest.revision;

  const conditions: AtomicCondition[] = [];
  if (created > 0) {
    conditions.push(
      {
        target: `PhotoAssetIdempotency#(batch,clientAssetId)`,
        predicate: "attribute_not_exists(pk)",
        violationError: "IDEMPOTENCY_CONFLICT",
      },
      {
        // 重複hashの判定をGSI検索だけで行うと、同時に同じ画像が来たとき両方
        // 通る (結果整合)。hashKeyへの条件付きPutで排他する (§31)。
        target: `PhotoAssetHash#(batch,sha256Processed)`,
        predicate: "attribute_not_exists(pk)",
        violationError: "CONFLICT",
      },
      {
        // 読取時の予定枚数と受理済み数を条件にする。並行するchunkが先に
        // 受理されていたら失敗させ、読み直させる (予定超過を作らない)。
        target: `PhotoBatch#${batch.id}`,
        predicate: `#status = '${batch.status}' AND expectedAssetCount = ${batch.manifest.expectedAssetCount} AND registeredAssetCount <= ${planLimit - created}`,
        violationError: "ASSET_LIMIT_EXCEEDED",
      },
    );
    if (opensRevision) {
      conditions.push({
        // revisionを開くのは1回だけ。並行要求が二重に追加予定を足さない。
        target: `PhotoBatch#${batch.id}`,
        predicate: "attribute_not_exists(openRevision)",
        violationError: "CONFLICT",
      });
    }
  }

  return ok({
    batchId: batch.id,
    items,
    manifestDelta: { expected: opensRevision ? additionalExpected : 0, registered: created, completed: 0, failed: 0 },
    // ERRORからの再開 (§28) もここを通る。自動でERRORのまま放置しない。
    nextBatchStatus: (batch.status === "CREATED" || batch.status === "ERROR") && created > 0 ? "UPLOADING" : null,
    revision,
    opensRevision,
    conditions,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// completePhotoAssetUpload (§7.3 / §5.5)
// ─────────────────────────────────────────────────────────────────────────

export type CompleteAssetDecision =
  | {
      kind: "MARK_READY";
      photoAssetId: string;
      nextAssetStatus: Extract<PhotoAssetStatus, "READY">;
      manifestDelta: ManifestDelta;
      conditions: AtomicCondition[];
    }
  /** 既にREADYで、報告内容も一致。二重送信は成功として扱い、カウンタは動かさない。 */
  | { kind: "NO_OP"; photoAssetId: string; manifestDelta: ManifestDelta };

/**
 * 「クライアントが完了と言っただけ」でREADYにしない (§5.5)。
 * observed は **サーバーがS3へHEADして得た実測値** でなければならない。
 * この関数はHEADを行わない — 行えないことを型で示すために引数にしている。
 */
export function decideCompleteAssetUpload(
  input: ValidatedCompleteAssetUpload,
  context: { batch: PhotoBatchView; asset: PhotoAssetView; observed: ObservedS3Object[] },
): PhotoResult<CompleteAssetDecision> {
  const { batch, asset, observed } = context;

  if (asset.id !== input.photoAssetId) {
    return err("ASSET_NOT_FOUND", `asset ${input.photoAssetId} was not found`, "photoAssetId");
  }
  if (asset.isDeleted) {
    return err("ASSET_NOT_FOUND", `asset ${input.photoAssetId} is deleted`, "photoAssetId");
  }
  if (batch.status === "ARCHIVED") {
    return err("INVALID_STATUS_TRANSITION", `batch ${batch.id} is ARCHIVED`, "photoAssetId");
  }

  // 宣言された内容と違うものを完了報告してきた場合 (= 別の画像を同じAssetへ
  // 入れようとしている)。S3側の実測を見るまでもなく拒否する。
  for (const variant of ALL_VARIANTS) {
    const declared = asset.declared[variant];
    const reported = input.completions[variant];
    if (reported.sha256 !== declared.sha256) {
      return err(
        "HASH_MISMATCH",
        `${variant} sha256 does not match the value declared at requestPhotoAssetUploads`,
        variant.toLowerCase(),
      );
    }
    if (reported.fileSize !== declared.fileSize) {
      return err(
        "INVALID_INPUT",
        `${variant} fileSize does not match the value declared at requestPhotoAssetUploads`,
        `${variant.toLowerCase()}.fileSize`,
      );
    }
  }

  if (asset.status === "READY") {
    // 宣言値と一致することは上で確認済み。完全な再送なので冪等に成功を返す。
    return ok({ kind: "NO_OP", photoAssetId: asset.id, manifestDelta: NO_DELTA });
  }
  if (asset.status !== "UPLOADING" && asset.status !== "FAILED") {
    return err(
      "INVALID_STATUS_TRANSITION",
      `asset ${asset.id} is ${asset.status} and cannot be completed`,
      "photoAssetId",
    );
  }

  for (const variant of ALL_VARIANTS) {
    const declared = asset.declared[variant];
    const head = observed.find((o) => o.variant === variant);
    if (!head || !head.exists) {
      return err("UPLOAD_NOT_COMPLETE", `${variant} object does not exist in S3`, variant.toLowerCase());
    }
    if (head.contentLength !== declared.fileSize) {
      return err(
        "UPLOAD_NOT_COMPLETE",
        `${variant} object size ${head.contentLength ?? "unknown"} does not match the declared ${declared.fileSize}`,
        variant.toLowerCase(),
      );
    }
    if (head.contentType !== null && head.contentType !== declared.mimeType) {
      return err(
        "UPLOAD_NOT_COMPLETE",
        `${variant} object content-type ${head.contentType} does not match the declared ${declared.mimeType}`,
        variant.toLowerCase(),
      );
    }
    if (head.sha256 === null) {
      // presigned PUTをChecksumSHA256付きで発行していれば必ず取得できる。
      // 取れないということは検証条件が成立していない = READYにしてはいけない。
      return err(
        "UPLOAD_NOT_COMPLETE",
        `${variant} object has no verifiable checksum; re-upload using the checksum-bound presigned URL`,
        variant.toLowerCase(),
      );
    }
    if (head.sha256 !== declared.sha256) {
      return err("HASH_MISMATCH", `${variant} object checksum does not match the declared sha256`, variant.toLowerCase());
    }
  }

  return ok({
    kind: "MARK_READY",
    photoAssetId: asset.id,
    nextAssetStatus: "READY",
    manifestDelta: { expected: 0, registered: 0, completed: 1, failed: asset.status === "FAILED" ? -1 : 0 },
    conditions: [
      {
        // 同じcompleteが並行して2回届いてもcompletedAssetCountが2増えないための唯一の防御。
        // 論理削除との競合 (削除がcompletedを減らした直後の加算) もここで弾く。
        target: `PhotoAsset#${asset.id}`,
        predicate: `#status = '${asset.status}' AND isDeleted = false`,
        violationError: "CONFLICT",
      },
      {
        target: `PhotoBatch#${batch.id}`,
        predicate: `completedAssetCount <= ${batch.manifest.expectedAssetCount - 1}`,
        violationError: "CONFLICT",
      },
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────
// completePhotoBatch (§7.4 / §29 / §7.6)
// ─────────────────────────────────────────────────────────────────────────

export type CompletePhotoBatchDecision =
  | {
      kind: "MARK_READY_FOR_REVIEW";
      batchId: string;
      /** LINKEDのbatchの追加upload完了では **LINKEDを維持する**。READY_FOR_REVIEWへ戻すと未登録一覧へ復活し、紐付けが消えたように見える。 */
      nextBatchStatus: Extract<PhotoBatchStatus, "READY_FOR_REVIEW" | "LINKED">;
      closesRevision: number | null;
      conditions: AtomicCondition[];
    }
  /** 既にREADY_FOR_REVIEW/LINKEDで追加revisionも無い。二重送信は成功として扱う。 */
  | { kind: "NO_OP"; batchId: string; status: PhotoBatchStatus };

/**
 * finalizeは **DB上のmanifestの集計だけ** で判定し、全AssetへHEADを投げ直さない
 * (§7.4 / §93.5 ケースC: 300オブジェクトへの再HEADはLambda timeoutの原因)。
 * 各AssetのS3実在確認は decideCompleteAssetUpload の時点で1件ずつ済んでいる。
 */
export function decideCompletePhotoBatch(
  input: ValidatedCompletePhotoBatch,
  batch: PhotoBatchView,
): PhotoResult<CompletePhotoBatchDecision> {
  if (batch.id !== input.batchId) {
    return err("BATCH_NOT_FOUND", `batch ${input.batchId} was not found`, "batchId");
  }
  if (batch.status === "ARCHIVED") {
    return err("INVALID_STATUS_TRANSITION", `batch ${batch.id} is ARCHIVED`, "batchId");
  }

  const { expectedAssetCount, registeredAssetCount, completedAssetCount, failedAssetCount, openRevision } = batch.manifest;

  if ((batch.status === "READY_FOR_REVIEW" || batch.status === "LINKED") && openRevision === null) {
    return ok({ kind: "NO_OP", batchId: batch.id, status: batch.status });
  }

  // §79「SD差分0枚」。空のbatchを未登録一覧へ出しても確認しようがないので、
  // READY_FOR_REVIEWへは進めない。運用上は ARCHIVED (破棄) にする。
  if (expectedAssetCount === 0) {
    return err("EMPTY_BATCH", `batch ${batch.id} has no assets to review`, "batchId");
  }

  // クライアントの主張とサーバーのmanifestが食い違う場合は黙って通さない。
  // 重複SKIP (§31) があるとクライアント側の枚数の方が多くなるため、
  // requestPhotoAssetUploadsの応答 (DUPLICATE_SKIP) を数えた重複除去後の値を送ること。
  if (input.imageCountProcessed !== expectedAssetCount || input.imageCountUploaded !== expectedAssetCount) {
    return err(
      "CONFLICT",
      `client reported ${input.imageCountProcessed}/${input.imageCountUploaded} but the server manifest expects ${expectedAssetCount} (duplicates are skipped, see DUPLICATE_SKIP)`,
      "imageCountProcessed",
    );
  }

  // 受理済みが予定に満たないまま完了させない (§7.6)。
  // 300枚予定で25枚しかrequestUploadsしていない状態はここで止まる。
  if (failedAssetCount > 0 || registeredAssetCount !== expectedAssetCount || completedAssetCount !== expectedAssetCount) {
    return err(
      "UPLOAD_NOT_COMPLETE",
      `${expectedAssetCount} expected / ${registeredAssetCount} registered / ${completedAssetCount} completed / ${failedAssetCount} failed`,
      "batchId",
    );
  }

  // LINKEDのrevision完了はLINKEDのまま閉じる。それ以外はREADY_FOR_REVIEWへ。
  const nextBatchStatus = batch.status === "LINKED" ? "LINKED" : "READY_FOR_REVIEW";
  if (nextBatchStatus === "READY_FOR_REVIEW" && batch.status !== "READY_FOR_REVIEW" && !canTransitionBatch(batch.status, "READY_FOR_REVIEW")) {
    return err(
      "INVALID_STATUS_TRANSITION",
      `batch ${batch.id} cannot move from ${batch.status} to READY_FOR_REVIEW`,
      "batchId",
    );
  }

  return ok({
    kind: "MARK_READY_FOR_REVIEW",
    batchId: batch.id,
    nextBatchStatus,
    closesRevision: openRevision?.revision ?? null,
    conditions: [
      {
        // 読取時のstatusとrevisionも条件にする。finalize中にlinkが成立した場合は
        // 失敗させて読み直させる (LINKEDをREADY_FOR_REVIEWへ巻き戻さない)。
        // 並行する追加uploadがrevisionを開いた場合も同様に失敗する。
        target: `PhotoBatch#${batch.id}`,
        predicate: `#status = '${batch.status}' AND revision = ${batch.manifest.revision} AND expectedAssetCount = ${expectedAssetCount} AND registeredAssetCount = ${expectedAssetCount} AND completedAssetCount = ${expectedAssetCount} AND failedAssetCount = 0`,
        violationError: "CONFLICT",
      },
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────
// linkPhotoBatchToInventory (§18 / §59 / §93.5 ケースE)
// ─────────────────────────────────────────────────────────────────────────

export interface LinkBatchDecision {
  kind: "LINK";
  batchId: string;
  inventoryId: string;
  nextBatchStatus: Extract<PhotoBatchStatus, "LINKED">;
  /** §4.6: PhotoAssetは1件も更新しない。300枚でも書込みはbatch 1行 + AuditLog 1行。 */
  assetWrites: 0;
  conditions: AtomicCondition[];
}

export function decideLinkBatchToInventory(
  input: ValidatedLinkBatchToInventory,
  context: { batch: PhotoBatchView; inventory: { id: string; exists: boolean; isDeleted: boolean } },
): PhotoResult<LinkBatchDecision> {
  const { batch, inventory } = context;

  if (batch.id !== input.batchId) {
    return err("BATCH_NOT_FOUND", `batch ${input.batchId} was not found`, "batchId");
  }
  if (!inventory.exists || inventory.isDeleted || inventory.id !== input.inventoryId) {
    return err("INVENTORY_NOT_FOUND", `inventory ${input.inventoryId} was not found`, "inventoryId");
  }
  // 先に「既に紐付いている」を見る。READY_FOR_REVIEW以外という理由より
  // 具体的で、UI・Photo Stationのどちらも分岐しやすい (§59 二重登録防止)。
  if (batch.inventoryId !== null || batch.status === "LINKED") {
    return err("BATCH_ALREADY_LINKED", `batch ${batch.id} is already linked to an inventory item`, "batchId");
  }
  if (batch.status !== "READY_FOR_REVIEW") {
    return err(
      "INVALID_STATUS_TRANSITION",
      `batch ${batch.id} is ${batch.status}; only READY_FOR_REVIEW can be linked`,
      "batchId",
    );
  }
  if (batch.manifest.openRevision !== null) {
    return err(
      "UPLOAD_NOT_COMPLETE",
      `batch ${batch.id} has an unfinished additional upload (revision ${batch.manifest.openRevision.revision})`,
      "batchId",
    );
  }

  return ok({
    kind: "LINK",
    batchId: batch.id,
    inventoryId: input.inventoryId,
    nextBatchStatus: "LINKED",
    assetWrites: 0,
    conditions: [
      {
        // 2人が同時に登録してもどちらか一方しか通らない。後勝ちで上書きさせない。
        // openRevisionが無いことも同じ条件で見る — 追加uploadの開始と競合すると
        // 未検証の画像を含んだまま紐付いてしまう。
        target: `PhotoBatch#${batch.id}`,
        predicate: "attribute_not_exists(inventoryId) AND #status = 'READY_FOR_REVIEW' AND attribute_not_exists(openRevision)",
        violationError: "BATCH_ALREADY_LINKED",
      },
      {
        // 「存在確認してからUpdate」ではlink中にInventoryが消える余地が残る。
        // 論理削除済みの在庫への紐付けも同時に拒否する。
        target: `Inventory#${input.inventoryId}`,
        predicate: "attribute_exists(id) AND isDeleted <> true",
        violationError: "INVENTORY_NOT_FOUND",
      },
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────
// 論理削除 / 復元 (§12 / §68 / §67)
// ─────────────────────────────────────────────────────────────────────────

export type DeleteAssetDecision =
  | {
      kind: "SOFT_DELETE";
      photoAssetId: string;
      nextAssetStatus: Extract<PhotoAssetStatus, "DELETED">;
      statusBeforeDelete: PhotoAssetStatus;
      manifestDelta: ManifestDelta;
      /** S3オブジェクトは消さない (§12)。物理削除は別ジョブ・明示操作。 */
      deletesS3Object: false;
      conditions: AtomicCondition[];
    }
  | { kind: "NO_OP"; photoAssetId: string; manifestDelta: ManifestDelta };

/**
 * 削除でmanifestのexpectedも一緒に減らすのが要点。
 * completedだけ減らすと completed == expected が永久に成立せず、
 * 追加uploadのfinalizeが二度と通らなくなる。
 *
 * `activeListingSelectionCount` は **PhotoAsset行自身に持つ参照カウンタ** を
 * 読んだ値であること。ListingImageSelectionのGSIを逆引きしただけの値は
 * 結果整合で古くなり得るため、削除の可否判定には使えない (§68)。
 */
export function decideDeleteAsset(
  context: { asset: PhotoAssetView; activeListingSelectionCount: number },
): PhotoResult<DeleteAssetDecision> {
  const { asset, activeListingSelectionCount } = context;

  if (asset.isDeleted) {
    return ok({ kind: "NO_OP", photoAssetId: asset.id, manifestDelta: NO_DELTA });
  }
  if (activeListingSelectionCount > 0) {
    // §68: 警告して続行ではなくブロックする。外すのはListing側の明示操作。
    return err(
      "ASSET_IN_USE",
      `asset ${asset.id} is used by ${activeListingSelectionCount} listing selection(s); remove it from the listing first`,
      "photoAssetId",
    );
  }

  return ok({
    kind: "SOFT_DELETE",
    photoAssetId: asset.id,
    nextAssetStatus: "DELETED",
    statusBeforeDelete: asset.status,
    manifestDelta: {
      expected: -1,
      registered: -1,
      completed: asset.status === "READY" ? -1 : 0,
      failed: asset.status === "FAILED" ? -1 : 0,
    },
    deletesS3Object: false,
    conditions: [
      {
        // 読取時のstatusも条件にする — 判断の後にcompleteが通ると
        // completedを減らすべきか否かが変わり、manifestが壊れる。
        target: `PhotoAsset#${asset.id}`,
        predicate: `isDeleted = false AND #status = '${asset.status}' AND listingSelectionCount = 0`,
        violationError: "ASSET_IN_USE",
      },
    ],
  });
}

export interface RestoreAssetDecision {
  kind: "RESTORE";
  photoAssetId: string;
  nextAssetStatus: PhotoAssetStatus;
  manifestDelta: ManifestDelta;
  conditions: AtomicCondition[];
}

export function decideRestoreAsset(
  context: { asset: PhotoAssetView; batch: PhotoBatchView; activeAssetCount: number; actor: PhotoActorContext },
): PhotoResult<RestoreAssetDecision> {
  const { asset, batch, activeAssetCount, actor } = context;

  // §47: 復元はADMINのみ。roleは認証済みコンテキストの値で、クライアントの申告ではない。
  if (actor.role !== "ADMIN") {
    return err("PERMISSION_DENIED", "restoring a deleted asset requires ADMIN", "photoAssetId");
  }
  // 別batchのAssetを渡されていないか照合する (呼び出し側の取り違えでmanifestが別batchのものになる)。
  if (asset.photoBatchId !== batch.id) {
    return err("ASSET_NOT_FOUND", `asset ${asset.id} does not belong to batch ${batch.id}`, "photoAssetId");
  }
  if (!asset.isDeleted) {
    return err("ASSET_NOT_DELETED", `asset ${asset.id} is not deleted`, "photoAssetId");
  }
  if (batch.status === "ARCHIVED") {
    return err("INVALID_STATUS_TRANSITION", `batch ${batch.id} is ARCHIVED`, "photoAssetId");
  }
  if (activeAssetCount + 1 > MAX_ASSETS_PER_BATCH) {
    return err(
      "ASSET_LIMIT_EXCEEDED",
      `restoring would exceed ${MAX_ASSETS_PER_BATCH} assets in batch ${batch.id}`,
      "photoAssetId",
    );
  }

  // 削除前の状態へ戻す。記録が無い (この機能より前の行) 場合は、検証済みと
  // 断定できないのでUPLOADINGへ戻し、再completeで検証させる。
  const nextAssetStatus: PhotoAssetStatus = asset.statusBeforeDelete ?? "UPLOADING";
  return ok({
    kind: "RESTORE",
    photoAssetId: asset.id,
    nextAssetStatus,
    manifestDelta: {
      expected: 1,
      registered: 1,
      completed: nextAssetStatus === "READY" ? 1 : 0,
      failed: nextAssetStatus === "FAILED" ? 1 : 0,
    },
    conditions: [
      {
        target: `PhotoAsset#${asset.id}`,
        predicate: `isDeleted = true AND #status = 'DELETED' AND statusBeforeDelete = '${nextAssetStatus}'`,
        violationError: "CONFLICT",
      },
      {
        target: `PhotoBatch#${batch.id}`,
        predicate: `expectedAssetCount <= ${MAX_ASSETS_PER_BATCH - 1}`,
        violationError: "ASSET_LIMIT_EXCEEDED",
      },
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Listing画像選択 (§21 / §45 / §68)
// ─────────────────────────────────────────────────────────────────────────

export interface ListingSelectionRow {
  photoAssetId: string;
  sequence: number;
  isPrimary: boolean;
}

export interface ListingSelectionDecision {
  kind: "REPLACE_SELECTION";
  listingId: string;
  rows: ListingSelectionRow[];
  /** 参照カウンタの増減。削除との競合を排他するため、選択行の書込みと同一transactionで行う。 */
  refCountIncrements: string[];
  refCountDecrements: string[];
  nextSelectionRevision: number;
  conditions: AtomicCondition[];
}

/**
 * 出品で使う画像の選択を丸ごと置き換える。順序 = 配列順、先頭がメイン (§45)。
 * 既存のListingDraft.images (storageKeyのJSON配列) は触らない — 新旧併存
 * (正本§37 選択肢C) を保つため、PhotoAssetを参照する選択だけを独立行にする。
 */
export function decideListingImageSelection(
  input: ValidatedListingImageSelection,
  context: {
    /** 選択対象の候補。listingの対象Inventoryへ紐付いたbatchのAssetのみを渡すこと。 */
    assets: PhotoAssetView[];
    /** そのAssetが属するbatchのinventoryId。null = 未紐付け。 */
    batchInventoryIdByAssetId: Record<string, string | null>;
    listingInventoryId: string;
    currentSelection: string[];
    /** 読取時の選択の版番号。置換はこの値を条件にする。 */
    selectionRevision: number;
  },
): PhotoResult<ListingSelectionDecision> {
  const assetById = new Map(context.assets.map((asset) => [asset.id, asset]));

  for (let index = 0; index < input.photoAssetIds.length; index += 1) {
    const id = input.photoAssetIds[index];
    const field = `photoAssetIds[${index}]`;
    const asset = assetById.get(id);
    if (!asset) return err("ASSET_NOT_FOUND", `asset ${id} was not found`, field);
    if (asset.isDeleted || asset.status !== "READY") {
      return err("INVALID_STATUS_TRANSITION", `asset ${id} is ${asset.isDeleted ? "DELETED" : asset.status} and cannot be listed`, field);
    }
    if (context.batchInventoryIdByAssetId[id] !== context.listingInventoryId) {
      return err("CONFLICT", `asset ${id} belongs to a batch that is not linked to inventory ${context.listingInventoryId}`, field);
    }
  }

  const next = new Set(input.photoAssetIds);
  const current = new Set(context.currentSelection);

  return ok({
    kind: "REPLACE_SELECTION",
    listingId: input.listingId,
    rows: input.photoAssetIds.map((photoAssetId, index) => ({
      photoAssetId,
      sequence: index,
      isPrimary: index === 0,
    })),
    refCountIncrements: input.photoAssetIds.filter((id) => !current.has(id)),
    refCountDecrements: context.currentSelection.filter((id) => !next.has(id)),
    nextSelectionRevision: context.selectionRevision + 1,
    conditions: [
      {
        // 読取時の選択の版を条件にする。2人が同時に置換すると、両方が同じ
        // 「旧選択」を基準に減算し、参照カウンタが実際より小さくなる
        // (= 使用中の画像が削除できてしまう)。版が違えば失敗させ読み直させる。
        target: `ListingImageSelectionState#${input.listingId}`,
        predicate: `selectionRevision = ${context.selectionRevision}`,
        violationError: "CONFLICT",
      },
      {
        // 選択しようとした瞬間に管理者が削除していた場合を排他する。
        // 削除側 (decideDeleteAsset) は listingSelectionCount = 0 を条件にしているので、
        // 両者は同じカウンタを挟んで必ずどちらか一方だけが成功する。
        target: "PhotoAsset#(each selected asset)",
        predicate: "isDeleted = false AND #status = 'READY'",
        violationError: "ASSET_NOT_FOUND",
      },
    ],
  });
}
