import "server-only";
import {
  BASE_DISCOUNT_RATE,
  buildDiscountOffer,
  calculateBaseDiscountedPrice,
  daysOnSale,
  nationalMedianShipping,
  type DiscountOffer,
} from "./discount";
import { listShippingRates, lookupShippingRate } from "@/lib/shipping/service";
import { calculateShippingRankFromDimensionsDetailed } from "@/lib/shipping/rank";
import { DISCOUNT_RULES_TITLE } from "@/lib/knowledge/businessRules";
import type { NegotiationEvidence, NegotiationStaffCard } from "./types";
import type { NegotiationContext } from "./negotiation";

/**
 * 値下げ交渉の「計算」層(指示書 §5〜§8)。
 *
 * ── ここが引き受けること ────────────────────────────────────────
 *
 *   最大外形3辺 → 配送ランク → ShippingRate(正本) → 送料
 *   販売価格 → 7%引き(既存 discount.ts の Math.floor をそのまま使う)
 *   仕入価格・販売開始日時 → 管理者向けの判断材料
 *   公式LINE＋請求書払い条件の適用可否
 *
 * ── ここが絶対にしないこと ──────────────────────────────────────
 *
 *   ・金額をAIに考えさせない(数字はすべてこの層で確定する)
 *   ・配送先が分からないのに送料を推測しない
 *   ・ShippingRateに無い組合せの金額を作らない
 *   ・仕入価格・経過日数を顧客向けの事実として返さない
 *     (戻り値の型が NegotiationStaffCard で、顧客向けプロンプト組み立て
 *      関数はこの型を受け取る口を持たない)
 */

/** 既存の値引きルール文書のタイトル。条件の出所として管理者へ提示する。 */
export const DISCOUNT_RULE_SOURCE_TITLE = DISCOUNT_RULES_TITLE;

export interface NegotiationInventoryFacts {
  inventoryId: string;
  displayInventoryId: string;
  name: string;
  /** 現在の販売価格(単価)。salePriceが無ければ販売予定価格。 */
  unitSalePriceYen: number | null;
  /** どちらを使ったか(管理者へ明示する)。 */
  unitSalePriceSource: "salePrice" | "plannedSalePrice" | null;
  purchasePriceYen: number | null;
  saleStartDate: string | null;
  width: string | null;
  depth: string | null;
  height: string | null;
}

export interface ResolveNegotiationParams {
  context: NegotiationContext;
  inventory: NegotiationInventoryFacts | null;
  /** 会話から確定した配送先都道府県(不明ならnull)。 */
  destinationPrefecture: string | null;
  /** 会話のチャネル。公式LINE条件の判定に使う。 */
  channel: string;
  baseProduct: { baseItemId: string; title: string; price: number | null; itemUrl: string | null } | null;
}

export interface ResolveNegotiationResult {
  evidence: NegotiationEvidence;
  staffCard: NegotiationStaffCard | null;
  /** 顧客向けプロンプトへ渡してよい、確定した事実だけ。 */
  customerSafeFacts: { label: string; value: string }[];
  /** 顧客へ確認すべきこと。 */
  customerQuestions: string[];
  /** 判断に足りない情報(管理者向け)。 */
  missing: string[];
}

/**
 * 公式LINE＋請求書払い条件(指示書§8)。
 *
 * 条件の内容は新しく作らず、既存の値引きルール文書
 * (lib/knowledge/businessRules.ts の DISCOUNT_RULES_CONTENT)に書かれて
 * いるものをそのまま使う ——「BELLOから請求書をお送りし、銀行振込で
 * お支払いいただける場合、商品代金の7%引きを基本としてご案内する」。
 *
 * 「公式LINE」の部分は、この問い合わせが公式LINEアカウント経由で
 * 届いていることで満たされる。チャネルがLINE以外の場合は、
 * 「公式LINEでのお手続き」という前提が成り立たないので適用可とは
 * 言い切らない(勝手に提示しない、という要件)。
 */
export function evaluateOfficialLinePaymentCondition(channel: string): {
  applicable: boolean;
  reason: string;
  sourceDocumentTitle: string | null;
} {
  if (channel === "LINE") {
    return {
      applicable: true,
      reason: "公式LINE経由の問い合わせのため、請求書払い(銀行振込)を条件とした7%引きの案内対象。",
      sourceDocumentTitle: DISCOUNT_RULE_SOURCE_TITLE,
    };
  }
  return {
    applicable: false,
    reason: `このお問い合わせは${channel}経由のため、公式LINEでのお手続きを前提とした条件をそのまま適用できない。人の判断が必要。`,
    sourceDocumentTitle: DISCOUNT_RULE_SOURCE_TITLE,
  };
}

