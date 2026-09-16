/**
 * 画像登録基盤 Phase 1 — API契約の型・定数・エラーコード。
 *
 * 【この層の位置づけ】
 * 正本「自社システム画像登録機能.txt」(v3.0 Final Draft) の §7 / §91 の
 * API契約を、AWSへ一切変更を加えずにコードとして固定するための層。
 * **ここで定義しているのは「未デプロイの候補契約 (candidate, v1-draft)」**
 * であり、AppSync schema・Lambda・DynamoDBテーブル・IAM・S3のいずれも
 * まだ存在しない。Photo Station側の実装はこの契約が承認・デプロイされる
 * までこれを最終仕様として扱ってはならない (docs/photo-registration-api-v1.md)。
 *
 * このディレクトリ配下は **純粋関数のみ** で構成する:
 * - types.ts      … 契約 (入出力の形・境界値・エラーコード・S3キー規則)
 * - validation.ts … 入力の形式検証 (永続化状態を見ない)
 * - state.ts      … 現在状態 + 検証済み入力 → 遷移判断 (永続化しない)
 *
 * AWS SDK・Amplify・fetch・crypto・Date.now への依存を持たせない。
 * 「S3に本当にobjectがあるか」「DynamoDBの条件付き書込みが本当に原子的か」
 * は **この層では絶対に判定できない**。前者は完了APIの入力として観測結果を
 * 受け取る形 (ObservedS3Object) にし、後者は各判断が返す
 * {@link AtomicCondition} として「永続化層が満たすべき条件」を宣言するに
 * とどめる。ローカルの合成試験はこの宣言の整合性を見るだけであり、
 * DynamoDBの原子性を検証したことには **ならない**。
 */

/** 契約バージョン。未デプロイの候補である旨をコード側にも残す (§60 API versioning)。 */
export const PHOTO_REGISTRATION_CONTRACT_VERSION = "v1-draft";

/**
 * 現行環境のregion。正本§2は us-east-1 と書いているが、実環境
 * (amplify_outputs.json) は us-west-2 であり、既存画像・既存bucketを
 * 移転しないため現行を正とする (調査書§14領域12)。
 */
export const PHOTO_REGISTRATION_REGION = "us-west-2";

// ─────────────────────────────────────────────────────────────────────────
// 境界値 (§7.5 / §75 / §4.5)
// ─────────────────────────────────────────────────────────────────────────

/** 1 PhotoBatchが保持できる論理削除されていないPhotoAssetの上限 (§93.5 ケースA: 300枚級を想定)。 */
export const MAX_ASSETS_PER_BATCH = 300;

/**
 * requestPhotoAssetUploads 1回のchunk上限 (§7.5 推奨A)。
 * 300件の巨大Mutationを禁止するのが目的なので、上限そのものが契約。
 * 26件は境界外として拒否する。
 */
export const MAX_UPLOAD_REQUEST_CHUNK = 25;

/** processed JPEGの上限 (§75「例 25MB以下」)。presigned PUTのContent-Length上限として使う (§5.5)。 */
export const MAX_PROCESSED_BYTES = 25 * 1024 * 1024;

/** thumbnailの上限。processedと同じ上限を与える理由がないため別値 (§24: 400〜800px想定)。 */
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

/** 画素数の上限。異常値・型の取り違え (bytes値をwidthへ入れる等) を弾くためだけの安全網。 */
export const MAX_IMAGE_DIMENSION = 20000;

/** Photo Stationが送るprocessedは原則JPEG (§74)。 */
export const PHOTO_STATION_PROCESSED_MIME_TYPES = ["image/jpeg"] as const;

/** Web追加uploadはユーザーの手元ファイルなのでPNG/WebPも許容する (§74)。危険な拡張子・RAWはここに無い＝拒否。 */
export const WEB_UPLOAD_PROCESSED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/** thumbnailは表示専用の派生画像なのでJPEG固定 (§24)。 */
export const THUMBNAIL_MIME_TYPES = ["image/jpeg"] as const;

/** sha256は小文字hex 64桁に正規化する。冪等キーとして文字列比較するため、大文字混在を許すと同一画像が別物になる。 */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

// ─────────────────────────────────────────────────────────────────────────
// 列挙 (§4.1 / §4.2 / §32 / §36)
// ─────────────────────────────────────────────────────────────────────────

export type PhotoBatchStatus =
  | "CREATED"
  | "UPLOADING"
  | "READY_FOR_REVIEW"
  | "LINKED"
  | "ARCHIVED"
  | "ERROR";

