/**
 * 画像登録基盤 Phase 1 — Web UI / server action 境界アダプター。
 *
 * lib/photoRegistration/{ports,service,auth,awsRepository,awsStorage,types}.ts
 * (基盤・変更禁止) を Next.js の Server Action から呼べる形に束ねるだけの層。
 * ここでは新しい業務判断は行わない — 状態遷移・冪等性・権限判定は既存の
 * service.ts / state.ts / auth.ts がすべて持っている。このファイルが足すのは:
 *
 *   1. 実AWSクライアント (DynamoDB/S3) の構築。table名/bucket名が環境変数に
 *      無ければ **fail closed** — 例外を投げず、呼び出し側が判定できる
 *      `null` を返す (photo-batches用のテーブル/バケットはこのタスクの
 *      対象外であるamplify/backend.tsが未変更のため、実際には常に未設定)。
 *   2. Cognitoセッションから TrustedClaims (userId/groups) を作る。
 *      actorId/role/sourceTypeをクライアント入力から受け取らないという
 *      契約 (types.ts §1.1) を、ここでもCognito claims以外の経路を
 *      一切参照しないことで守る。
 *   3. 一覧/詳細の読み取り — service.ts が公開していない
 *      getBatchById/getAssetsForBatch を repository から直接呼び、
 *      表示用の署名GET URLをこのファイル内でS3 SDKから発行する
 *      (ports.ts の PhotoStoragePort は PUT/HEAD のみで GET を持たない —
 *      ports.ts/awsStorage.ts は変更禁止のため、GET はここに閉じる)。
 *   4. Web追加uploadのファイル名の危険拡張子チェック
 *      (lib/photoRegistration/validation.ts は mimeType/size/hash の形式しか
 *      見ず、fileNameの拡張子は見ていない)。
 *
 * `PhotoRegistrationWebAdapter` 自体は repository/service/presignGetUrl を
 * 注入されたただのクラスで、AWS SDK / next/headers を直接知らない —
 * scripts/verify-photo-registration-web.ts はこのクラスをフェイクの
 * repository/service/presignGetUrlで直接構築して試験する
 * (scripts/verify-photo-registration-api.tsと同じ考え方)。
 */
import "server-only";
import { cookies } from "next/headers";
import { fetchAuthSession } from "aws-amplify/auth/server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";
import { requestCache } from "@/lib/amplify/requestCache";
import { authorizeOperation, resolveActorContext, type AuthConfig } from "./auth";
import { DynamoPhotoRegistrationRepository } from "./awsRepository";
import { S3PhotoStorage } from "./awsStorage";
import type { BatchListPage, PhotoRegistrationRepository, TrustedClaims } from "./ports";
import { PhotoRegistrationService } from "./service";
import {
  err,
  extensionForMimeType,
  ok,
  photoAssetS3Key,
  PHOTO_REGISTRATION_REGION,
  type PhotoActorContext,
  type PhotoActorRole,
  type PhotoAssetView,
  type PhotoBatchView,
  type PhotoErrorCode,
  type PhotoResult,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────
// Web追加uploadのファイル名検証 (§ 契約はmimeType/size/hashのみを見る)。
// ─────────────────────────────────────────────────────────────────────────

/** 1回のWeb追加upload要求で許容するファイル数。契約上のchunk上限(25)より
 * 小さくして、Web UIからの1操作が常に1 requestPhotoAssetUploadsで収まる
 * 余地を残す。 */
export const MAX_WEB_UPLOAD_FILES_PER_REQUEST = 20;

/** 画像として許可しないファイル拡張子 (mimeTypeが偽装されていても、表示・
 * ダウンロード時に実行される可能性のある拡張子は拒否する)。 */
const DANGEROUS_EXTENSIONS = new Set([
  "exe", "bat", "cmd", "com", "cpl", "msi", "msp", "scr",
  "js", "jse", "vbs", "vbe", "ws", "wsf", "wsh",
  "ps1", "ps1xml", "psc1", "sh", "bash",
  "php", "phtml", "pl", "py", "rb", "jar", "apk", "dll", "sys",
  "svg", "html", "htm", "xhtml", "hta", "reg", "lnk", "gadget",
]);

/** 宣言済みmimeTypeごとに許す拡張子。mimeTypeとfileNameの拡張子が食い違う場合も拒否する。 */
const ALLOWED_EXTENSIONS_BY_MIME: Record<string, string[]> = {
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
};

export function validateWebUploadFileName(fileName: unknown, mimeType: unknown): PhotoResult<true> {
  if (typeof fileName !== "string" || typeof mimeType !== "string") return ok(true); // 形式不正はvalidation.ts側の責務
  const trimmed = fileName.trim();
  const lastDot = trimmed.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === trimmed.length - 1) {
    return err("INVALID_INPUT", "fileName must have a recognizable extension", "fileName");
  }
  const ext = trimmed.slice(lastDot + 1).toLowerCase();
  if (DANGEROUS_EXTENSIONS.has(ext)) {
    return err("INVALID_INPUT", `fileName extension ".${ext}" is not allowed`, "fileName");
  }
  const allowed = ALLOWED_EXTENSIONS_BY_MIME[mimeType];
  if (!allowed || !allowed.includes(ext)) {
    return err("INVALID_INPUT", `fileName extension ".${ext}" does not match declared mimeType ${mimeType}`, "fileName");
  }
  return ok(true);
}

