"use server";

import { revalidatePath } from "next/cache";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { adoptVersion, enqueueProcessingJob, listPendingJobStatuses, listVersions, setActiveVersion } from "@/lib/imageProcessing/jobService";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { splitImagesByType } from "@/lib/inventory/imageTypes";
import { BULK_IMAGE_PROCESSING_ELIGIBLE_STATUSES } from "@/lib/imageProcessing/types";
import { ensureOriginalHash, OriginalImageMissingError } from "@/lib/inventory/originalHashRepair";
import { parseReferenceImageKeys, serializeForAwsJson } from "@/lib/imageProcessing/photoProfile";

/**
 * BELLO画像自動加工システム(2026-08-30指示書)§8.1/§12/§13の
 * Server Action境界。ADMIN/EDITOR限定(在庫の画像を編集できる権限と
 * 同じ——lib/amplify/requireInventoryUser.tsのcanEditInventoryを再利用)。
 */
function requireImageProcessingPermission(role: Awaited<ReturnType<typeof getInventoryRole>>): void {
  if (role !== "ADMIN" && role !== "EDITOR") {
    throw new Error("この操作にはADMINまたはEDITOR権限が必要です。");
  }
}

export interface ImageProcessingVersionSummary {
  id: string;
  version: number;
  status: string;
  active: boolean;
  aspectRatio: string | null;
  processedMasterKey: string | null;
  webKey: string | null;
  thumbnailKey: string | null;
  failureCode: string | null;
  failureDetail: string | null;
  completedAt: string | null;
}

/** §13: 画像1件の加工状態一覧(全version、version昇順)。UIはこの配列からactive行を拾って現在の状態バッジを描く。 */
export async function listImageProcessingVersionsAction(imageStorageKey: string): Promise<ImageProcessingVersionSummary[]> {
  const versions = await listVersions(imageStorageKey);
  return versions.map((v) => ({
    id: v.id,
    version: v.version,
    status: v.status,
    active: v.active ?? false,
    aspectRatio: v.aspectRatio ?? null,
    processedMasterKey: v.processedMasterKey ?? null,
    webKey: v.webKey ?? null,
    thumbnailKey: v.thumbnailKey ?? null,
    failureCode: v.failureCode ?? null,
    failureDetail: v.failureDetail ?? null,
    completedAt: v.completedAt ?? null,
  }));
}

/**
 * 2026-08-31フィードバック対応: 「加工するを押しても反応がない」の
 * 直接対処。ImageProcessingVersionがまだ無い画像について、
 * ProcessingJob(PENDING/PROCESSING)が存在するかをまとめて引く——
 * これによりUIは「予約済みで次のworker実行を待っている」ことを表示
 * できる。
 */
export async function listPendingImageProcessingJobStatusesAction(imageStorageKeys: string[]): Promise<Record<string, "PENDING" | "PROCESSING">> {
  return listPendingJobStatuses(imageStorageKeys);
}

/** §12: 手動再加工。requestedAdjustmentsは自由入力の再加工理由をUI側であらかじめパラメータへ変換したもの(空でも可——単純な「もう一度」)。 */
export async function reprocessImageAction(input: {
  inventoryId: string;
  imageStorageKey: string;
  originalHash: string;
  requestedAdjustments?: Record<string, unknown>;
}): Promise<{ enqueued: boolean }> {
  const role = await getInventoryRole();
  requireImageProcessingPermission(role);
  // 夜間指示書§5: hashが無いだけで予約を断らない。サーバー側で元画像から
  // 計算して保存し、そのまま予約を続ける(利用者に「保存し直し」をさせない)。
  const originalHash = await ensureOriginalHash({
    inventoryId: input.inventoryId,
    storageKey: input.imageStorageKey,
    originalHash: input.originalHash,
  });
  const enqueued = await enqueueProcessingJob({
    inventoryId: input.inventoryId,
    imageStorageKey: input.imageStorageKey,
    originalHash,
    triggerType: "MANUAL_REPROCESS",
    requestedAdjustments: input.requestedAdjustments,
  });
  revalidatePath(`/inventory/${input.inventoryId}`);
  return { enqueued };
}

/**
 * 不具合修正・ZAICO同期重複根絶・EC出品UI改善・画像自動加工 完全自律
 * 実装指示書(2026-08-30) §12.3: 商品詳細の画像エリアに明確な
 * 「画像を自動加工」ボタンを設置し、カテゴリ変更に頼らずこのボタン
 * だけで処理を開始できるようにする——既存の`enqueueProcessingJob`
 * (冪等性チェック込み)をそのまま再利用し、新しい加工ロジックは一切
 * 追加しない。既に処理待ち/処理中/処理済みの画像は
 * `enqueueProcessingJob`の冪等性チェックで自然にスキップされる
 * (このAction自体は「対象画像を全部投げる」だけで、状態判定は
 * 呼び出し元のUIとenqueueProcessingJob双方が担う二重の安全網)。
 */
