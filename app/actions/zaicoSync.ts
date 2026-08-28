"use server";

import { revalidatePath } from "next/cache";
import { getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { syncAllZaicoItems, syncSingleZaicoItem, type ZaicoSyncResult } from "@/lib/inventory/zaicoSync";

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
