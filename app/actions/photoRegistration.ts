"use server";

import { revalidatePath } from "next/cache";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { listInventorySimpleSearch } from "@/lib/inventory/queries";
import {
  getPhotoRegistrationWebAdapter,
  getWebTrustedClaims,
  type PhotoRegistrationWebAdapter,
  type WebBatchDetail,
  type WebInventoryPhotoAssets,
} from "@/lib/photoRegistration/webAdapter";
import type { BatchListPage, TrustedClaims } from "@/lib/photoRegistration/ports";
import type { PhotoErrorCode, PhotoResult } from "@/lib/photoRegistration/types";

/**
 * 画像登録Web UIのserver action境界。ここでは新しい業務判断をしない —
 * すべてlib/photoRegistration/webAdapter.ts (→ service.ts) へ委譲し、
 * このファイルはClient Componentから呼べる形への変換・認可の前段ゲート・
 * 画面キャッシュのrevalidateだけを行う。
 *
 * PhotoErr.messageは管理者・ログ向けであり、そのままエンドユーザーへ出さない
 * (docs/photo-registration-api-v1.md §49) — ERROR_LABELSで利用者向けの
 * 日本語文言へ差し替え、技術的な詳細はconsole.errorにのみ残す。
 */

const ERROR_LABELS: Record<PhotoErrorCode, string> = {
  AUTH_REQUIRED: "ログインが必要です。",
  PERMISSION_DENIED: "この操作を行う権限がありません。",
  BATCH_NOT_FOUND: "対象の撮影バッチが見つかりません。",
  BATCH_ALREADY_LINKED: "このバッチは既に在庫へ紐付け済みです。",
  ASSET_NOT_FOUND: "対象の画像が見つかりません。",
  UPLOAD_NOT_COMPLETE: "アップロードが完了していません。しばらくしてから再度お試しください。",
  HASH_MISMATCH: "アップロードした画像の内容が一致しませんでした。もう一度選び直してください。",
  INVALID_STATUS_TRANSITION: "現在の状態ではこの操作を行えません。",
  INVENTORY_NOT_FOUND: "対象の在庫が見つかりません(削除済みの可能性があります)。",
  CONFLICT: "他の操作と競合しました。画面を更新してからもう一度お試しください。",
  INTERNAL_ERROR: "予期しないエラーが発生しました。時間をおいて再度お試しください。",
  INVALID_INPUT: "入力内容が正しくありません。",
  IDEMPOTENCY_CONFLICT: "直前の操作と内容が異なります。画面を更新してからやり直してください。",
  ASSET_LIMIT_EXCEEDED: "このバッチに登録できる画像の上限(300枚)を超えています。",
  CHUNK_TOO_LARGE: "一度に送信できる画像の件数を超えています。",
  EMPTY_BATCH: "画像が1枚もないバッチは確認待ちにできません。",
  ASSET_IN_USE: "出品で使用中の画像は削除できません。先に出品の選択から外してください。",
  ASSET_NOT_DELETED: "削除されていない画像は復元できません。",
  CHANNEL_IMAGE_LIMIT_EXCEEDED: "選択できる画像の枚数上限を超えています。",
};

export type PhotoActionResult<T> = { ok: true; value: T } | { ok: false; code: PhotoErrorCode | "NOT_CONFIGURED"; message: string };

function mapPhotoResult<T>(result: PhotoResult<T>): PhotoActionResult<T> {
  if (result.ok) return { ok: true, value: result.value };
  console.error("[photoRegistration action]", { code: result.error, message: result.message, field: result.field });
  return { ok: false, code: result.error, message: ERROR_LABELS[result.error] ?? "エラーが発生しました。" };
}

/** requireWebRuntimeAndClaimsの失敗枝専用の型 — PhotoActionResult<never>だと
 * `{ok:true;value:never}`も型上の候補に残り、成功時に`runtime.adapter`へ
 * アクセスする箇所でunionの絞り込みが効かなくなる (value:never側にadapter
 * が無いため)。ok:falseの形だけを持つ型に分けることで、`if (!runtime.ok)`
 * のガード後に`runtime.adapter`/`runtime.claims`が確実に絞り込まれる。 */