export type PhotoAssetStatus = "UPLOADING" | "READY" | "FLAGGED" | "DELETED" | "FAILED";

/**
 * 1つのPhotoAssetが持つS3オブジェクトの種類。
 * **processedとthumbnailは同一のPhotoAsset (同一clientAssetId/photoAssetId) に帰属する**
 * — 正本§7.2のサンプルは type:"PROCESSED" と1枚ずつ書いているが、そのままでは
 * thumbnailが別Assetとして二重計上され、manifestの予定枚数が合わなくなる
 * (調査書「APIで固定すべき契約」)。よって契約ではAsset単位で両variantの
 * 署名URLを同時に発行し、両方の検証が通った時だけ1件としてREADY計上する。
 * originalはPhase 1でAWSへ送らない (§6)。
 */
export type PhotoAssetVariant = "PROCESSED" | "THUMBNAIL";

/** §36。Photo Station経由かWeb画面からの追加uploadかを区別する。権限・許容MIMEが異なる。 */
export type PhotoAssetSourceType = "PHOTO_STATION" | "WEB_UPLOAD";

/** §47 の Role。 */
export type PhotoActorRole = "ADMIN" | "STAFF" | "PHOTO_DEVICE";

/**
 * **信頼境界**: 実行主体は認証済みサーバーコンテキスト (Cognito claims) から
 * 作ること。クライアントのrequest本体から actorId / role / sourceType を
 * 受け取ってはいけない — 受け取ると端末が自分をADMINと名乗れる。
 * validation.ts の Validated* (= 外部入力) には意図的に含めていない。
 */
export interface PhotoActorContext {
  actorId: string;
  role: PhotoActorRole;
}

/** sourceTypeもクライアント宣言ではなく認証主体から導出する (§36 / §47)。 */
export function sourceTypeForActor(role: PhotoActorRole): PhotoAssetSourceType {
  return role === "PHOTO_DEVICE" ? "PHOTO_STATION" : "WEB_UPLOAD";
}

/**
 * §32のエラーコード群 + 契約上必要になった追加分。
 * ローカルPhoto Stationが機械的に分岐できるよう、文字列を固定する。
 * リトライ可否は docs/photo-registration-api-v1.md の表を正とする。
 */
export type PhotoErrorCode =
  // §32 に明記のあるもの
  | "AUTH_REQUIRED"
  | "BATCH_NOT_FOUND"
  | "BATCH_ALREADY_LINKED"
  | "ASSET_NOT_FOUND"
  | "UPLOAD_NOT_COMPLETE"
  | "HASH_MISMATCH"
  | "INVALID_STATUS_TRANSITION"
  | "INVENTORY_NOT_FOUND"
  | "PERMISSION_DENIED"
  | "CONFLICT"
  | "INTERNAL_ERROR"
  // 追加分 (§32は「例」であり網羅ではない)
  /** 入力の形式そのものが不正。リトライしても同じ結果になる。 */
  | "INVALID_INPUT"
  /** 同一localImportSessionId / 同一clientAssetIdで、前回と異なる内容が送られた (§8 冪等性)。 */
  | "IDEMPOTENCY_CONFLICT"
  /** 1 batchあたり300枚 (MAX_ASSETS_PER_BATCH) を超える。 */
  | "ASSET_LIMIT_EXCEEDED"
  /** 1 chunkが25件 (MAX_UPLOAD_REQUEST_CHUNK) を超える。 */
  | "CHUNK_TOO_LARGE"
  /** 0枚のbatchをREADY_FOR_REVIEWにしようとした (§79 SD差分0枚)。 */
  | "EMPTY_BATCH"
  /** ListingImageSelectionから参照されているPhotoAssetの削除 (§68: 警告ではなくブロック)。 */
  | "ASSET_IN_USE"
  /** 削除されていないAssetの復元など、復元の前提を満たさない。 */
  | "ASSET_NOT_DELETED"
  /** チャネルごとの選択枚数上限超過 (§22)。 */
  | "CHANNEL_IMAGE_LIMIT_EXCEEDED";

// ─────────────────────────────────────────────────────────────────────────
// 結果型
// ─────────────────────────────────────────────────────────────────────────

export interface PhotoOk<T> {
  ok: true;
  value: T;
}

export interface PhotoErr {
  ok: false;
  error: PhotoErrorCode;
  /** 管理者・ログ向けの技術的説明。§49によりこの文字列をそのままエンドユーザーへ出さない。 */
  message: string;
  /** 入力起因のエラーで、問題のあったフィールドパス (例: "assets[3].processed.sha256")。 */
  field?: string;
}

