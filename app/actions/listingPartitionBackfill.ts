"use server";

import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { advanceListingPartitionBackfill, type ListingPartitionBackfillProgress } from "@/lib/inventory/listingPartitionBackfill";

/**
 * 第六ラウンドP0-5 — lib/inventory/thumbnailBackfill.tsの
 * app/actions/thumbnailBackfill.tsと全く同じADMIN-gated pattern。
 * 一覧の並び順(revalidatePath)には影響しない書き込み(listUpdatedAtは
 * 既存のupdatedAtを複製するだけ、listingPartitionBackfill.ts参照)なので
 * revalidatePathは呼ばない。
 */
export async function advanceListingPartitionBackfillAction(nextToken: string | null): Promise<ListingPartitionBackfillProgress> {
  const role = await getInventoryRole();
  if (role !== "ADMIN") throw new Error("在庫一覧の並び順インデックス移行はADMIN権限のみ実行できます。");
  return advanceListingPartitionBackfill(nextToken);
}
