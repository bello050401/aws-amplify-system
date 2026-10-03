"use server";

import { getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { getChannelListing, getListingDraftForInventory } from "@/lib/listing/service";
import { ReadRequestError, reserveExistingReadRequest, type ReviewedOverrides } from "@/lib/listing/mercariBridge/readRequest";
import { mercariBridgeReadRepository } from "@/lib/listing/mercariBridge/repository";

export type MercariBridgeReadResult =
  | { ok: false; code: "CONNECTOR_NOT_CONFIGURED"; requestId: string; message: string }
  | { ok: false; code: "FORBIDDEN" | "INVALID_INPUT" | "BINDING_CONFLICT" | "JOB_CONFLICT" |
      "STORAGE_UNAVAILABLE"; message: string };

/** Reserve a read of an administrator-selected, existing Shops product. No Shops operation is sent. */
export async function requestMercariExistingReadAction(input: {
  inventoryId: string;
  shopId: string;
  remoteId: string;
  reviewedOverrides?: ReviewedOverrides;
}): Promise<MercariBridgeReadResult> {
  if (await getInventoryRole() !== "ADMIN")
    return { ok: false, code: "FORBIDDEN", message: "管理者のみ照合を依頼できます。" };
  try {
    const requestedBy = await getCurrentInventoryUserEmail();
    if (!requestedBy || !input || typeof input.inventoryId !== "string" ||
        typeof input.shopId !== "string" || typeof input.remoteId !== "string") {
      return { ok: false, code: "INVALID_INPUT", message: "商品と既存商品IDを確認してください。" };
    }
    const [inventory, draft, channelListing] = await Promise.all([
      getInventoryDetail(input.inventoryId),
      getListingDraftForInventory(input.inventoryId),
      getChannelListing(input.inventoryId, "MERCARI_SHOPS"),
    ]);
    if (!inventory || !draft)
      return { ok: false, code: "INVALID_INPUT", message: "保存済みの商品と下書きが必要です。" };
    const result = await reserveExistingReadRequest({ inventory, draft, channelListing,
      shopId: input.shopId, remoteId: input.remoteId, reviewedOverrides: input.reviewedOverrides, requestedBy },
    mercariBridgeReadRepository);
    return { ...result, message: "読取依頼は記録しました。Shopsの照合結果はまだ届いていません。" };
  } catch (error) {
    if (error instanceof ReadRequestError) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: "STORAGE_UNAVAILABLE", message: "読取依頼を記録できませんでした。" };
  }
}