type RuntimeFailure = { ok: false; code: PhotoErrorCode | "NOT_CONFIGURED"; message: string };

const NOT_CONFIGURED: RuntimeFailure = {
  ok: false,
  code: "NOT_CONFIGURED",
  message: "画像登録機能はまだAWSへ接続されていません。バックエンドの構築が完了するまでご利用いただけません。",
};

const AUTH_REQUIRED: RuntimeFailure = { ok: false, code: "AUTH_REQUIRED", message: ERROR_LABELS.AUTH_REQUIRED };

async function requireWebRuntimeAndClaims(): Promise<
  { ok: true; adapter: PhotoRegistrationWebAdapter; claims: TrustedClaims } | RuntimeFailure
> {
  const adapter = getPhotoRegistrationWebAdapter();
  if (!adapter) return NOT_CONFIGURED;
  const claims = await getWebTrustedClaims();
  if (!claims) return AUTH_REQUIRED;
  return { ok: true, adapter, claims };
}

// ─────────────────────────────────────────────────────────────────────────
// 一覧 / 詳細
// ─────────────────────────────────────────────────────────────────────────

export async function listUnregisteredPhotoBatchesAction(cursor: string | null, limit = 20): Promise<PhotoActionResult<BatchListPage>> {
  const runtime = await requireWebRuntimeAndClaims();
  if (!runtime.ok) return runtime;
  return mapPhotoResult(await runtime.adapter.listUnregisteredBatches(limit, cursor, runtime.claims));
}

export async function getPhotoBatchDetailAction(batchId: string, page = 1, pageSize = 24): Promise<PhotoActionResult<WebBatchDetail>> {
  const runtime = await requireWebRuntimeAndClaims();
  if (!runtime.ok) return runtime;
  return mapPhotoResult(await runtime.adapter.getBatchDetail(batchId, runtime.claims, { page, pageSize }));
}

export async function listInventoryPhotoAssetsAction(inventoryId: string): Promise<PhotoActionResult<WebInventoryPhotoAssets>> {
  const runtime = await requireWebRuntimeAndClaims();
  if (!runtime.ok) return runtime;
  return mapPhotoResult(await runtime.adapter.listInventoryPhotoAssets(inventoryId, runtime.claims));
}

export interface PhotoRegistrationBadgeState {
  count: number;
  hasMore: boolean;
}

/** InventoryNavRail/MobileBottomNavの「画像登録」badge用。失敗時は静かにnull(badge非表示)。 */
export async function getPhotoRegistrationBadgeAction(): Promise<PhotoRegistrationBadgeState | null> {
  const runtime = await requireWebRuntimeAndClaims();
  if (!runtime.ok) return null;
  const result = await runtime.adapter.listUnregisteredBatches(99, null, runtime.claims);
  if (!result.ok) return null;
  return { count: result.value.items.length, hasMore: result.value.nextCursor !== null };
}

// ─────────────────────────────────────────────────────────────────────────
// Web追加upload (requestPhotoAssetUploads → PUT (クライアント側) → complete → finalize)
// ─────────────────────────────────────────────────────────────────────────

export interface WebUploadAssetInput {
  clientAssetId: string;
  fileName: string;
  processed: { mimeType: string; fileSize: number; sha256: string };
  thumbnail: { mimeType: string; fileSize: number; sha256: string };
}

export async function requestWebAssetUploadsAction(
  batchId: string,
  assets: WebUploadAssetInput[],
  additionalExpectedCount: number | null,
): Promise<PhotoActionResult<{ batchId: string; revision: number; items: unknown[] }>> {
  const runtime = await requireWebRuntimeAndClaims();
  if (!runtime.ok) return runtime;
  return mapPhotoResult(await runtime.adapter.requestWebUploads({ batchId, assets, additionalExpectedCount }, runtime.claims));
}

export interface WebCompleteAssetInput {
  photoAssetId: string;
  processed: { sha256: string; fileSize: number; width: number; height: number };
  thumbnail: { sha256: string; fileSize: number; width: number; height: number };
}