interface RawUploadShape {
  assets?: unknown;
}
interface RawAssetShape {
  fileName?: unknown;
  processed?: { mimeType?: unknown };
}

function checkWebUploadShape(rawInput: unknown): PhotoResult<true> {
  if (typeof rawInput !== "object" || rawInput === null) return ok(true); // 形式検証はvalidation.ts側
  const assets = (rawInput as RawUploadShape).assets;
  if (!Array.isArray(assets)) return ok(true);
  if (assets.length > MAX_WEB_UPLOAD_FILES_PER_REQUEST) {
    return err("INVALID_INPUT", `一度に追加できる画像は${MAX_WEB_UPLOAD_FILES_PER_REQUEST}枚までです`, "assets");
  }
  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index] as RawAssetShape;
    const nameCheck = validateWebUploadFileName(asset?.fileName, asset?.processed?.mimeType);
    if (!nameCheck.ok) return { ...nameCheck, field: `assets[${index}].fileName` };
  }
  return ok(true);
}

// ─────────────────────────────────────────────────────────────────────────
// 読み取り専用ビュー (一覧/詳細)
// ─────────────────────────────────────────────────────────────────────────

export interface WebPhotoAssetView extends PhotoAssetView {
  /** 署名済みGET URL。presign自体に失敗した場合はnull (ページ全体は落とさない)。 */
  thumbnailUrl: string | null;
  processedUrl: string | null;
}

export interface WebBatchDetail {
  batch: PhotoBatchView;
  assets: WebPhotoAssetView[];
  totalAssetCount: number;
  page: number;
  pageSize: number;
  /** 復元(ADMIN限定)等、role依存のボタン表示をUI側で出し分けるための値。実際の許可判定は必ずservice側でも行われる。 */
  actorRole: PhotoActorRole;
}

export interface WebInventoryPhotoAssets {
  inventoryId: string;
  assets: WebPhotoAssetView[];
  batchCount: number;
  truncated: boolean;
}

export interface PhotoRegistrationWebDeps {
  service: PhotoRegistrationService;
  repository: PhotoRegistrationRepository;
  authConfig: AuthConfig;
  presignGetUrl: (s3Key: string) => Promise<string>;
}

export class PhotoRegistrationWebAdapter {
  constructor(private readonly deps: PhotoRegistrationWebDeps) {}

  private requireStaffOrAdmin(claims: TrustedClaims): PhotoResult<PhotoActorContext> {
    const actor = resolveActorContext(claims, this.deps.authConfig);
    if (!actor.ok) return actor;
    // listUnregisteredBatches/listBatchesForInventoryはどちらもSTAFF/ADMINのみ
    // (auth.ts ALLOWED_ROLES) — 読み取り全般のゲートとして同じroleの組を再利用する。
    const authz = authorizeOperation(actor.value, "listUnregisteredBatches");
    if (!authz.ok) return authz;
    return actor;
  }

