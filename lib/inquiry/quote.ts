import type { ShippingRateRecord } from "@/lib/shipping/types";
import {
  isKazaiServiceName,
  KAZAI_PROVIDER_NAME,
} from "@/lib/shipping/serviceName";

export type ResultState =
  | "SUCCESS"
  | "NOT_FOUND"
  | "MISSING"
  | "AMBIGUOUS"
  | "CONFLICT"
  | "UNSUPPORTED"
  | "FAILED"
  | "EXPIRED";
export type ChargePolicy = {
  id: string;
  version: string;
  mode: "INCLUDED" | "SEPARATE" | "REGIONAL";
  approved: boolean;
  regionalYen?: number;
  regionalTreatment?: "INCLUDED_IN_SHIPPING" | "ADDITIONAL";
  customerShippingYen?: number;
  optionsYen?: number;
  discountYen?: number;
};
export interface InquiryQuote {
  version: "2026-11-08.1";
  state: ResultState;
  at: string;
  asOfDate: string;
  confirmed: boolean;
  conditions: {
    origin: string | null;
    destination: string | null;
    area: string | null;
    service: string | null;
    packages: string[];
    quantity: number | null;
  };
  merchandiseYen: number | null;
  carrierCostYen: number | null;
  customerShippingYen: number | null;
  regionalYen: number | null;
  optionsYen: number | null;
  discountYen: number | null;
  totalYen: number | null;
  rates: {
    id: string;
    version: number;
    source: string | null;
    verifiedAt: string | null;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    updatedAt: string;
  }[];
  policy: ChargePolicy | null;
  missing: string[];
  reasons: string[];
}
export interface QuoteInput {
  at: string;
  asOfDate: string;
  origin: string | null;
  destination: string | null;
  area?: string | null;
  service: "KAZAI" | string | null;
  ranks: string[];
  packagesConfirmed: boolean;
  quantity: number | null;
  unitPriceYen: number | null;
  policy: ChargePolicy | null;
  rates: ShippingRateRecord[];
  lookupFailed?: boolean;
  exceptionalRegion?: boolean;
  specialWorkUnconfirmed?: boolean;
}
const yen = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export function calculateInquiryQuote(i: QuoteInput): InquiryQuote {
  const q: InquiryQuote = {
    version: "2026-11-08.1",
    state: "MISSING",
    at: i.at,
    asOfDate: i.asOfDate,
    confirmed: false,
    conditions: {
      origin: i.origin,
      destination: i.destination,
      area: i.area ?? null,
      service: i.service,
      packages: i.ranks,
      quantity: i.quantity,
    },
    merchandiseYen: null,
    carrierCostYen: null,
    customerShippingYen: null,
    regionalYen: null,
    optionsYen: null,
    discountYen: null,
    totalYen: null,
    rates: [],
    policy: i.policy,
    missing: [],
    reasons: [],
  };
  const stop = (state: ResultState, reason: string, missing?: string) => {
    q.state = state;
    q.reasons.push(reason);
    if (missing) q.missing.push(missing);
    return q;
  };
  if (
    !Number.isFinite(Date.parse(i.at)) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(i.asOfDate)
  )
    return stop("MISSING", "見積日を確認してください。");
  if (i.lookupFailed)
    return stop(
      "FAILED",
      "料金表・配送条件を取得できませんでした。0円として扱いません。",
    );
  if (
    !Number.isSafeInteger(i.quantity) ||
    i.quantity! <= 0 ||
    !yen(i.unitPriceYen)
  )
    q.missing.push("商品代金・購入数量");
  else {
    const m = i.quantity! * i.unitPriceYen!;
    if (!yen(m)) return stop("MISSING", "金額が許容範囲外です。");
    q.merchandiseYen = m;
  }
  if (!i.origin) q.missing.push("発送元");
  if (!i.destination) q.missing.push("お届け先の都道府県");
  if (!i.packagesConfirmed || !i.ranks.length || i.ranks.some((r) => !r))
    q.missing.push("確定した配送ランク・口数");
  if (q.missing.length) return stop("MISSING", "必要な条件が未確認です。");
  if (i.exceptionalRegion)
    return stop(
      "MISSING",
      "離島等の適用地域を配送会社に確認してください。詳細住所は保存しません。",
      "配送地域の確認",
    );
  if (i.specialWorkUnconfirmed)
    return stop(
      "MISSING",
      "搬入・特殊作業の条件と追加料金が未確認です。",
      "搬入・特殊作業",
    );
  if (i.service !== "KAZAI")
    return stop(
      "UNSUPPORTED",
      "登録済み料金表で扱える配送サービスではありません。",
    );
  const matched = i.rates.filter(
    (r) =>
      r.provider === KAZAI_PROVIDER_NAME &&
      isKazaiServiceName(r.service) &&
      r.originPrefecture === i.origin &&
      r.destinationPrefecture === i.destination,
  );
  const selected: ShippingRateRecord[] = [];
  for (const rank of i.ranks) {
    const rows = matched.filter((r) => r.rank === rank);
    if (!rows.length) return stop("NOT_FOUND", `${rank}の料金が未登録です。`);
    const dated = rows.filter(
      (r) =>
        (!r.effectiveFrom || r.effectiveFrom.slice(0, 10) <= i.asOfDate) &&
        (!r.effectiveTo || r.effectiveTo.slice(0, 10) >= i.asOfDate),
    );
    if (!dated.length)
      return stop("EXPIRED", "適用日に有効な料金表がありません。");
    const areas = [...new Set(dated.map((r) => r.destinationArea ?? ""))];
    if (areas.some(Boolean) && !i.area)
      return stop(
        "MISSING",
        "都道府県内に複数の料金地域があります。",
        "料金表の配送地域",
      );
    const candidates = dated.filter(
      (r) => (r.destinationArea ?? "") === (i.area ?? ""),
    );
    if (!candidates.length)
      return stop("NOT_FOUND", "指定地域の料金が見つかりません。");
    // Version alone cannot resolve overlapping contracts or effective periods.
    if (candidates.length !== 1)
      return stop(
        "CONFLICT",
        "同じ条件で複数の料金表が有効です。適用期間を確認してください。",
      );
    const r = candidates[0];
    selected.push(r);
    q.rates.push({
      id: r.id,
      version: r.version,
      source: r.sourceReference,
      verifiedAt: r.verifiedAt,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      updatedAt: r.updatedAt,
    });
    if (r.status === "UNAVAILABLE")
      return stop("UNSUPPORTED", "料金表では配送対象外です。");
    if (r.status === "STALE")
      return stop("EXPIRED", "料金表の確認期限が切れています。");
    if (!r.verifiedAt || r.status === "UNCONFIRMED" || !r.sourceReference)
      return stop("MISSING", "料金表の確認・出典が不足しています。");
    if (!r.taxIncluded || r.currency !== "JPY")
      return stop(
        "UNSUPPORTED",
        "税込円の料金ではありません。税区分を確認してください。",
      );
    if (!yen(r.price) || !yen(r.surcharge ?? 0))
      return stop("MISSING", "料金が未確認です。0円で補いません。");
  }
  q.carrierCostYen = selected.reduce(
    (s, r) => s + r.price! + (r.surcharge ?? 0),
    0,
  );
  if (!yen(q.carrierCostYen))
    return stop("MISSING", "配送原価が許容範囲外です。");
  // Legacy rows remain visible as reference cost; no invented effective date.
  if (selected.some((r) => !r.effectiveFrom))
    return stop(
      "MISSING",
      "料金表の適用開始日が未登録です。配送原価は参考値です。",
      "料金表の有効性（社内確認）",
    );
  const p = i.policy;
  if (!p?.approved)
    return stop(
      "MISSING",
      "お客様に請求する送料の条件が未確認です。",
      "送料込み・別／地域加算の条件",
    );
  const regional = p.regionalYen ?? 0,
    options = p.optionsYen ?? 0,
    discount = p.discountYen ?? 0;
  if (![regional, options, discount].every(yen))
    return stop("MISSING", "加算・割引額が不正です。");
  const shipping =
    p.mode === "INCLUDED"
      ? 0
      : p.mode === "SEPARATE"
        ? (p.customerShippingYen ?? q.carrierCostYen)
        : p.customerShippingYen;
  if (!yen(shipping)) return stop("MISSING", "顧客請求送料が未設定です。");
  if (regional > 0 && !p.regionalTreatment)
    return stop("MISSING", "地域加算の内数・外数が未設定です。");
  if (p.regionalTreatment === "INCLUDED_IN_SHIPPING" && regional > shipping)
    return stop("CONFLICT", "送料内の地域加算が送料総額を超えています。");
  q.customerShippingYen = shipping;
  q.regionalYen = regional;
  q.optionsYen = options;
  q.discountYen = discount;
  const total =
    q.merchandiseYen! +
    shipping +
    (p.regionalTreatment === "ADDITIONAL" ? regional : 0) +
    options -
    discount;
  if (!yen(total)) return stop("MISSING", "支払総額が不正です。");
  q.totalYen = total;
  q.state = "SUCCESS";
  q.confirmed = true;
  return q;
}