export type PhotoResult<T> = PhotoOk<T> | PhotoErr;

export function ok<T>(value: T): PhotoOk<T> {
  return { ok: true, value };
}

export function err(error: PhotoErrorCode, message: string, field?: string): PhotoErr {
  return field === undefined ? { ok: false, error, message } : { ok: false, error, message, field };
}

/**
 * 永続化層 (DynamoDB / S3) が **原子的に** 満たさなければならない条件。
 *
 * 純粋関数側は「この条件が満たされる前提でこう遷移してよい」と判断するだけで、
 * 条件が実際に守られたかは知り得ない。GSIで検索してから書く方式は
 * 結果整合の遅延で破れる (§93.5 ケースB / 調査書の削除×選択競合) ため、
 * ここに挙がった条件は必ず ConditionExpression / TransactWriteItems で
 * 表現すること。predicateはそのまま実装時のConditionExpressionの元になる。
 */
export interface AtomicCondition {
  /** 条件を掛ける対象。"PhotoBatch#<id>" / "PhotoIdempotency#<key>" / "PhotoAsset#<id>" など。 */
  target: string;
  /**
   * 満たすべき述語の**説明**。そのまま ConditionExpression として実行できる
   * 文字列ではない (DynamoDBは `expectedAssetCount + 1 <= 300` のような算術を
   * 条件式に書けない)。算術は呼び出し側で計算し、境界値との比較
   * (`expectedAssetCount <= 299`) として実装すること。ここでも計算済みの
   * 境界値で書く。破れた場合に返すべきエラーは violationError。
   */
  predicate: string;
  /** predicateが破れた (ConditionalCheckFailed) ときにクライアントへ返すエラーコード。 */
  violationError: PhotoErrorCode;
}

// ─────────────────────────────────────────────────────────────────────────
// 読み取りモデル (純粋関数への入力。DB行そのものではなく、判断に必要な射影)
// ─────────────────────────────────────────────────────────────────────────

/**
 * PhotoBatchのmanifest (§7.6)。
 * expected は「重複sha256を除去した後の、この取込で登録予定の枚数」。
 * completed/failed はPhotoAsset側の実数の集計値で、**永続化層がAsset更新と
 * 同一transactionで加算する** (別々に書くと通信断で恒久的にズレる)。
 */
export interface PhotoBatchManifest {
  /**
   * **この取込で登録する予定の枚数。createPhotoBatchで固定する** (§7.6)。
   * requestUploadsでは増えない — 増える設計だと「300枚予定で25枚しか送れて
   * いない」状態が expected=25 として完結し、不足が表示できない。
   * 増えるのは追加upload (§13) のrevisionを開く時だけ。
   */
  expectedAssetCount: number;
  /**
   * createPhotoBatchで最初に固定した値そのもの。**revisionを開いても/閉じても、
   * 論理削除・復元があっても変わらない** — expectedAssetCountはそれらで増減するため、
   * 同一localImportSessionIdの再送が「元のcreatePhotoBatch要求」であることの判定に
   * expectedAssetCountを直接使うと、追加upload後の正当な再送まで
   * IDEMPOTENCY_CONFLICTにしてしまう (decideCreatePhotoBatch参照)。
   */
  originalExpectedAssetCount: number;
  /** requestUploadsで受理済みのAsset数 (重複除去後)。完了数とは別物。 */
  registeredAssetCount: number;
  completedAssetCount: number;
  failedAssetCount: number;
  /**
   * 追加upload (§13) のたびに増える版番号。0 = Photo Stationの初回取込。
   * READY_FOR_REVIEW到達後の追加は「batchをUPLOADINGへ戻す」のではなく
   * revisionを開く形にする — 戻すと確認済みの既存READY画像が
   * レビュー対象から外れ、§AA「追加upload中の既存画像保全」を破るため。
   */
  revision: number;
  /** 未確定の追加manifestがある場合のみ非null。finalizeで閉じる。 */
  openRevision: { revision: number; expectedDelta: number } | null;
}

/** 判断に必要な範囲だけのPhotoBatch射影。 */
export interface PhotoBatchView {
  id: string;
  batchCode: string;
  status: PhotoBatchStatus;
  /** ローカル側の冪等キー (§7.1)。 */
  localImportSessionId: string;
  sourceDeviceId: string | null;
  sourceSdCardId: string | null;
  clientVersion: string | null;
  manifest: PhotoBatchManifest;
  /** §4.6 に従い Inventoryとの関係はここだけが正。PhotoAsset側には複製しない。 */
  inventoryId: string | null;
}

