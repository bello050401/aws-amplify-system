"use server";

import { revalidatePath } from "next/cache";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { enqueueProcessingJob, listVersions, setActiveVersion } from "@/lib/imageProcessing/jobService";

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

/** §12: 手動再加工。requestedAdjustmentsは自由入力の再加工理由をUI側であらかじめパラメータへ変換したもの(空でも可——単純な「もう一度」)。 */
export async function reprocessImageAction(input: {
  inventoryId: string;
  imageStorageKey: string;
  originalHash: string;
  requestedAdjustments?: Record<string, unknown>;
}): Promise<{ enqueued: boolean }> {
  const role = await getInventoryRole();
  requireImageProcessingPermission(role);
  if (!input.originalHash) {
    throw new Error("この画像はまだoriginalHashが計算されていないため、再加工を予約できません(ZAICO同期由来の画像等)。詳細画面で画像を保存し直すと自己修復されます。");
  }
  const enqueued = await enqueueProcessingJob({
    inventoryId: input.inventoryId,
    imageStorageKey: input.imageStorageKey,
    originalHash: input.originalHash,
    triggerType: "MANUAL_REPROCESS",
    requestedAdjustments: input.requestedAdjustments,
  });
  revalidatePath(`/inventory/${input.inventoryId}`);
  return { enqueued };
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
    .map((p) => ({ id: p.id, name: p.name, version: p.version, active: p.active ?? false, referenceImageKeys: (p.referenceImageKeys as string[] | null) ?? [] }))
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
  const { errors } = await serverDataClient.models.PhotoProfile.create(
    {
      name: name.trim(),
      referenceImageKeys,
      targetOccupancySquare: DEFAULT_OCCUPANCY_RANGE.SQUARE_1_1,
      targetOccupancyLandscape: DEFAULT_OCCUPANCY_RANGE.LANDSCAPE_3_2,
      version: nextVersion,
      active: true,
    },
    inventoryAuthMode,
  );
  if (errors) throw new Error(`Photo Profileの作成に失敗しました: ${JSON.stringify(errors)}`);

  if (currentActive) {
    await serverDataClient.models.PhotoProfile.update({ id: currentActive.id, active: false }, inventoryAuthMode);
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
