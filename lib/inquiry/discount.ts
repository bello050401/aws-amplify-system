/**
 * §9〜§13 値下げ交渉エンジン。純粋関数のみ。
 *
 * 【なぜコードで計算するか】仕様書§43が明示している通り、Novaに金額を
 * 考えさせない。7%引き・送料中央値・地域差額は、毎回同じ入力から同じ
 * 答えが出なければならない種類の計算で、文章生成モデルに任せる仕事では
 * ない。ここで確定した金額**だけ**を文章化させる。
 *
 * 【丸め】既存の自動値下げ(lib/listing/pricing.tsのcalculateMarkdownPrice)が
 * 百分率の値下げに Math.floor を使っている。同じ商品の価格を扱う以上、
 * ここだけ別の丸め方をすると社内で金額が食い違う。100円/1,000円丸めの
 * ような新しい規則は入れない(§9.2)。
 */
import type { ShippingRateRecord } from "@/lib/shipping/types";

/** §9.2 請求書・銀行振込で案内できる場合の基本値引き率。 */
export const BASE_DISCOUNT_RATE = 0.07;

/**
 * §9.1 値下げ交渉の意図。
 *
 * 「価格はいくらですか」という単純な価格質問と区別する。前者は交渉、
 * 後者は事実の問い合わせで、返す内容がまったく違う。
 */
const DISCOUNT_PATTERNS = [
  /値下げ/,
  /値引き/,
  /お?安く(?:な|し|でき)/,
  /まけ(?:て|られ)/,
  /負けて/,
  /割引/,
  /価格交渉/,
  /値段交渉/,
  /交渉(?:は)?(?:可能|できま)/,
  /即決/,
  /いくらまで/,
  /どこまで下が/,
  /予算/,
];

/** 単なる価格質問。これだけなら交渉ではない。 */
const PLAIN_PRICE_PATTERNS = [/価格は?いくら/, /お?値段は?いくら/, /金額は?いくら/, /税込/, /税抜/];

export function detectDiscountIntent(text: string): boolean {
  const hit = DISCOUNT_PATTERNS.some((re) => re.test(text));
  if (!hit) return false;
  // 「価格はいくらですか」だけの文で、交渉語が「予算」等の弱いものしか
  // 無い場合は交渉としない。
  const onlyPlainPrice = PLAIN_PRICE_PATTERNS.some((re) => re.test(text)) && !/値下げ|値引き|安く|まけ|負けて|割引|交渉|即決|いくらまで|どこまで下が/.test(text);
  return !onlyPlainPrice;
}

/** §9.2 基本7%引き。既存の値下げと同じくMath.floorで丸める。 */
export function calculateBaseDiscountedPrice(salePrice: number): number {
  return Math.floor(salePrice * (1 - BASE_DISCOUNT_RATE));
}

/**
 * §11.1 配送ランクごとの「全国送料中央値」。
 *
 * 単純な全国一律値ではなく、そのランクで実際に確定している都道府県別
 * 送料の中央値を基準にする。除外するのは:
 *   - 金額が無い行(price が null = 公式にサービス対象外、等)
 *   - status が UNAVAILABLE の行
 *   - 0円以下の異常値
 * 同一都道府県に複数行がある場合は version の大きいものだけを使う
 * (既存の lookupShippingRate と同じ選び方)。
 */
export function nationalMedianShipping(rates: ShippingRateRecord[], rank: string): number | null {
  const byPrefecture = new Map<string, ShippingRateRecord>();
  for (const rate of rates) {
    if (rate.rank !== rank) continue;
    if (rate.status === "UNAVAILABLE") continue;
    if (rate.price == null || rate.price <= 0) continue;
    const current = byPrefecture.get(rate.destinationPrefecture);
    if (!current || rate.version > current.version) byPrefecture.set(rate.destinationPrefecture, rate);
  }
  const prices = [...byPrefecture.values()].map((r) => r.price!).sort((a, b) => a - b);
  if (prices.length === 0) return null;
  const mid = Math.floor(prices.length / 2);
  // 偶数件は中央2つの平均。円未満は切り捨てる(金額なので整数へ)。
  return prices.length % 2 === 1 ? prices[mid] : Math.floor((prices[mid - 1] + prices[mid]) / 2);
}

/**
 * §11.2 地域補正。
 *
 * 配送先の送料が全国中央値より**高い分だけ**を値引き後価格へ戻す。
 * 中央値より安い地域でも、その差額を追加値引きにはしない —— 基本7%を
 * 維持する(仕様書の明示要件)。
 */
export function calculateShippingAdjustment(destinationShipping: number, median: number): number {
  return Math.max(0, destinationShipping - median);
}

export type DiscountUndeterminedReason =
  | "PRODUCT_NOT_RESOLVED"
  | "SALE_PRICE_UNKNOWN"
  | "DESTINATION_UNKNOWN"
  | "SHIPPING_RANK_UNKNOWN"
  | "NATIONAL_MEDIAN_UNKNOWN"
  | "DESTINATION_RATE_UNKNOWN";

