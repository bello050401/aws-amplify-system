/**
 * 画像登録基盤 Phase 1 — API境界Lambdaハンドラの**候補実装**。
 *
 * まだデプロイされていない (resource.ts冒頭コメント参照)。AppSyncの
 * Lambda direct resolver形式を前提にしている: `event.info.fieldName` で
 * operationを判別し、`event.identity.claims` から信頼済みCognito claimsを
 * 作り、`event.arguments.input` をそのままservice.tsへ渡す。
 *
 * 【信頼境界 (§1.1)】actorId/role/sourceTypeはこのファイルがCognito
 * claimsから作る。`event.arguments.input` に同名フィールドが含まれていても
 * service.ts/validation.tsはそれを読まない。
 *
 * 【fail closed】テーブル名・バケット名が環境変数に無ければ、Lambdaの
 * INIT (モジュール評価) 時点で例外を投げてコールドスタートを失敗させる —
 * 「設定漏れのまま動き、権限だけ緩く見える」状態を作らない。
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoPhotoRegistrationRepository } from "../../../lib/photoRegistration/awsRepository";
import { S3PhotoStorage } from "../../../lib/photoRegistration/awsStorage";
import { PhotoRegistrationService } from "../../../lib/photoRegistration/service";
import type { AuthConfig } from "../../../lib/photoRegistration/auth";
import type { TrustedClaims } from "../../../lib/photoRegistration/ports";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured (fail closed, see docs/photo-registration-deployment-plan.md)`);
  return value;
}

// モジュール評価時 (コールドスタート) に一度だけ検証する。未設定ならこの
// Lambdaは呼び出しを一切処理できない状態で失敗する (fail closed)。
const TABLE_NAME = requireEnv("PHOTO_REGISTRATION_TABLE_NAME");
const INVENTORY_TABLE_NAME = requireEnv("INVENTORY_TABLE_NAME");
const BUCKET_NAME = requireEnv("PHOTO_REGISTRATION_BUCKET_NAME");

// PHOTO_DEVICE groupはまだAWS側に存在しない (docs/photo-registration-deployment-plan.md §Cognito)。
// 明示的に "true" が設定されるまでfail closed — 存在しないgroupを信用してPHOTO_DEVICE権限を与えない。
const AUTH_CONFIG: AuthConfig = { photoDeviceGroupDeployed: process.env.PHOTO_DEVICE_GROUP_DEPLOYED === "true" };

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const repository = new DynamoPhotoRegistrationRepository({
  ddb,
  tableName: TABLE_NAME,
  inventoryTableName: INVENTORY_TABLE_NAME,
  now: () => new Date(),
});
const storage = new S3PhotoStorage({ s3Client: s3, bucketName: BUCKET_NAME });
const service = new PhotoRegistrationService({ repository, storage, authConfig: AUTH_CONFIG });

interface AppSyncIdentity {
  sub?: string;
  claims?: Record<string, unknown>;
}

interface AppSyncEvent {
  info: { fieldName: string };
  arguments: Record<string, unknown>;
  identity?: AppSyncIdentity;
}

/**
 * AppSync/Cognito claimsからTrustedClaimsを作る。
 * `cognito:groups` は配列 (Cognito User Poolのグループ所属)。
 * `custom:deviceId` はPHOTO_DEVICE専用ユーザーにのみ設定される想定の
 * カスタム属性 (未適用、docs/photo-registration-deployment-plan.md参照)。
 */
function toTrustedClaims(identity: AppSyncIdentity | undefined): TrustedClaims {
  const claims = identity?.claims ?? {};
  const groups = claims["cognito:groups"];
  return {
    userId: identity?.sub ?? (claims.sub as string | undefined) ?? "",
    groups: Array.isArray(groups) ? (groups as string[]) : [],
    deviceId: (claims["custom:deviceId"] as string | undefined) ?? null,
  };
}

export const handler = async (event: AppSyncEvent) => {
  if (!event.identity) {
    // §1.1: 認証済みサーバーコンテキストが無ければ即拒否。VIEWER以下の
    // 未認証呼び出しをservice.ts側の役割判定へ流さない。
    return { error: { code: "AUTH_REQUIRED", message: "no authenticated identity on this request" } };
  }
  const claims = toTrustedClaims(event.identity);
  const input = event.arguments?.input ?? {};

  const result = await dispatch(event.info.fieldName, input, claims);
  if (!result.ok) return { error: { code: result.error, message: result.message, field: result.field ?? null } };
  return { data: result.value };
};

async function dispatch(fieldName: string, input: unknown, claims: TrustedClaims) {
  switch (fieldName) {
    case "createPhotoBatch":
      return service.createPhotoBatch(input, claims);
    case "requestPhotoAssetUploads":
      return service.requestPhotoAssetUploads(input, claims);
    case "completePhotoAssetUpload":
      return service.completePhotoAssetUpload(input, claims);
    case "completePhotoBatch":
      return service.completePhotoBatch(input, claims);
    case "linkPhotoBatchToInventory":
      return service.linkPhotoBatchToInventory(input, claims);
    case "deletePhotoAsset":
      return service.deletePhotoAsset(input, claims);
    case "restorePhotoAsset":
      return service.restorePhotoAsset(input, claims);
    case "listUnregisteredBatches": {
      const args = input as { limit?: number; cursor?: string | null };
      return service.listUnregisteredBatches(args.limit ?? 20, args.cursor ?? null, claims);
    }
    case "listBatchesForInventory": {
      const args = input as { inventoryId: string; limit?: number; cursor?: string | null };
      return service.listBatchesForInventory(args.inventoryId, args.limit ?? 20, args.cursor ?? null, claims);
    }
    // setListingImageSelectionはlistingInventoryId/maxImagesという既存Listing
    // 由来の値を要求する (service.ts参照) — このLambda単体では解決できないため、
    // 呼び出し口をAppSync pipeline resolver (先にListingDraftを引くstep) にする
    // か、Next.js server action側でservice.tsを直接importして呼ぶ方が自然。
    // Phase 1候補実装ではこのfieldNameは意図的に未対応のままにする。
    default:
      return { ok: false as const, error: "INTERNAL_ERROR" as const, message: `unknown operation ${fieldName}` };
  }
}
