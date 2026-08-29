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