/** 判断に必要な範囲だけのPhotoAsset射影。**inventoryIdは意図的に存在しない** (§4.6)。 */
export interface PhotoAssetView {
  id: string;
  photoBatchId: string;
  /** Photo Station / Web UI が採番する、batch内で一意なクライアント側ID。再送の同一性判定に使う。 */
  clientAssetId: string;
  sequence: number;
  status: PhotoAssetStatus;
  isDeleted: boolean;
  /**
   * 論理削除 (§12) の直前の状態。復元 (§Z-3「deleted assetの復元」) で
   * どこへ戻すかを決めるために保持する — DELETEDから常にREADYへ戻すと、
   * uploadを完了していなかったAssetが検証なしでREADYになってしまう。
   */
  statusBeforeDelete: PhotoAssetStatus | null;
  sourceType: PhotoAssetSourceType;
  /** requestUploads時に宣言された、各variantの期待値。completeはこれと突き合わせる。 */
  declared: Record<PhotoAssetVariant, DeclaredObject>;
  /** どのrevisionで追加されたAssetか。追加upload失敗時に既存を巻き込まないための識別。 */
  revision: number;
}

/** requestUploads時にクライアントが宣言する1オブジェクト分のメタ情報。 */
export interface DeclaredObject {
  mimeType: string;
  fileSize: number;
  sha256: string;
}

/**
 * completePhotoAssetUpload時に **サーバー側が実際にS3へHEADして得た** 観測結果 (§5.5)。
 * 「クライアントが完了と言っただけ」でREADYにしないための唯一の根拠であり、
 * これを純粋関数の引数にすることで「ローカル試験ではS3実在を検証していない」
 * 事実が型の上でも明示される。
 */
export interface ObservedS3Object {
  variant: PhotoAssetVariant;
  exists: boolean;
  contentLength: number | null;
  /** S3のChecksumSHA256 / metadata から得たsha256 (小文字hex)。取得できなければnull。 */
  sha256: string | null;
  contentType: string | null;
}

// ─────────────────────────────────────────────────────────────────────────
// S3キー規則 (§5 / §54)
// ─────────────────────────────────────────────────────────────────────────

const VARIANT_PREFIX: Record<PhotoAssetVariant, string> = {
  PROCESSED: "processed",
  THUMBNAIL: "thumbnail",
};

/**
 * photo-batches/{batchId}/{processed|thumbnail}/{assetId}.jpg (§5)。
 *
 * - 商品名・ブランド名・日本語を含めない (§5)。
 * - 登録後も移動しない (§1.3)。Inventoryへ紐付けてもキーは不変。
 * - 既存の inventory/* 配下 (手動アップロード・ZAICO同期・加工済み) とは
 *   prefixが完全に分かれており、既存画像の参照経路に一切干渉しない
 *   (調査書 領域10)。
 * - 拡張子はvariantによらずjpg — processedはJPEG固定 (§74)。Web追加upload
 *   でPNG/WebPを受ける場合のみ拡張子が変わるため引数で受け取る。
 */
export function photoAssetS3Key(
  batchId: string,
  assetId: string,
  variant: PhotoAssetVariant,
  extension = "jpg",
): string {
  return `photo-batches/${batchId}/${VARIANT_PREFIX[variant]}/${assetId}.${extension}`;
}

/** MIMEからS3キーの拡張子を決める。許容MIME以外はvalidationで先に落ちる前提。 */
export function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return "jpg";
  }
}

/**
 * 冪等レコードの決定的キー (§7.1 / §8)。
 * 「GSIで検索して無ければCreate」は同時実行で重複batchを作る (§93.5 ケースB) ため、
 * この決定的キーに対する条件付きPut (attribute_not_exists) でしか一意性を作らない。
 */
export function batchIdempotencyKey(localImportSessionId: string): string {
  return `SESSION#${localImportSessionId}`;
}

/** batch内でclientAssetIdを一意化するための決定的キー。 */
export function assetIdempotencyKey(batchId: string, clientAssetId: string): string {
  return `BATCH#${batchId}#CLIENT#${clientAssetId}`;
}

/** batch内のsha256重複検出 (§31) 用の決定的キー。別batchの同一hashは許容するのでbatchIdを含める。 */
export function assetHashKey(batchId: string, sha256Processed: string): string {
  return `BATCH#${batchId}#SHA#${sha256Processed}`;
}