  private async safePresign(s3Key: string): Promise<string | null> {
    try {
      return await this.deps.presignGetUrl(s3Key);
    } catch (error) {
      console.error("[PhotoRegistrationWebAdapter] presign failed", { s3Key, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  private async toWebAsset(asset: PhotoAssetView): Promise<WebPhotoAssetView> {
    // Both variants are independent signatures. Waiting for the thumbnail
    // before starting the processed image adds an avoidable signing round
    // trip to every photo detail view.
    const [thumbnailUrl, processedUrl] = await Promise.all([
      this.safePresign(photoAssetS3Key(asset.photoBatchId, asset.id, "THUMBNAIL", extensionForMimeType(asset.declared.THUMBNAIL.mimeType))),
      this.safePresign(photoAssetS3Key(asset.photoBatchId, asset.id, "PROCESSED", extensionForMimeType(asset.declared.PROCESSED.mimeType))),
    ]);
    return {
      ...asset,
      thumbnailUrl,
      processedUrl,
    };
  }

  async listUnregisteredBatches(limit: number, cursor: string | null, claims: TrustedClaims): Promise<PhotoResult<BatchListPage>> {
    return this.deps.service.listUnregisteredBatches(limit, cursor, claims);
  }

  /** 一覧用に代表画像1枚だけ署名する。削除済み画像は候補から外す。 */
  async getBatchCover(batchId: string, claims: TrustedClaims): Promise<PhotoResult<string | null>> {
    const actorResult = this.requireStaffOrAdmin(claims);
    if (!actorResult.ok) return actorResult;
    const batch = await this.deps.repository.getBatchById(batchId);
    if (!batch) return err("BATCH_NOT_FOUND", `batch ${batchId} was not found`, "batchId");
    const assets = (await this.deps.repository.getAssetsForBatch(batchId))
      .filter((asset) => !asset.isDeleted)
      .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
    const cover = assets.find((asset) => asset.inventoryIsPrimary) ?? assets[0];
    if (!cover) return ok(null);
    const thumbnail = await this.safePresign(photoAssetS3Key(batchId, cover.id, "THUMBNAIL", extensionForMimeType(cover.declared.THUMBNAIL.mimeType)));
    if (thumbnail) return ok(thumbnail);
    return ok(await this.safePresign(photoAssetS3Key(batchId, cover.id, "PROCESSED", extensionForMimeType(cover.declared.PROCESSED.mimeType))));
  }

  async getBatchDetail(
    batchId: string,
    claims: TrustedClaims,
    pagination: { page: number; pageSize: number },
  ): Promise<PhotoResult<WebBatchDetail>> {
    const actorResult = this.requireStaffOrAdmin(claims);
    if (!actorResult.ok) return actorResult;

    const batch = await this.deps.repository.getBatchById(batchId);
    if (!batch) return err("BATCH_NOT_FOUND", `batch ${batchId} was not found`, "batchId");

    const rawAssets = await this.deps.repository.getAssetsForBatch(batchId);
    rawAssets.sort((a, b) => a.sequence - b.sequence);

    const pageSize = Math.min(Math.max(Math.trunc(pagination.pageSize) || 1, 1), 100);
    const totalAssetCount = rawAssets.length;
    const pageCount = Math.max(1, Math.ceil(totalAssetCount / pageSize));
    const page = Math.min(Math.max(Math.trunc(pagination.page) || 1, 1), pageCount);
    const start = (page - 1) * pageSize;
    const pageItems = rawAssets.slice(start, start + pageSize);

    const assets = await Promise.all(pageItems.map((asset) => this.toWebAsset(asset)));

    return ok({ batch, assets, totalAssetCount, page, pageSize, actorRole: actorResult.value.role });
  }

  /** 商品詳細/Listing用。Inventoryへ紐付いた全batchをScanせずGSI経由で読む。 */
  async listInventoryPhotoAssets(inventoryId: string, claims: TrustedClaims): Promise<PhotoResult<WebInventoryPhotoAssets>> {
    const actorResult = this.requireStaffOrAdmin(claims);
    if (!actorResult.ok) return actorResult;
    const batches: PhotoBatchView[] = [];
    let cursor: string | null = null;
    let truncated = false;
    do {
      const page = await this.deps.repository.listBatchesForInventory(inventoryId, 100, cursor);
      batches.push(...page.items);
      cursor = page.nextCursor;
      if (batches.length >= 300 && cursor) {
        truncated = true;
        break;
      }
    } while (cursor);
    const rawAssets = (await Promise.all(batches.map((batch) => this.deps.repository.getAssetsForBatch(batch.id))))
      .flat()
      .filter((asset) => !asset.isDeleted && asset.status === "READY")
      .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
    return ok({ inventoryId, assets: await Promise.all(rawAssets.map((asset) => this.toWebAsset(asset))), batchCount: batches.length, truncated });
  }

  /**
   * 在庫一覧のカード画像用。listInventoryPhotoAssetsは1件のInventoryが持つ
   * 全Assetを署名する(サムネイル+本体の2枚/枚)ため、一覧の行数分そのまま
   * 呼ぶとN+1になる。ここでは行ごとにトップ画像(inventoryIsPrimary優先、
   * 無ければ先頭のNORMAL — lib/inventory/imageTypes.tsのresolveTopImageと
   * 同じ優先順位)のサムネイルURL1枚だけを解決し、複数inventoryIdをまとめて
   * 1回のserver actionで返せるようにする(呼び出し側は表示中のページの
   * 行数分=最大100件程度だけを渡す設計。lib/inventory/queries.tsの
   * fetchAllInventoryRecordsのような全件取得には絶対に使わない)。
   * バッチの列挙は1ページ(最大20件)まで — 1在庫に紐づくバッチは通常
   * 1〜数件で、詳細画面(listInventoryPhotoAssets)のような全ページ走査は
   * この軽量版では行わない。
   */
  async listPrimaryPhotoThumbnails(inventoryIds: string[], claims: TrustedClaims): Promise<PhotoResult<Record<string, string | null>>> {
    const actorResult = this.requireStaffOrAdmin(claims);
    if (!actorResult.ok) return actorResult;
    // server actionはクライアントから直接呼び出せるため、呼び出し元
    // (表示中の一覧ページ、最大100件)を信用せず、ここでも件数上限を
    // 強制する — 大量のinventoryIdを送りつけて並列DynamoDBクエリを
    // 大量発火させるDoSを防ぐ (fail closed、§1.1と同じ考え方)。
    if (!Array.isArray(inventoryIds) || inventoryIds.some((id) => typeof id !== "string")) {
      return err("INVALID_INPUT", "inventoryIds must be a string array", "inventoryIds");
    }
    const MAX_IDS = 200;
    if (inventoryIds.length > MAX_IDS) {
      return err("INVALID_INPUT", `inventoryIds exceeds limit of ${MAX_IDS}`, "inventoryIds");
    }
    const uniqueIds = [...new Set(inventoryIds)];
    // Keep the deferred lookup from turning a 100-row page into a burst of
    // hundreds of simultaneous DynamoDB/S3 operations. A small worker pool
    // still overlaps network latency while protecting the browser request and
    // the shared staging backend from throttling.
    const entries: Array<[string, string | null]> = new Array(uniqueIds.length);
    let nextIndex = 0;
    await Promise.all(Array.from({ length: Math.min(8, uniqueIds.length) }, async () => {
      while (nextIndex < uniqueIds.length) {
        const index = nextIndex++;
        const inventoryId = uniqueIds[index];
        try {
          const { items: batches } = await this.deps.repository.listBatchesForInventory(inventoryId, 20, null);
          if (batches.length === 0) { entries[index] = [inventoryId, null]; continue; }
          const rawAssets = (await Promise.all(batches.map((batch) => this.deps.repository.getAssetsForBatch(batch.id))))
            .flat()
            .filter((asset) => !asset.isDeleted && asset.status === "READY" && asset.inventoryImageType !== "DAMAGE");
          if (rawAssets.length === 0) { entries[index] = [inventoryId, null]; continue; }
          rawAssets.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
          const primary = rawAssets.find((asset) => asset.inventoryIsPrimary) ?? rawAssets[0];
          const url = await this.safePresign(
            photoAssetS3Key(primary.photoBatchId, primary.id, "THUMBNAIL", extensionForMimeType(primary.declared.THUMBNAIL.mimeType)),
          );
          entries[index] = [inventoryId, url];
        } catch (error) {
          // One broken inventory lookup must not blank all other thumbnails
          // in this chunk. The caller can still show its existing inventory
          // thumbnail for this one row.
          console.warn("Photo Registration thumbnail lookup failed", inventoryId, error instanceof Error ? error.message : String(error));
          entries[index] = [inventoryId, null];
        }
      }
    }));
    return ok(Object.fromEntries(entries));
  }

  /** requestPhotoAssetUploads のWeb向け薄いラッパー。ファイル名の危険拡張子だけこの層で追加検証する。 */
  async requestWebUploads(rawInput: unknown, claims: TrustedClaims): Promise<PhotoResult<{ batchId: string; revision: number; items: unknown[] }>> {
    const shapeCheck = checkWebUploadShape(rawInput);
    if (!shapeCheck.ok) return shapeCheck;
    return this.deps.service.requestPhotoAssetUploads(rawInput, claims);
  }

  async completeWebUpload(rawInput: unknown, claims: TrustedClaims): Promise<PhotoResult<{ photoAssetId: string; status: string }>> {
    return this.deps.service.completePhotoAssetUpload(rawInput, claims);
  }

  /**
   * バッチ (または追加uploadのrevision) を閉じる。枚数はクライアント申告
   * ではなく、直前に読み直したサーバー側manifestの expectedAssetCount を
   * そのまま使う — Web UIはアップロード対象の総数を信頼できる形で
   * 保持していないため (§1.1 信頼境界と同じ考え方: クライアント自己申告を
   * finalizeの根拠にしない)。
   */
  async finalizeWebUpload(batchId: string, claims: TrustedClaims): Promise<PhotoResult<{ batchId: string; status: string }>> {
    const batch = await this.deps.repository.getBatchById(batchId);
    if (!batch) return err("BATCH_NOT_FOUND", `batch ${batchId} was not found`, "batchId");
    return this.deps.service.completePhotoBatch(
      { batchId, imageCountProcessed: batch.manifest.expectedAssetCount, imageCountUploaded: batch.manifest.expectedAssetCount },
      claims,
    );
  }

  async deleteAsset(rawInput: unknown, claims: TrustedClaims): Promise<PhotoResult<{ photoAssetId: string }>> {
    return this.deps.service.deletePhotoAsset(rawInput, claims);
  }

  async restoreAsset(rawInput: unknown, claims: TrustedClaims): Promise<PhotoResult<{ photoAssetId: string; status: string }>> {
    return this.deps.service.restorePhotoAsset(rawInput, claims);
  }

  async linkToInventory(rawInput: unknown, claims: TrustedClaims): Promise<PhotoResult<{ batchId: string; status: string }>> {
    return this.deps.service.linkPhotoBatchToInventory(rawInput, claims);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 実AWSランタイムの構築 (fail closed)。
// ─────────────────────────────────────────────────────────────────────────

interface RuntimeConfig {
  tableName: string;
  inventoryTableName: string;
  bucketName: string;
  region: string;
}

/**
 * この画像登録機能専用のDynamoDBテーブル/S3バケットは、このタスクの対象外
 * である amplify/backend.ts・data/storage resource が未変更のため
 * **常に未デプロイ**。環境変数が無い間はnullを返し、呼び出し側
 * (app/actions/photoRegistration.ts) が「AWS未接続」として扱う — 推測で
 * AWSへ書き込み/読み取りを試みない (fail closed)。
 */
function readRuntimeConfigFromEnv(): RuntimeConfig | null {
  const tableName = process.env.PHOTO_REGISTRATION_TABLE_NAME;
  const inventoryTableName = process.env.PHOTO_REGISTRATION_INVENTORY_TABLE_NAME;
  const bucketName = process.env.PHOTO_REGISTRATION_BUCKET_NAME;
  if (!tableName || !inventoryTableName || !bucketName) return null;
  return { tableName, inventoryTableName, bucketName, region: process.env.PHOTO_REGISTRATION_AWS_REGION || PHOTO_REGISTRATION_REGION };
}

function buildPresignGetUrl(s3Client: S3Client, bucketName: string, expirySeconds: number): (s3Key: string) => Promise<string> {
  return async (s3Key: string) => {
    const command = new GetObjectCommand({ Bucket: bucketName, Key: s3Key });
    return getSignedUrl(s3Client, command, { expiresIn: expirySeconds });
  };
}

let cachedAdapter: PhotoRegistrationWebAdapter | null | undefined;

/**
 * 実運用シングルトン。S3Client/DynamoDBClientは資格情報を明示せず、
 * SDK既定のプロバイダチェーン (実行環境のIAMロール等) に任せる —
 * ブラウザはこのモジュールを一切importできない ("server-only") ので
 * AWS認証情報がクライアントへ渡ることはない。
 *
 * 設定が無い間 (現状は常にこう) は毎回nullを返すだけで、AWSクライアント
 * の構築自体を行わない。
 */
export function getPhotoRegistrationWebAdapter(): PhotoRegistrationWebAdapter | null {
  if (cachedAdapter !== undefined) return cachedAdapter;
  const config = readRuntimeConfigFromEnv();
  if (!config) {
    cachedAdapter = null;
    return null;
  }
  const ddbClient = new DynamoDBClient({ region: config.region });
  const ddb = DynamoDBDocumentClient.from(ddbClient);
  const s3Client = new S3Client({ region: config.region });
  const repository = new DynamoPhotoRegistrationRepository({
    ddb,
    tableName: config.tableName,
    inventoryTableName: config.inventoryTableName,
    now: () => new Date(),
  });
  const storage = new S3PhotoStorage({ s3Client, bucketName: config.bucketName });
  // PHOTO_DEVICE groupは未デプロイ (docs/photo-phase1-source/PHOTO-PHASE1-PREIMPLEMENTATION.md 領域4) —
  // Web UIはSTAFF/ADMINしか使わないため実害はないが、fail closedの原則どおりtrueにしない。
  const authConfig: AuthConfig = { photoDeviceGroupDeployed: false };
  const service = new PhotoRegistrationService({ repository, storage, authConfig });
  cachedAdapter = new PhotoRegistrationWebAdapter({
    service,
    repository,
    authConfig,
    presignGetUrl: buildPresignGetUrl(s3Client, config.bucketName, 900),
  });
  return cachedAdapter;
}

// ─────────────────────────────────────────────────────────────────────────
// TrustedClaims — Cognitoセッションから (lib/amplify/requireInventoryUser.ts
// のgetInventorySessionStatusと同じ手法、ただしgroupsを写像せず生のまま返す —
// PHOTO_DEVICE/ADMIN/STAFFへの写像はauth.tsのresolveActorContextの責務)。
// ─────────────────────────────────────────────────────────────────────────

export const getWebTrustedClaims = requestCache(async function getWebTrustedClaims(): Promise<TrustedClaims | null> {
  try {
    return await runWithAmplifyServerContext({
      nextServerContext: { cookies },
      operation: async (contextSpec) => {
        const session = await fetchAuthSession(contextSpec);
        if (!session.tokens) return null;
        const groups = (session.tokens.accessToken.payload["cognito:groups"] ?? []) as string[];
        const payload = session.tokens.idToken?.payload ?? session.tokens.accessToken.payload;
        const userId = (payload.email as string | undefined) ?? (payload.sub as string | undefined) ?? null;
        if (!userId) return null;
        // Web UIのセッションはPHOTO_DEVICE専用トークンを持たない (端末専用、§1.1)。
        return { userId, groups, deviceId: null };
      },
    });
  } catch {
    return null;
  }
});

export type { PhotoErrorCode };