export async function resolveNegotiation(params: ResolveNegotiationParams): Promise<ResolveNegotiationResult> {
  const { context, inventory, destinationPrefecture, channel, baseProduct } = params;

  const missing: string[] = [];
  const customerQuestions: string[] = [];
  const decisionNotes: string[] = [];

  // ── 配送先が分からないなら、値下げ可否より先に地域を確認する ────
  //
  // 指示書§4: 「値下げ交渉時に配送先地域が不明な場合、送料が採算判断へ
  // 影響するため、値下げ可否より先に配送先地域を確認する」。
  const awaitingDestination = !destinationPrefecture;
  if (awaitingDestination) {
    customerQuestions.push("お届け先の都道府県をお伺いする");
    missing.push("お届け先の都道府県");
  }

  const evidence: NegotiationEvidence = {
    detected: context.isNegotiation,
    signals: context.signals,
    quantity: context.quantity,
    requestedTotalPriceYen: context.requestedTotalPriceYen,
    requestedUnitPriceYen: context.requestedUnitPriceYen,
    carriedOverFromHistory: !context.fromCurrentMessage,
    awaitingDestination,
  };

  if (!inventory) {
    missing.push("対象商品(BELLO在庫)の特定");
    return {
      evidence,
      staffCard: baseProduct
        ? emptyStaffCardForBaseOnly(baseProduct, context, evaluateOfficialLinePaymentCondition(channel), missing)
        : null,
      customerSafeFacts: [],
      customerQuestions,
      missing,
    };
  }

  // ── 送料判定用の最大外形3辺 ──────────────────────────────────
  const dims = calculateShippingRankFromDimensionsDetailed(inventory.width, inventory.depth, inventory.height);
  const hasRank = "rank" in dims;
  const rank = hasRank ? dims.rank : null;
  const shippingDimensionText = hasRank
    ? `幅${dims.widthCm} × 奥行${dims.depthCm} × 高さ${dims.heightCm} cm`
    : null;
  const shippingSumCm = hasRank ? dims.sumCm : null;
  if (!hasRank) {
    const why = dims.missingAxes.map((a) => a.label).join("・");
    missing.push(`送料判定用の外形寸法(${why})`);
    decisionNotes.push(
      `送料判定に使える外形寸法が揃っていない(${why})。座面寸法・SH・AHは送料判定に使えないため、外形の寸法を登録する必要がある。`,
    );
  }

  // ── ShippingRate(正本)から送料 ──────────────────────────────
  let shippingFeeYen: number | null = null;
  if (destinationPrefecture && rank) {
    const rate = await lookupShippingRate(destinationPrefecture, rank);
    if (!rate) {
      missing.push(`ShippingRate(埼玉県 → ${destinationPrefecture} / ${rank}ランク)`);
      decisionNotes.push(`料金マスタに 埼玉県 → ${destinationPrefecture}・${rank}ランク の行が無い。金額は推測しない。`);
    } else if (rate.price == null) {
      decisionNotes.push(`埼玉県 → ${destinationPrefecture}・${rank}ランク はサービス対象外(配送不可/要確認)。`);
    } else {
      shippingFeeYen = rate.price + (rate.surcharge ?? 0);
    }
  }

  // ── 7%引き(既存エンジンをそのまま使う。丸めも変えない) ────────
  const unitSale = inventory.unitSalePriceYen;
  if (unitSale == null) missing.push("現在の販売価格");
  const quantity = context.quantity ?? 1;
  const totalSale = unitSale != null ? unitSale * quantity : null;
  const baseDiscountedUnit = unitSale != null && unitSale > 0 ? calculateBaseDiscountedPrice(unitSale) : null;
  const baseDiscountedTotal = baseDiscountedUnit != null ? baseDiscountedUnit * quantity : null;

  // 既存の値下げエンジンにも通す。地域補正(全国中央値との差額)は
  // discount.ts の責務で、ここで別式を作らない。
  let offer: DiscountOffer | null = null;
  if (rank) {
    const allRates = await listShippingRates();
    const median = nationalMedianShipping(allRates, rank);
    offer = buildDiscountOffer({
      productResolved: true,
      salePrice: unitSale,
      shippingRank: rank,
      destinationPrefecture,
      destinationShipping: shippingFeeYen,
      nationalMedian: median,
    });
  }

  const requestedTotal = context.requestedTotalPriceYen;
  const requestedUnit = context.requestedUnitPriceYen;
  const requestedDiscountRate =
    requestedTotal != null && totalSale != null && totalSale > 0 ? 1 - requestedTotal / totalSale : null;

  if (requestedDiscountRate != null) {
    const pct = (requestedDiscountRate * 100).toFixed(1);
    if (requestedDiscountRate <= 0) {
      decisionNotes.push(`お客様の希望額は現在価格の合計(${totalSale?.toLocaleString("ja-JP")}円)以上。値引きの必要が無い可能性がある。`);
    } else if (requestedDiscountRate <= BASE_DISCOUNT_RATE) {
      decisionNotes.push(`希望値引率 ${pct}% は基本値引き率 ${(BASE_DISCOUNT_RATE * 100).toFixed(0)}% の範囲内。`);
    } else {
      decisionNotes.push(`希望値引率 ${pct}% は基本値引き率 ${(BASE_DISCOUNT_RATE * 100).toFixed(0)}% を超える。人の判断が必要。`);
    }
  }

  if (inventory.unitSalePriceSource === "plannedSalePrice") {
    decisionNotes.push("販売価格が未確定のため、販売予定価格(ZAICOの「☆販売予定価格（送料別大原記載）」)を単価として使用した。");
  }

  const condition = evaluateOfficialLinePaymentCondition(channel);

  const staffCard: NegotiationStaffCard = {
    productName: inventory.name,
    baseItemId: baseProduct?.baseItemId ?? null,
    baseItemUrl: baseProduct?.itemUrl ?? null,
    baseListedPriceYen: baseProduct?.price ?? null,
    inventoryId: inventory.inventoryId,
    displayInventoryId: inventory.displayInventoryId,
    quantity: context.quantity,
    unitSalePriceYen: unitSale,
    totalSalePriceYen: totalSale,
    requestedTotalPriceYen: requestedTotal,
    requestedUnitPriceYen: requestedUnit,
    requestedDiscountRate,
    purchaseUnitPriceYen: inventory.purchasePriceYen,
    purchaseTotalPriceYen: inventory.purchasePriceYen != null ? inventory.purchasePriceYen * quantity : null,
    saleStartDate: inventory.saleStartDate,
    daysOnSale: daysOnSale(inventory.saleStartDate),
    shippingRank: rank,
    shippingDimensionText,
    shippingSumCm,
    destinationPrefecture,
    shippingFeeYen,
    totalWithShippingYen: totalSale != null && shippingFeeYen != null ? totalSale + shippingFeeYen : null,
    baseDiscountedUnitPriceYen: baseDiscountedUnit,
    baseDiscountedTotalPriceYen: baseDiscountedTotal,
    differenceFromRequestedYen:
      requestedTotal != null && baseDiscountedTotal != null ? requestedTotal - baseDiscountedTotal : null,
    officialLinePaymentCondition: condition,
    decisionNotes,
    missingInformation: missing,
  };

  // ── 顧客向けに出してよい事実 ────────────────────────────────
  //
  // 配送先が未確定のうちは**金額を一切出さない**。値下げ可否も確定
  // しない(指示書§4の禁止事項)。
  const customerSafeFacts: { label: string; value: string }[] = [];
  if (!awaitingDestination && offer?.determined && offer.referenceOffer != null) {
    customerSafeFacts.push({
      label: "お値引き後のご提示価格(単価・確定値)",
      value: `${offer.referenceOffer.toLocaleString("ja-JP")}円`,
    });
    if (quantity > 1) {
      customerSafeFacts.push({
        label: `${quantity}点合計のご提示価格(確定値)`,
        value: `${(offer.referenceOffer * quantity).toLocaleString("ja-JP")}円`,
      });
    }
    if (shippingFeeYen != null && destinationPrefecture) {
      customerSafeFacts.push({ label: `送料(${destinationPrefecture})`, value: `${shippingFeeYen.toLocaleString("ja-JP")}円` });
    }
  }

  return { evidence, staffCard, customerSafeFacts, customerQuestions, missing };
}

