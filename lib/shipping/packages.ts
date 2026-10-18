import { SHIPPING_RANKS, type ShippingRank } from "./rank";
import { calculateMedian, MIN_DISTINCT_REGIONS_FOR_MEDIAN } from "./referencePrice";
import type { ShippingRateRecord } from "./types";
import { SHIPPING_ORIGIN_PREFECTURE } from "./prefectures";
import { isKazaiServiceName, KAZAI_PROVIDER_NAME } from "./serviceName";

export interface ShippingPackage { id: string; name: string; rank: ShippingRank | null }
export const defaultShippingPackages = (): ShippingPackage[] => [{ id: "main", name: "", rank: null }];

export function normalizeShippingPackages(value: unknown): ShippingPackage[] {
  if (value == null) return defaultShippingPackages();
  if (!Array.isArray(value) || !value.length || value.length > 20) throw new Error("配送する荷物は1〜20口で指定してください。");
  const ids = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("配送する荷物の内容が不正です。");
    const p = item as Record<string, unknown>;
    if (typeof p.id !== "string" || !/^[\w-]{1,64}$/.test(p.id) || ids.has(p.id)) throw new Error("荷物の識別情報が不正です。");
    ids.add(p.id);
    if (p.rank !== null && !SHIPPING_RANKS.includes(p.rank as ShippingRank)) throw new Error("家財便のサイズを選択してください。");
    if (typeof p.name !== "string" || p.name.length > 80) throw new Error("荷物の名称は80文字以内にしてください。");
    return { id: p.id, name: p.name.trim(), rank: p.rank as ShippingRank | null };
  });
}

export type PackageFee = { id: string; name: string; rank: ShippingRank | null; fee: number | null; reason: string | null };
export type PackageRate = Pick<ShippingRateRecord, "provider" | "service" | "originPrefecture" | "destinationPrefecture" |
  "destinationArea" | "rank" | "price" | "taxIncluded" | "currency" | "surcharge" | "effectiveFrom" | "effectiveTo" |
  "verifiedAt" | "status" | "version">;
export interface PackageQuoteData {
  rates: PackageRate[];
  estimatedRank: ShippingRank | null;
  plannedPrice: number | null;
  asOfDate: string;
}
export interface PackageQuote {
  packages: PackageFee[];
  shippingTotal: number | null;
  plannedPrice: number | null;
  referenceTotal: number | null;
  regions: { key: string; label: string }[];
  destinationKey: string | null;
}

/** A selected destination applies to every package. Unavailable or missing rates never mean zero. */
export function buildPackageQuote(input: { packages: ShippingPackage[]; estimatedRank: ShippingRank | null;
  plannedPrice: number | null; rates: PackageRate[]; asOfDate: string; destinationKey?: string | null }): PackageQuote {
  const packages = normalizeShippingPackages(input.packages);
  const latest = new Map<string, PackageRate>();
  const regionKey = (r: PackageRate) => JSON.stringify([r.destinationPrefecture, r.destinationArea]);
  for (const r of input.rates) {
    if (r.provider !== KAZAI_PROVIDER_NAME || !isKazaiServiceName(r.service) ||
      r.currency !== "JPY" || !r.taxIncluded || r.originPrefecture !== SHIPPING_ORIGIN_PREFECTURE ||
      (r.effectiveFrom && r.effectiveFrom > input.asOfDate) || (r.effectiveTo && r.effectiveTo < input.asOfDate)) continue;
    const key = JSON.stringify([r.rank, regionKey(r)]), old = latest.get(key);
    if (!old || (r.effectiveFrom ?? "") > (old.effectiveFrom ?? "")
      || r.effectiveFrom === old.effectiveFrom && r.version > old.version) latest.set(key, r);
  }
  // Choose the latest row before rejecting stale/unconfirmed rates: an old price must not reappear.
  const rates = [...latest.values()].filter(r => r.verifiedAt && r.status !== "STALE" && r.status !== "UNCONFIRMED");
  const selectedRanks = new Set(packages.map(p => p.rank ?? input.estimatedRank));
  const regionMap = new Map(rates.filter(r => selectedRanks.has(r.rank)).map(r => [regionKey(r),
    { key: regionKey(r), label: [r.destinationPrefecture, r.destinationArea].filter(Boolean).join(" ") }]));
  const rows = packages.map((p, i): PackageFee => {
    const rank = p.rank ?? input.estimatedRank;
    const row = { id: p.id, name: p.name || `${i + 1}口目`, rank, fee: null, reason: null };
    if (!rank) return { ...row, reason: "サイズ未選択" };
    if (rank === "OVERSIZE") return { ...row, reason: "個別見積りが必要です" };
    const candidates = rates.filter(r => r.rank === rank);
    if (input.destinationKey) {
      const r = candidates.find(r => regionKey(r) === input.destinationKey);
      if (!r) return { ...row, reason: "料金未登録" };
      if (r.status === "UNAVAILABLE" || r.price == null) return { ...row, reason: "配送不可・要確認" };
      if (!validFee(r)) return { ...row, reason: "料金の確認が必要です" };
      return { ...row, fee: r.price + (r.surcharge ?? 0) };
    }
    const priced = candidates.filter(validFee);
    if (new Set(priced.map(r => r.destinationPrefecture)).size < MIN_DISTINCT_REGIONS_FOR_MEDIAN)
      return { ...row, reason: "参考送料を計算する料金データが不足しています" };
    return { ...row, fee: calculateMedian(priced.map(r => r.price + (r.surcharge ?? 0)).sort((a, b) => a - b)) };
  });
  const shippingTotal = rows.every(r => r.fee != null) ? rows.reduce((sum, r) => sum + r.fee!, 0) : null;
  const plannedPrice = input.plannedPrice != null && Number.isFinite(input.plannedPrice) && input.plannedPrice >= 0 ? input.plannedPrice : null;
  return { packages: rows, shippingTotal, plannedPrice,
    referenceTotal: shippingTotal != null && plannedPrice != null ? shippingTotal + plannedPrice : null,
    regions: [...regionMap.values()], destinationKey: input.destinationKey ?? null };
}

function validFee(rate: PackageRate): rate is PackageRate & { price: number } {
  return rate.status !== "UNAVAILABLE" && rate.price != null && Number.isSafeInteger(rate.price) &&
    rate.price >= 0 && (rate.surcharge == null || Number.isSafeInteger(rate.surcharge) && rate.surcharge >= 0);
}
