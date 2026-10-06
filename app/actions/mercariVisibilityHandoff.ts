"use server";

import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { getChannelListing, getListingDraftForInventory } from "@/lib/listing/service";
import { buildVisibilityPcJob, type VisibilityPcJob } from
  "@/lib/listing/mercariBridge/visibilityHandoff";

/** Create only a PC handoff file. This action makes no Shops or ChannelListing write. */
export async function prepareMercariVisibilityPcJobAction(inventoryId: string,
  action: "STOP" | "RELIST"): Promise<
  { ok: true; job: VisibilityPcJob } | { ok: false; message: string }> {
  if (await getInventoryRole() !== "ADMIN")
    return { ok: false, message: "管理者のみ停止を依頼できます。" };
  if (!["STOP", "RELIST"].includes(action) || typeof inventoryId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(inventoryId))
    return { ok: false, message: "対象の在庫を確認できません。" };
  try {
    const [inventory, draft, listing] = await Promise.all([
      getInventoryDetail(inventoryId), getListingDraftForInventory(inventoryId),
      getChannelListing(inventoryId, "MERCARI_SHOPS"),
    ]);
    const job = inventory && draft && listing ?
      buildVisibilityPcJob(inventory, draft, listing, action) : null;
    return job ? { ok: true, job } :
      { ok: false, message: "Shopsの商品IDとBELLOの出品記録を確認してください。停止操作は行っていません。" };
  } catch {
    return { ok: false, message: "停止依頼を準備できませんでした。停止操作は行っていません。" };
  }
}
