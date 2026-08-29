"use server";

import { revalidatePath } from "next/cache";
import { getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import {
  syncAllZaicoItems,
  syncSingleZaicoItem,
  syncLimitedZaicoItems,
  previewZaicoCatalogSize,
  type ZaicoSyncResult,
  type ZaicoCatalogPreview,
} from "@/lib/inventory/zaicoSync";
import {
  startZaicoBackgroundSyncJob,
  advanceZaicoBackgroundSyncJob,
  cancelZaicoBackgroundSyncJob,
  getZaicoBackgroundSyncStatus,
  type ZaicoBackgroundSyncJob,
} from "@/lib/inventory/zaicoBackgroundSync";

/**
 * The ADMIN-gated Server Action surface for the ZAICO→BELLO sync (spec
 * §19: UI-only ADMIN gating is not enough — this is the server-side
 * enforcement that stops an EDITOR/VIEWER from triggering a sync even by
 * calling the action directly, bypassing any client-side button
 * disabling). Never returns or logs the ZAICO API token — every error
 * surfaced here comes from lib/zaico/client.ts, which is itself
 * constructed to never include the token in a thrown message.
 */
function requireAdminOrThrow(role: Awaited<ReturnType<typeof getInventoryRole>>): void {
  if (role !== "ADMIN") {
    throw new Error("ZAICO同期はADMIN権限のみ実行できます。");
  }
}

export async function syncOneZaicoInventoryAction(zaicoId: string): Promise<ZaicoSyncResult> {
  const role = await getInventoryRole();
  requireAdminOrThrow(role);

  const trimmed = zaicoId.trim();
  if (!trimmed) throw new Error("ZAICO在庫IDを入力してください。");

  const who = await getCurrentInventoryUserEmail();
  const result = await syncSingleZaicoItem(trimmed, who);

  revalidatePath("/inventory");
  revalidatePath("/inventory/settings");
  return result;
}

export async function syncAllZaicoInventoriesAction(): Promise<ZaicoSyncResult> {
  const role = await getInventoryRole();
  requireAdminOrThrow(role);

  const who = await getCurrentInventoryUserEmail();
  const result = await syncAllZaicoItems(who);

  revalidatePath("/inventory");
  revalidatePath("/inventory/settings");
  return result;
}

/**
 * 少数件テスト同期(AWSテスト環境構築指示 §8/§26: Phase A「5〜10商品」)
 * — 全件同期(syncAllZaicoInventoriesAction)とは別のServer Actionとして
 * 独立させている。UIから件数(1〜50、ZaicoSyncPanel.tsx側でも制限)を
 * 受け取り、lib/inventory/zaicoSync.tsのsyncLimitedZaicoItemsへそのまま
 * 渡す — こちら側でも安全弁として上限50にクランプする(呼び出し元が
 * client componentなので、サーバー側だけで制限が効いている必要がある)。
 */
export async function syncLimitedZaicoInventoriesAction(limit: number): Promise<ZaicoSyncResult> {
  const role = await getInventoryRole();
  requireAdminOrThrow(role);

  const who = await getCurrentInventoryUserEmail();
  const result = await syncLimitedZaicoItems(limit, who);

  revalidatePath("/inventory");
  revalidatePath("/inventory/settings");
  return result;
}

/**
 * ZAICO側の規模を同期せずに確認するだけのAction(AWSテスト環境構築指示
 * §8: 実行前件数表示)。書き込みを一切行わないため他のActionと違い
 * revalidatePathは呼ばない。ADMIN限定は他の同期系Actionと統一(通常
 * 業務データではないとはいえ、ZAICO接続そのものへのAPI呼び出しなので
 * 同じ権限境界に揃える)。
 */
export async function previewZaicoCatalogSizeAction(): Promise<ZaicoCatalogPreview> {
  const role = await getInventoryRole();
  requireAdminOrThrow(role);
  return previewZaicoCatalogSize();
}

/**
 * BELLO統合改修 master指示書 Phase A: ZAICO background full sync.
 *
 * These four actions drive lib/inventory/zaicoBackgroundSync.ts's
 * checkpointed job from the browser (ZaicoSyncPanel.tsx polls `advance`
 * repeatedly while a job is RUNNING). Each individual call does bounded
 * work (one ZAICO page, see zaicoBackgroundSync.ts) — this is what makes
 * "全件同期" possible without the ~3 minute single-request timeout the
 * master instructions identified in the previous (syncAllZaicoItems)
 * design; that Server Action is unchanged and still exists for callers
 * who want a single blocking small/medium sync.
 */
export async function startZaicoBackgroundSyncAction(): Promise<{ started: boolean; reason?: string }> {
  const role = await getInventoryRole();
  requireAdminOrThrow(role);
  const who = await getCurrentInventoryUserEmail();
  return startZaicoBackgroundSyncJob(who);
}

export async function advanceZaicoBackgroundSyncAction(): Promise<{ job: ZaicoBackgroundSyncJob; shouldContinue: boolean }> {
  const role = await getInventoryRole();
  requireAdminOrThrow(role);
  const who = await getCurrentInventoryUserEmail();
  const result = await advanceZaicoBackgroundSyncJob(who);
  if (!result.shouldContinue) {
    // Only revalidate once the run is done/stopped — not after every
    // single-page advance, which would otherwise force a full
    // Inventory list re-fetch every few seconds while a large sync is
    // still in progress.
    revalidatePath("/inventory");
    revalidatePath("/inventory/settings");
  }
  return result;
}

export async function cancelZaicoBackgroundSyncAction(): Promise<void> {
  const role = await getInventoryRole();
  requireAdminOrThrow(role);
  await cancelZaicoBackgroundSyncJob();
  revalidatePath("/inventory");
  revalidatePath("/inventory/settings");
}

export async function getZaicoBackgroundSyncStatusAction(): Promise<ZaicoBackgroundSyncJob | null> {
  const role = await getInventoryRole();
  requireAdminOrThrow(role);
  return getZaicoBackgroundSyncStatus();
}
