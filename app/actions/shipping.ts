"use server";

import { revalidatePath } from "next/cache";
import { canEditInventory, getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { randomUUID } from "node:crypto";
import {
  listShippingRates,
  saveShippingRate,
  deleteShippingRate,
  calculateShippingEstimate,
  confirmShippingFee,
  getShippingReferencePrice,
  type ShippingRateInput,
  type ShippingEstimateResult,
  type GetShippingReferencePriceResult,
} from "@/lib/shipping/service";
import { runShippingRateImportBatch, getLatestShippingImportBatch, type ShippingImportBatchSummary, type RunImportResult } from "@/lib/shipping/importer";
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

/** §31/§46: 送料込み参考価格。読み取り専用(何も書き換えない)なので閲覧権限(VIEWER含む)で十分——ADMIN/EDITOR限定にしない。 */
export async function getShippingReferencePriceAction(inventoryId: string): Promise<GetShippingReferencePriceResult> {
  const role = await getInventoryRole();
  if (!role) throw new Error("ログインが必要です。");
  return getShippingReferencePrice(inventoryId);
}

// ─────────────────────────────────────────────────────────────────────
// 第六ラウンド§11(P0-2): 公式料金importer。新規コードのため、
// app/actions/ai.tsで確立した「throwではなくreturnでエラーを伝える」
// パターン(production buildでのNext.js Server Actionメッセージmasking
// を回避する、docs/ai-draft-error-root-cause-20260830.md参照)を最初
// から採用する。
// ─────────────────────────────────────────────────────────────────────

function logShippingActionFailure(action: string, correlationId: string, err: unknown): void {
  console.error(
    JSON.stringify({
      level: "error",
      action,
      correlationId,
      timestamp: new Date().toISOString(),
      errorMessage: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
}

export type RunShippingImportActionResult = { ok: true; data: RunImportResult } | { ok: false; error: string; correlationId: string };

/** §11「公式料金を更新」action。ADMIN限定、background job化(ここではServer Action自体が処理する——実際の外部fetchが失敗する場合の扱いはlib/shipping/importer.tsのコメント参照)。 */
export async function runShippingRateImportAction(): Promise<RunShippingImportActionResult> {
  const correlationId = randomUUID();
  try {
    const who = await requireAdmin();
    const data = await runShippingRateImportBatch(who);
    revalidatePath("/inventory/settings");
    return { ok: true, data };
  } catch (err) {
    logShippingActionFailure("runShippingRateImportAction", correlationId, err);
    return { ok: false, error: err instanceof Error ? err.message : "公式料金の取得に失敗しました。", correlationId };
  }
}

export type GetLatestShippingImportBatchActionResult = { ok: true; data: ShippingImportBatchSummary | null } | { ok: false; error: string; correlationId: string };

export async function getLatestShippingImportBatchAction(): Promise<GetLatestShippingImportBatchActionResult> {
  const correlationId = randomUUID();
  try {
    const role = await getInventoryRole();
    if (!role) throw new Error("ログインが必要です。");
    const data = await getLatestShippingImportBatch();
    return { ok: true, data };
  } catch (err) {
    logShippingActionFailure("getLatestShippingImportBatchAction", correlationId, err);
    return { ok: false, error: err instanceof Error ? err.message : "取得状況の確認に失敗しました。", correlationId };
  }
}
