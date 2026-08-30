"use server";

import { randomUUID } from "node:crypto";
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

export async function runPricingCheckAction(inventoryId: string, channel: ChannelListingRecord["channel"] = "MERCARI_SHOPS"): Promise<PricingCheckResult> {
  const who = await requireEditPermission();
  return runPricingCheck(inventoryId, who, channel);
}

// ─────────────────────────────────────────────────────────────────────
// 第六ラウンド§14-16(P0-3): EC出品一覧からの一括ルール適用。
// 既存のsetAutoPricingForListing(商品1件単位、ChannelListing.
// pricingRuleId/autoPricingEnabledを書き換えるだけの既存ロジック)を
// そのまま再利用する——新しいengine/scheduler/DB writeロジックは
// 一切追加していない(§119「既存のPricing Rule Engineを複製しない」)。
// ─────────────────────────────────────────────────────────────────────

export interface BulkAssignPricingRuleItemResult {
  inventoryId: string;
  ok: boolean;
  error?: string;
}

export type BulkAssignPricingRuleActionResult =
  | { ok: true; data: { results: BulkAssignPricingRuleItemResult[]; successCount: number; failureCount: number } }
  | { ok: false; error: string; correlationId: string };

/**
 * §146「一部失敗で全件成功表示しない」——1商品の失敗(例: まだ
 * ChannelListingが無い、§143)が他の商品への適用を止めない一方、
 * 呼び出し元には商品ごとの成否をそのまま返す。
 */
export async function bulkAssignPricingRuleAction(inventoryIds: string[], input: AutoPricingSettingInput): Promise<BulkAssignPricingRuleActionResult> {
  const correlationId = randomUUID();
  try {
    const who = await requireEditPermission();
    if (inventoryIds.length === 0) throw new Error("対象商品が選択されていません。");

    const results: BulkAssignPricingRuleItemResult[] = [];
    for (const inventoryId of inventoryIds) {
      try {
        await setAutoPricingForListing(inventoryId, input, who);
        results.push({ inventoryId, ok: true });
      } catch (err) {
        results.push({ inventoryId, ok: false, error: err instanceof Error ? err.message : "適用に失敗しました。" });
      }
    }
    revalidatePath("/inventory/listings");
    const successCount = results.filter((r) => r.ok).length;
    return { ok: true, data: { results, successCount, failureCount: results.length - successCount } };
  } catch (err) {
    console.error(JSON.stringify({ level: "error", action: "bulkAssignPricingRuleAction", correlationId, errorMessage: err instanceof Error ? err.message : String(err) }));
    return { ok: false, error: err instanceof Error ? err.message : "一括適用に失敗しました。", correlationId };
  }
}
