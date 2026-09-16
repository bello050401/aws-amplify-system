/**
 * 画像登録基盤 Phase 1 — 認証・認可 (純粋)。
 *
 * §1.1 信頼境界: actorId/role はクライアントのrequest本体からではなく、
 * 認証済みサーバーコンテキスト (Cognito claims) から作る。
 * このファイルはその変換と、operationごとの許可role・PHOTO_DEVICEの
 * batch所属チェックだけを行う。AWS SDK・ネットワークには依存しない。
 *
 * 【既存Cognito groupとの対応】
 * 既存 (amplify/auth/resource.ts) には ADMIN / EDITOR / VIEWER がある。
 * PHOTO_DEVICE相当の端末専用groupはまだ存在しない (未承認・未適用、
 * docs/photo-registration-deployment-plan.md参照)。デプロイされるまでは
 * `resolveActorRole` はPHOTO_DEVICEを申告するclaimsを拒否する
 * (fail closed — 存在しないgroupを信用してPHOTO_DEVICE権限を与えない)。
 */

import { err, ok, type PhotoActorContext, type PhotoActorRole, type PhotoErrorCode, type PhotoResult } from "./types";
import type { TrustedClaims } from "./ports";

/** §47の3 role。既存Cognito groupのADMIN/EDITORをADMIN/STAFFへ写像する。VIEWERは常に拒否 (読み取りAPIも含め、この層に到達させない)。 */
const GROUP_TO_ROLE: Record<string, PhotoActorRole> = {
  ADMIN: "ADMIN",
  Admins: "ADMIN",
  EDITOR: "STAFF",
  PHOTO_DEVICE: "PHOTO_DEVICE",
};

export interface AuthConfig {
  /** PHOTO_DEVICE groupがAWS側へ実在するか。未デプロイの間はfalseにしてfail closedにする。 */
  photoDeviceGroupDeployed: boolean;
}

/**
 * claims.groups から最も強い role を1つ選ぶ。
 * 複数groupを持つ場合はADMIN > STAFF > PHOTO_DEVICEの順で強い方を優先する
 * (Inventory管理者がPHOTO_DEVICE groupへ誤って入っていても権限を落とさない)。
 * どのgroupにも一致しなければ VIEWER 相当として PERMISSION_DENIED。
 */
export function resolveActorContext(claims: TrustedClaims, config: AuthConfig): PhotoResult<PhotoActorContext> {
  const roles = new Set<PhotoActorRole>();
  for (const group of claims.groups) {
    const role = GROUP_TO_ROLE[group];
    if (!role) continue;
    if (role === "PHOTO_DEVICE" && !config.photoDeviceGroupDeployed) continue;
    roles.add(role);
  }
  if (roles.has("ADMIN")) return ok({ actorId: claims.userId, role: "ADMIN" });
  if (roles.has("STAFF")) return ok({ actorId: claims.userId, role: "STAFF" });
  if (roles.has("PHOTO_DEVICE")) return ok({ actorId: claims.userId, role: "PHOTO_DEVICE" });
  // VIEWER、または画像登録に関係するgroupを一つも持たないセッション。
  return err("PERMISSION_DENIED", "caller has no PHOTO_DEVICE/STAFF/ADMIN role for photo registration");
}

export type PhotoRegistrationOperation =
  | "createPhotoBatch"
  | "requestPhotoAssetUploads"
  | "completePhotoAssetUpload"
  | "completePhotoBatch"
  | "linkPhotoBatchToInventory"
  | "deletePhotoAsset"
  | "restorePhotoAsset"
  | "setListingImageSelection"
  | "listUnregisteredBatches"
  | "listBatchesForInventory";

/**
 * operationごとの許可role (§47)。
 * PHOTO_DEVICEは撮影バッチのupload系のみ (§25.1「Inventory変更権限は不要」)。
 * 復元はADMIN限定 (§47、state.ts decideRestoreAssetでも二重に強制)。
 * 読み取り専用一覧はSTAFF/ADMINのみ (§9 左メニュー「画像登録」は業務担当向け)。
 */
const ALLOWED_ROLES: Record<PhotoRegistrationOperation, PhotoActorRole[]> = {
  createPhotoBatch: ["PHOTO_DEVICE"],
  requestPhotoAssetUploads: ["PHOTO_DEVICE", "STAFF", "ADMIN"],
  completePhotoAssetUpload: ["PHOTO_DEVICE", "STAFF", "ADMIN"],
  completePhotoBatch: ["PHOTO_DEVICE", "STAFF", "ADMIN"],
  linkPhotoBatchToInventory: ["STAFF", "ADMIN"],
  deletePhotoAsset: ["STAFF", "ADMIN"],
  restorePhotoAsset: ["ADMIN"],
  setListingImageSelection: ["STAFF", "ADMIN"],
  listUnregisteredBatches: ["STAFF", "ADMIN"],
  listBatchesForInventory: ["STAFF", "ADMIN"],
};

export function authorizeOperation(actor: PhotoActorContext, operation: PhotoRegistrationOperation): PhotoResult<true> {
  if (!ALLOWED_ROLES[operation].includes(actor.role)) {
    return err("PERMISSION_DENIED", `role ${actor.role} is not allowed to call ${operation}`);
  }
  return ok(true);
}

/**
 * PHOTO_DEVICEは自分のsourceDeviceIdが作成したbatch以外へ書き込めない。
 *
 * 正本の契約自体にはこのチェックは無いが、盗まれた/誤発行された端末認証情報
 * 1つで他機の撮影バッチを操作できてしまうのは§25.1「最小権限」の趣旨に反する
 * ため、この層で追加する (state.tsのdecide*が受け取るbatchはこのチェックを
 * 通過した後の前提とする)。STAFF/ADMINにはこの制約を適用しない
 * (Web確認画面はbatchのsourceDeviceIdを意識しない、§13)。
 */
export function assertDeviceOwnsBatch(
  claims: TrustedClaims,
  actor: PhotoActorContext,
  batchSourceDeviceId: string | null,
): PhotoResult<true> {
  if (actor.role !== "PHOTO_DEVICE") return ok(true);
  if (claims.deviceId !== null && claims.deviceId === batchSourceDeviceId) return ok(true);
  return err(
    "PERMISSION_DENIED" as PhotoErrorCode,
    `device ${claims.deviceId ?? "(unknown)"} does not own batch sourceDeviceId ${batchSourceDeviceId ?? "(none)"}`,
  );
}
