"use server";

import { revalidatePath } from "next/cache";
import { canEditInventory, getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import {
  listPricingRules,
  savePricingRule,
  setAutoPricingForListing,
  runPricingCheck,
  type PricingRuleInput,
  type AutoPricingSettingInput,
  type PricingCheckResult,
} from "@/lib/listing/pricingService";
import type { PricingRuleRecord } from "@/lib/listing/pricing";
import type { ChannelListingRecord } from "@/lib/listing/types";

/**
 * BELLO統合業務OS指示書(2026-08-30) §17-20: Pricing Rule EngineのServer
 * Action層。ルール自体の作成・編集はADMIN限定(§18相当の権限境界 —
 * lib/inventory/masters.tsのCategory等と同じ「価格戦略の設定はより
 * 厳しい権限で守る」考え方)、商品ごとのON/OFF切り替えと手動テスト実行
 * はcanEditInventory(ADMIN/EDITOR)境界。
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

export async function listPricingRulesAction(): Promise<PricingRuleRecord[]> {
  return listPricingRules();
}

export async function savePricingRuleAction(ruleId: string | null, input: PricingRuleInput): Promise<PricingRuleRecord> {
  const who = await requireAdmin();
  const result = await savePricingRule(ruleId, input, who);
  revalidatePath("/inventory/settings");
  return result;
}

export async function setAutoPricingForListingAction(inventoryId: string, input: AutoPricingSettingInput): Promise<ChannelListingRecord> {
  const who = await requireEditPermission();
  const result = await setAutoPricingForListing(inventoryId, input, who);
  revalidatePath(`/inventory/${inventoryId}/listing`);
  return result;
}

export async function runPricingCheckAction(inventoryId: string): Promise<PricingCheckResult> {
  const who = await requireEditPermission();
  return runPricingCheck(inventoryId, who);
}
