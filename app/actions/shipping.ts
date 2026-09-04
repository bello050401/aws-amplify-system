"use server";

import { revalidatePath } from "next/cache";
import { canEditInventory, getCurrentInventoryUserEmail, getInventoryRole } from "@/lib/amplify/requireInventoryUser";
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
import { buildShippingCsv, parseShippingCsv, selectChangedRows } from "@/lib/shipping/csv";
import { KAZAI_SERVICE_NAME } from "@/lib/shipping/serviceName";
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


// ─────────────────────────────────────────────────────────────────────
// CSV一括更新(§配送料金の正本をBELLO内部で運用する)。
//
// 既存行の削除は行わない。CSVに載っていない組合せは「変更なし」であって
// 「削除」ではない —— 450件を守る要件があるため、削除の意図を受け取る
// 経路自体を作らない。
// ─────────────────────────────────────────────────────────────────────

export type ShippingCsvExportResult = { ok: true; csv: string; rows: number } | { ok: false; error: string };

export async function exportShippingRatesCsvAction(): Promise<ShippingCsvExportResult> {
  try {
    const role = await getInventoryRole();
    if (!role) return { ok: false, error: "ログインが必要です。" };
    const rates = await listShippingRates();
    return {
      ok: true,
      rows: rates.length,
      csv: buildShippingCsv(
        rates.map((r) => ({
          destinationPrefecture: r.destinationPrefecture,
          destinationArea: r.destinationArea,
          rank: r.rank,
          price: r.price,
          sourceReference: r.sourceReference,
          updatedAt: r.updatedAt,
        })),
      ),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "CSVの書き出しに失敗しました。" };
  }
}

export type ShippingCsvImportResult =
  | { ok: true; applied: number; unchanged: number; total: number }
  | { ok: false; error: string; lineErrors?: { line: number; message: string }[] };

/**
 * CSVで料金を一括更新する(ADMIN限定)。
 *
 * 1行でも壊れていたら**何も適用しない**。途中まで書いて止まると、
 * どこまで反映されたか分からない状態になる。
 */
export async function importShippingRatesCsvAction(csvText: string): Promise<ShippingCsvImportResult> {
  try {
    const who = await requireAdmin();

    const parsed = parseShippingCsv(typeof csvText === "string" ? csvText : "");
    if (!parsed.ok) {
      return {
        ok: false,
        error: `${parsed.errors.length}件の問題があるため、1件も更新していません。`,
        lineErrors: parsed.errors.slice(0, 20),
      };
    }

    const existing = await listShippingRates();
    const changed = selectChangedRows(
      parsed.rows,
      existing.map((r) => ({
        destinationPrefecture: r.destinationPrefecture,
        destinationArea: r.destinationArea,
        rank: r.rank,
        price: r.price,
      })),
    );

    const byKey = new Map(existing.map((r) => [`${r.destinationPrefecture}|${r.destinationArea ?? ""}|${r.rank}`, r]));
    for (const row of changed) {
      const key = `${row.destinationPrefecture}|${row.destinationArea ?? ""}|${row.rank}`;
      const current = byKey.get(key);
      await saveShippingRate(
        current?.id ?? null,
        {
          provider: current?.provider ?? "アートセッティングデリバリー",
          service: current?.service ?? KAZAI_SERVICE_NAME,
          destinationPrefecture: row.destinationPrefecture,
          destinationArea: row.destinationArea,
          rank: row.rank,
          // 配送不可はpriceを持たせない(0円で埋めない)。
          price: row.price ?? 0,
          sourceReference: row.sourceReference ?? current?.sourceReference ?? null,
        },
        who,
      );
    }

    revalidatePath("/inventory/settings");
    return { ok: true, applied: changed.length, unchanged: parsed.rows.length - changed.length, total: parsed.rows.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "CSVの取り込みに失敗しました。" };
  }
}