export async function reprocessAllImagesAction(
  inventoryId: string,
  images: { storageKey: string; originalHash: string | null }[],
): Promise<{ enqueuedCount: number; skippedNoHashCount: number }> {
  const role = await getInventoryRole();
  requireImageProcessingPermission(role);

  let enqueuedCount = 0;
  let skippedNoHashCount = 0;
  for (const img of images) {
    // 夜間指示書§5: hash未計算は「予約できない理由」ではなく「その場で
    // 直す対象」。元画像が本当に取得できないものだけをスキップへ落とす。
    let originalHash: string;
    try {
      originalHash = await ensureOriginalHash({ inventoryId, storageKey: img.storageKey, originalHash: img.originalHash });
    } catch (err) {
      if (err instanceof OriginalImageMissingError) {
        skippedNoHashCount++;
        continue;
      }
      throw err;
    }
    const created = await enqueueProcessingJob({
      inventoryId,
      imageStorageKey: img.storageKey,
      originalHash,
      triggerType: "MANUAL_REPROCESS",
    });
    if (created) enqueuedCount++;
  }
  revalidatePath(`/inventory/${inventoryId}`);
  return { enqueuedCount, skippedNoHashCount };
}

/**
 * 不具合修正・ZAICO同期重複根絶・EC出品UI改善・画像自動加工 完全自律
 * 実装指示書(2026-08-30) §7/§12.8: 在庫一覧のチェックボックス
 * (以前はどの操作にも繋がっていなかった、実質的に死んでいたUI要素
 * ——app/inventory/(protected)/InventoryTable.tsxの該当箇所参照)へ
 * 与える、実際に意味のある一括操作。複数商品を横断して選択し、まとめて
 * 画像の自動加工を予約する。
 *
 * 商品ごとの`reprocessAllImagesAction`と同じ判定(未加工・失敗・要確認
 * の画像だけを対象とし、既にREADYの画像は巻き込まない——付録B「再加工
 * で全画像を巻き込む処理」の禁止と同じ理由)を、選択された商品全件へ
 * 適用する。
 */
export interface BulkReprocessInventoryImagesResult {
  itemsProcessed: number;
  itemsSkippedNotFound: number;
  enqueuedCount: number;
  skippedNoHashCount: number;
}

export async function bulkReprocessInventoryImagesAction(inventoryIds: string[]): Promise<BulkReprocessInventoryImagesResult> {
  const role = await getInventoryRole();
  requireImageProcessingPermission(role);

  let itemsProcessed = 0;
  let itemsSkippedNotFound = 0;
  let enqueuedCount = 0;
  let skippedNoHashCount = 0;

  for (const inventoryId of inventoryIds) {
    const detail = await getInventoryDetail(inventoryId);
    if (!detail) {
      itemsSkippedNotFound++;
      continue;
    }
    itemsProcessed++;
    const { normal } = splitImagesByType(detail.images);
    for (const img of normal) {
      const versions = await listVersions(img.storageKey);
      const active = versions.find((v) => v.active);
      const status = active ? active.status : versions.length === 0 ? "UNPROCESSED" : versions[versions.length - 1].status;
      // ImageProcessingPanel.tsxのbulkTargetsフィルタと同じ4状態のみ対象
      // (READY/QUEUED/PROCESSING/REPROCESSING/SUPERSEDEDは巻き込まない)。
      if (!(BULK_IMAGE_PROCESSING_ELIGIBLE_STATUSES as readonly string[]).includes(status)) continue;
      // 夜間指示書§5: 一括経路でも同じく、hash未計算はその場で修復する。
      let originalHash: string;
      try {
        originalHash = await ensureOriginalHash({ inventoryId, storageKey: img.storageKey, originalHash: img.originalHash });
      } catch (err) {
        if (err instanceof OriginalImageMissingError) {
          skippedNoHashCount++;
          continue;
        }
        throw err;
      }
      const created = await enqueueProcessingJob({
        inventoryId,
        imageStorageKey: img.storageKey,
        originalHash,
        triggerType: "MANUAL_REPROCESS",
      });
      if (created) enqueuedCount++;
    }
  }

  revalidatePath("/inventory");
  return { itemsProcessed, itemsSkippedNotFound, enqueuedCount, skippedNoHashCount };
}

/**
 * §17: 「要確認」の加工結果を人が確認したうえで採用する。
 * 権限はロールバックと同じ(画像加工を操作できる役割)。
 */
export async function adoptImageVersionAction(inventoryId: string, imageStorageKey: string, versionId: string): Promise<void> {
  const role = await getInventoryRole();
  requireImageProcessingPermission(role);
  await adoptVersion(imageStorageKey, versionId);
  revalidatePath(`/inventory/${inventoryId}`);
}

/** §12: 直前のversion(または選んだ任意のversion)へロールバックする。 */
export async function rollbackImageVersionAction(inventoryId: string, imageStorageKey: string, versionId: string): Promise<void> {
  const role = await getInventoryRole();
  requireImageProcessingPermission(role);
  await setActiveVersion(imageStorageKey, versionId);
  revalidatePath(`/inventory/${inventoryId}`);
}