export interface DiscountOfferInput {
  productResolved: boolean;
  /** 現在の販売価格(顧客向けの正本)。 */
  salePrice: number | null;
  /** 商品の配送ランク。寸法から算出済みのもの。 */
  shippingRank: string | null;
  /** 配送先都道府県。会話から確定できていなければnull。 */
  destinationPrefecture: string | null;
  /** 配送先の送料(既存の送料マスタから引いた確定値)。 */
  destinationShipping: number | null;
  /** そのランクの全国送料中央値。 */
  nationalMedian: number | null;
}

export interface DiscountOffer {
  /** 値引き後の金額を提示できる状態か。 */
  determined: boolean;
  /** 7%引き後の価格。販売価格が分かれば出せる。 */
  baseDiscountedPrice: number | null;
  nationalMedian: number | null;
  destinationShipping: number | null;
  /** 配送先送料 − 全国中央値（下限0）。 */
  shippingAdjustment: number | null;
  /** 実際に提示できる参考価格 = 7%引き + 地域補正。 */
  referenceOffer: number | null;
  /** 提示できない場合の理由。UIとログに出す。 */
  undeterminedReasons: DiscountUndeterminedReason[];
}

/**
 * 値下げの参考提示額を組み立てる。
 *
 * どれか1つでも欠けていれば金額を作らない。「たぶんこれくらい」を
 * 出さないための関数で、欠けている理由を返すのが本体の仕事でもある。
 */
export function buildDiscountOffer(input: DiscountOfferInput): DiscountOffer {
  const reasons: DiscountUndeterminedReason[] = [];
  if (!input.productResolved) reasons.push("PRODUCT_NOT_RESOLVED");
  if (input.salePrice == null || input.salePrice <= 0) reasons.push("SALE_PRICE_UNKNOWN");
  if (!input.destinationPrefecture) reasons.push("DESTINATION_UNKNOWN");
  if (!input.shippingRank) reasons.push("SHIPPING_RANK_UNKNOWN");
  if (input.nationalMedian == null) reasons.push("NATIONAL_MEDIAN_UNKNOWN");
  if (input.destinationShipping == null) reasons.push("DESTINATION_RATE_UNKNOWN");

  const baseDiscountedPrice =
    input.salePrice != null && input.salePrice > 0 ? calculateBaseDiscountedPrice(input.salePrice) : null;

  if (reasons.length > 0) {
    return {
      determined: false,
      baseDiscountedPrice,
      nationalMedian: input.nationalMedian,
      destinationShipping: input.destinationShipping,
      shippingAdjustment: null,
      referenceOffer: null,
      undeterminedReasons: reasons,
    };
  }

  const shippingAdjustment = calculateShippingAdjustment(input.destinationShipping!, input.nationalMedian!);
  return {
    determined: true,
    baseDiscountedPrice,
    nationalMedian: input.nationalMedian,
    destinationShipping: input.destinationShipping,
    shippingAdjustment,
    referenceOffer: baseDiscountedPrice! + shippingAdjustment,
    undeterminedReasons: [],
  };
}

/**
 * §12 スタッフ向けの判断材料。
 *
 * **顧客向けPromptへは絶対に渡さない**（仕入価格・販売開始日時・経過日数）。
 * 型を分けてあるのは、customer-safe側の関数へ間違って渡せないようにするため。
 */
export interface DiscountStaffCard {
  inventoryId: string;
  displayInventoryId: string;
  productName: string;
  imageKey: string | null;
  salePrice: number | null;
  /** staff-only。 */
  purchasePrice: number | null;
  /** staff-only。 */
  saleStartDate: string | null;
  /** staff-only。販売開始からの経過日数。 */
  daysOnSale: number | null;
  destinationPrefecture: string | null;
  shippingRank: string | null;
  nationalMedian: number | null;
  destinationShipping: number | null;
  shippingAdjustment: number | null;
  baseDiscountedPrice: number | null;
  referenceOffer: number | null;
  undeterminedReasons: DiscountUndeterminedReason[];
}

/** §12.1 販売開始からの経過日数。日付境界はコードで決める。 */
export function daysOnSale(saleStartDate: string | null, now: Date = new Date()): number | null {
  if (!saleStartDate) return null;
  const start = Date.parse(saleStartDate.length === 10 ? `${saleStartDate}T00:00:00+09:00` : saleStartDate);
  if (Number.isNaN(start)) return null;
  const diffMs = now.getTime() - start;
  if (diffMs < 0) return 0;
  return Math.floor(diffMs / 86_400_000);
}

/** 顧客向けPromptへ渡してよい、値下げ関連の事実だけを取り出す。 */
export function customerSafeDiscountFacts(offer: DiscountOffer): { label: string; value: string }[] {
  const facts: { label: string; value: string }[] = [];
  if (offer.determined && offer.referenceOffer != null) {
    facts.push({ label: "お値引き後のご提示価格(確定値)", value: `${offer.referenceOffer.toLocaleString("ja-JP")}円` });
  }
  return facts;
}