export async function completeWebAssetUploadAction(
  batchId: string,
  input: WebCompleteAssetInput,
): Promise<PhotoActionResult<{ photoAssetId: string; status: string }>> {
  const runtime = await requireWebRuntimeAndClaims();
  if (!runtime.ok) return runtime;
  const result = await runtime.adapter.completeWebUpload(input, runtime.claims);
  if (result.ok) revalidatePath(`/inventory/photo-registration/${batchId}`);
  return mapPhotoResult(result);
}

export async function finalizeWebUploadAction(batchId: string): Promise<PhotoActionResult<{ batchId: string; status: string }>> {
  const runtime = await requireWebRuntimeAndClaims();
  if (!runtime.ok) return runtime;
  const result = await runtime.adapter.finalizeWebUpload(batchId, runtime.claims);
  if (result.ok) {
    revalidatePath("/inventory/photo-registration");
    revalidatePath(`/inventory/photo-registration/${batchId}`);
  }
  return mapPhotoResult(result);
}

// ─────────────────────────────────────────────────────────────────────────
// 論理削除 / ADMIN復元
// ─────────────────────────────────────────────────────────────────────────

export async function deletePhotoAssetAction(batchId: string, photoAssetId: string): Promise<PhotoActionResult<{ photoAssetId: string }>> {
  const runtime = await requireWebRuntimeAndClaims();
  if (!runtime.ok) return runtime;
  const result = await runtime.adapter.deleteAsset({ photoAssetId }, runtime.claims);
  if (result.ok) revalidatePath(`/inventory/photo-registration/${batchId}`);
  return mapPhotoResult(result);
}

export async function restorePhotoAssetAction(
  batchId: string,
  photoAssetId: string,
): Promise<PhotoActionResult<{ photoAssetId: string; status: string }>> {
  const runtime = await requireWebRuntimeAndClaims();
  if (!runtime.ok) return runtime;
  const result = await runtime.adapter.restoreAsset({ photoAssetId }, runtime.claims);
  if (result.ok) revalidatePath(`/inventory/photo-registration/${batchId}`);
  return mapPhotoResult(result);
}

// ─────────────────────────────────────────────────────────────────────────
// Inventory候補検索 / link確認
// ─────────────────────────────────────────────────────────────────────────

export async function linkPhotoBatchToInventoryAction(batchId: string, inventoryId: string): Promise<PhotoActionResult<{ batchId: string; status: string }>> {
  const runtime = await requireWebRuntimeAndClaims();
  if (!runtime.ok) return runtime;
  const result = await runtime.adapter.linkToInventory({ batchId, inventoryId }, runtime.claims);
  if (result.ok) {
    revalidatePath("/inventory/photo-registration");
    revalidatePath(`/inventory/photo-registration/${batchId}`);
  }
  return mapPhotoResult(result);
}

export interface InventoryCandidateRow {
  id: string;
  sku: string;
  displayId: string;
  name: string;
}

/**
 * link先候補の検索は既存Inventoryシステム (lib/inventory/queries.ts) を
 * そのまま使う — photoRegistration側のrepositoryはInventory本体を
 * 一切読み書きしない設計 (§4.6) なので、ここは既存の在庫検索の薄いラッパー。
 * 権限も既存Inventoryシステムの role (ADMIN/EDITOR) で判定する
 * (photoRegistration側のADMIN/STAFFとは独立した別の認可ドメイン)。
 */
export async function searchInventoryCandidatesAction(query: string): Promise<{ ok: true; items: InventoryCandidateRow[] } | { ok: false; message: string }> {
  const role = await getInventoryRole();
  if (!role || role === "VIEWER") return { ok: false, message: "この操作を行う権限がありません。" };
  const trimmed = query.trim();
  if (trimmed.length === 0) return { ok: true, items: [] };
  try {
    const page = await listInventorySimpleSearch({ q: trimmed }, { offset: 0, limit: 20 });
    return { ok: true, items: page.items.map((row) => ({ id: row.id, sku: row.sku, displayId: row.displayId, name: row.name })) };
  } catch (error) {
    console.warn("[searchInventoryCandidatesAction] failed", { error: error instanceof Error ? error.name : "unknown" });
    return { ok: false, message: "在庫の検索に失敗しました。" };
  }
}