// ── §8.1 Photo Profile管理UI ──────────────────────────────────────────

export interface PhotoProfileSummary {
  id: string;
  name: string;
  version: number;
  active: boolean;
  referenceImageKeys: string[];
}

export async function listPhotoProfilesAction(): Promise<PhotoProfileSummary[]> {
  const role = await getInventoryRole();
  requireImageProcessingPermission(role);
  const { data } = await serverDataClient.models.PhotoProfile.list({ ...inventoryAuthMode });
  return data
    .map((p) => ({ id: p.id, name: p.name, version: p.version, active: p.active ?? false, referenceImageKeys: parseReferenceImageKeys(p.referenceImageKeys) }))
    .sort((a, b) => b.version - a.version);
}

/** 新しいPhoto Profileを作成し、ACTIVEに切り替える(旧ACTIVEは自動的に降ろす)。基準値はpipeline.tsのDEFAULT_OCCUPANCY_RANGE(§6初期値)を毎回そのまま保存する——このラウンドでは実画像PoCによる調整を行っていないため。 */
export async function createPhotoProfileAction(name: string, referenceImageKeys: string[]): Promise<void> {
  const role = await getInventoryRole();
  requireImageProcessingPermission(role);
  if (!name.trim()) throw new Error("Profile名を入力してください。");
  if (referenceImageKeys.length === 0) throw new Error("基準写真を1枚以上追加してください。");

  const { data: existing } = await serverDataClient.models.PhotoProfile.list({ ...inventoryAuthMode });
  const nextVersion = existing.length > 0 ? Math.max(...existing.map((p) => p.version)) + 1 : 1;
  const currentActive = existing.find((p) => p.active);

  const { DEFAULT_OCCUPANCY_RANGE } = await import("@/lib/imageProcessing/pipeline");
  // `referenceImageKeys`/`targetOccupancy*`はスキーマ上 a.json() = AWSJSON。
  // AWSJSONは**JSONエンコード済みの文字列**しか受け付けず、生の配列/オブ
  // ジェクトを渡すとAppSyncが
  //   "Variable 'referenceImageKeys' has an invalid value."
  // を返して作成が失敗する(実際にstagingのAppSyncへ両方の形で投げて確認
  // 済み: 生の配列=失敗 / JSON文字列=成功)。これがPhoto Profile作成が
  // 常に失敗し、一覧が「まだPhoto Profileがありません」のままだった原因。
  // 同じ罠はFeature.contentでも一度踏んでいる(commit 4bd0a1b)。
  const { errors } = await serverDataClient.models.PhotoProfile.create(
    {
      name: name.trim(),
      referenceImageKeys: serializeForAwsJson(referenceImageKeys),
      targetOccupancySquare: serializeForAwsJson(DEFAULT_OCCUPANCY_RANGE.SQUARE_1_1),
      targetOccupancyLandscape: serializeForAwsJson(DEFAULT_OCCUPANCY_RANGE.LANDSCAPE_3_2),
      version: nextVersion,
      active: true,
    },
    inventoryAuthMode,
  );
  // 内部エラー詳細(GraphQLのpath/locations等)をそのまま利用者へ出さない。
  // 詳細はサーバーログへ、画面には対処可能な文言だけを返す。
  if (errors) {
    console.error("[createPhotoProfileAction] create failed:", JSON.stringify(errors));
    throw new Error("Photo Profileの作成に失敗しました。時間をおいて再度お試しください。");
  }

  // 新Profileの作成が成功して初めて旧ACTIVEを降ろす(この順序により、
  // 作成が失敗したときに「どのProfileもACTIVEでない」中途半端な状態が
  // 残らない)。
  if (currentActive) {
    const { errors: deactivateErrors } = await serverDataClient.models.PhotoProfile.update(
      { id: currentActive.id, active: false },
      inventoryAuthMode,
    );
    if (deactivateErrors) {
      // 新Profileは既にACTIVEで作成済み。旧を降ろせなくてもACTIVEが
      // 二重になるだけで、getActivePhotoProfileはversion降順で新しい方を
      // 選ぶため実害は無い——作成自体を失敗扱いにはしない。
      console.error("[createPhotoProfileAction] failed to deactivate previous profile:", JSON.stringify(deactivateErrors));
    }
  }
  revalidatePath("/inventory/settings");
}

export async function setActivePhotoProfileAction(id: string): Promise<void> {
  const role = await getInventoryRole();
  requireImageProcessingPermission(role);
  const { data: existing } = await serverDataClient.models.PhotoProfile.list({ ...inventoryAuthMode });
  for (const p of existing) {
    if (p.active && p.id !== id) await serverDataClient.models.PhotoProfile.update({ id: p.id, active: false }, inventoryAuthMode);
  }
  await serverDataClient.models.PhotoProfile.update({ id, active: true }, inventoryAuthMode);
  revalidatePath("/inventory/settings");
}