export function customerQuoteFacts(
  q: InquiryQuote,
): { label: string; value: string }[] {
  if (!q.confirmed) return [];
  return [
    ["商品代金", q.merchandiseYen],
    ["お客様に請求する送料", q.customerShippingYen],
    [
      "地域加算（" +
        (q.policy?.regionalTreatment === "ADDITIONAL" ? "別途" : "送料に含む") +
        "）",
      q.regionalYen,
    ],
    ["オプション料金", q.optionsYen],
    ["承認済み割引額", q.discountYen],
    ["送料込みのお支払総額", q.totalYen],
  ].map(([label, value]) => ({
    label: String(label),
    value: `${Number(value).toLocaleString("ja-JP")}円`,
  }));
}

/** Apply the existing bank-transfer proposal to a confirmed inclusive quote.
 * The caller must supply the selected, enabled rule. Never changes product prices. */
export function withBankTransferProposal(
  q: InquiryQuote,
  proposal: { discountedUnitYen: number; regionalUnitYen: number },
  rule: { id: string; version: number },
): InquiryQuote | null {
  const qty = q.conditions.quantity;
  if (
    !q.confirmed ||
    q.policy?.mode !== "INCLUDED" ||
    !qty ||
    !yen(q.merchandiseYen) ||
    !yen(proposal.discountedUnitYen) ||
    !yen(proposal.regionalUnitYen) ||
    !rule.id ||
    !Number.isSafeInteger(rule.version) ||
    rule.version < 1
  )
    return null;
  const discounted = proposal.discountedUnitYen * qty,
    regional = proposal.regionalUnitYen * qty;
  const discount = q.merchandiseYen - discounted;
  const total = discounted + regional + (q.optionsYen ?? 0);
  if (![discounted, regional, discount, total].every(yen)) return null;
  return {
    ...q,
    discountYen: discount,
    regionalYen: regional,
    totalYen: total,
    policy: {
      ...q.policy,
      id: q.policy.id + "+BANK_TRANSFER:" + rule.id,
      version: q.policy.version + "+" + rule.version,
      discountYen: discount,
      regionalYen: regional,
      regionalTreatment: "ADDITIONAL",
    },
  };
}