/** BASE商品までは特定できたが在庫へ紐付いていない場合の、最小限の判断カード。 */
function emptyStaffCardForBaseOnly(
  baseProduct: { baseItemId: string; title: string; price: number | null; itemUrl: string | null },
  context: NegotiationContext,
  condition: { applicable: boolean; reason: string; sourceDocumentTitle: string | null },
  missing: string[],
): NegotiationStaffCard {
  return {
    productName: baseProduct.title,
    baseItemId: baseProduct.baseItemId,
    baseItemUrl: baseProduct.itemUrl,
    baseListedPriceYen: baseProduct.price,
    inventoryId: null,
    displayInventoryId: null,
    quantity: context.quantity,
    unitSalePriceYen: null,
    totalSalePriceYen: null,
    requestedTotalPriceYen: context.requestedTotalPriceYen,
    requestedUnitPriceYen: context.requestedUnitPriceYen,
    requestedDiscountRate: null,
    purchaseUnitPriceYen: null,
    purchaseTotalPriceYen: null,
    saleStartDate: null,
    daysOnSale: null,
    shippingRank: null,
    shippingDimensionText: null,
    shippingSumCm: null,
    destinationPrefecture: null,
    shippingFeeYen: null,
    totalWithShippingYen: null,
    baseDiscountedUnitPriceYen: null,
    baseDiscountedTotalPriceYen: null,
    differenceFromRequestedYen: null,
    officialLinePaymentCondition: condition,
    decisionNotes: [
      "BASE商品は特定できたが、BELLO在庫との紐付けが未確定。仕入価格・販売開始日時・7%基準額は在庫が確定してから算出する。",
    ],
    missingInformation: missing,
  };
}
