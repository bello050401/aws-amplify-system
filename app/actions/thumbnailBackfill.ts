"use server";

import { revalidatePath } from "next/cache";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { advanceThumbnailBackfill, type ThumbnailBackfillProgress } from "@/lib/inventory/thumbnailBackfill";

/**
 * BELLO統合改修 master指示書 Phase B優先度4 — ADMIN-gated, same
 * server-side-enforcement pattern as every ZAICO sync action in
 * app/actions/zaicoSync.ts (a hidden UI tab is not access control on its
 * own). Bounded per call (see thumbnailBackfill.ts's RECORDS_PER_ADVANCE)
 * — the settings UI calls this repeatedly while `done` is false, same
 * client-driven-polling shape as the ZAICO background sync, just without
 * a persisted job (see thumbnailBackfill.ts's own comment for why this
 * one doesn't need one).
 */
export async function advanceThumbnailBackfillAction(nextToken: string | null): Promise<ThumbnailBackfillProgress> {
  const role = await getInventoryRole();
  if (role !== "ADMIN") throw new Error("既存画像のサムネイル生成はADMIN権限のみ実行できます。");
  const result = await advanceThumbnailBackfill(nextToken);
  if (result.generated > 0) {
    revalidatePath("/inventory");
  }
  return result;
}
