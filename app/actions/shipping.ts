"use server";

import { revalidatePath } from "next/cache";
import { canEditInventory, getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import {
  listShippingRates,
  saveShippingRate,
  deleteShippingRate,
  calculateShippingEstimate,
  confirmShippingFee,
  type ShippingRateInput,
  type ShippingEstimateResult,
} from "@/lib/shipping/service";
import type { ShippingRateRecord } from "@/lib/shipping/types";
import type { ChannelListingRecord } from "@/lib/listing/types";

/**
 * BELLO統合業務OS指示書(2026-08-30) §65-68: 家財おまかせ便料金マスタ
 * のServer Action層。マスタ自体の追加・編集・削除はADMIN限定
 * (app/actions/pricing.tsのPricingRuleと同じ理由 — 料金という事業判断
 * に関わる値はより厳しい権限で守る)、商品ごとの見積り計算・確定は
 * canEditInventory(ADMIN/EDITOR)境界。
 */
async function requireAdmin(): Promise<string | null> {
  const role = await getInventoryRole();
  if (role !== "ADMIN") throw new Error("この操作にはADMIN権限が必要です。");
  return getCurrentInventoryUserEmail();
}

async function requireEditPermission(): Promise<string | null> {
  const role = await getInventoryRole();
  if (!canEditInventory(role)) throw new Error("この操作にはADMINまたはEDITOR権限が必要です。");
  return getCurrentInventoryUserEmail();
}

export async function listShippingRatesAction(): Promise<ShippingRateRecord[]> {
  return listShippingRates();
}

export async function saveShippingRateAction(rateId: string | null, input: ShippingRateInput): Promise<ShippingRateRecord> {
  const who = await requireAdmin();
  const result = await saveShippingRate(rateId, input, who);
  revalidatePath("/inventory/settings");
  return result;
}

export async function deleteShippingRateAction(rateId: string): Promise<void> {
  await requireAdmin();
  await deleteShippingRate(rateId);
  revalidatePath("/inventory/settings");
}

export async function calculateShippingEstimateAction(inventoryId: string, destinationPrefecture: string): Promise<ShippingEstimateResult> {
  const who = await requireEditPermission();
  const result = await calculateShippingEstimate(inventoryId, destinationPrefecture, who);
  revalidatePath(`/inventory/${inventoryId}/listing`);
  return result;
}

export async function confirmShippingFeeAction(inventoryId: string, confirmedFee: number | null): Promise<ChannelListingRecord> {
  const who = await requireEditPermission();
  const result = await confirmShippingFee(inventoryId, confirmedFee, who);
  revalidatePath(`/inventory/${inventoryId}/listing`);
  return result;
}
