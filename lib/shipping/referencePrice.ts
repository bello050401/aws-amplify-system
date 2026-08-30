import type { ShippingRank } from "./rank";
import type { ShippingRateRecord } from "./types";

/**
 * BELLO統合業務OS ZAICO級高速化・完成保証最大化版 §31/§46: EC出品下書
 * きの「送料込み参考価格」— 決定論的なShipping serviceの値のみを使い、
 * AIには一切計算・推測させない(§31冒頭「送料をAIに推測させない」)。
 * lib/shipping/rank.tsと同じpure/AWS分離方針(このファイルはAWSへ一切
 * アクセスしない — 呼び出し元のapp/actions/shipping.tsがShippingRate
 * を取得してこの純粋関数へ渡す)。
 *
 * 重要な設計判断(コードへ理由を残す): このファイルは`plannedPrice`
 * (Inventory.plannedSalePrice)そのものを一切書き換えない——常に
 * 「参考総額 = plannedPrice + medianShipping」という派生値を返すだけ。
 */

export const REPRESENTATIVE_REGIONS: { label: string; prefecture: string }[] = [
  { label: "東京", prefecture: "東京都" },
  // 「名古屋圏」「大阪圏」はShippingRateマスタ上の正式な地域区分
  // (destinationArea)が現状常にnull(§66調査で未確認)のため、都道府県
  // 単位の代表値へ落とす——都市圏の構成県を独自に定義・推測しない
  // という指示(§31.3「都道府県/地域区分を勝手に推測せず」)に従い、
  // 各都市圏の中心となる1県のみを代表とする(名古屋圏→愛知県、
  // 大阪圏→大阪府)。将来destinationAreaが実際の地域区分で埋まれば、
  // そちらを優先する設計に変更できる。
  { label: "名古屋圏", prefecture: "愛知県" },
  { label: "大阪圏", prefecture: "大阪府" },
];

/**
 * 中央値算出に「全国相当」を名乗るために最低限必要な、異なる都道府県の
 * 検証済み料金件数。指示書§31.5「少数データだけから全国中央値を装って
 * はならない」を具体的な閾値として実装したもの——3という数値は実際の
 * 家財おまかせ便全国料金表の完成度に関する事実情報が無いため、
 * 「1〜2地域だけでは明らかに不十分」という常識的な最低ラインとして
 * 選んだ判断であり、公式資料等の裏付けがある数値ではない(コメントで
 * 明記——完了報告にも根拠が推測ではなく判断であることを記載する)。
 */
export const MIN_DISTINCT_REGIONS_FOR_MEDIAN = 3;

/** 追加表示の対象とする、中央値との差額のしきい値(円)。指示書§31.3で明示された固定値。 */
export const REGION_DIFFERENCE_THRESHOLD_YEN = 2000;

export function calculateMedian(sortedAscValues: number[]): number {
  const n = sortedAscValues.length;
  if (n === 0) throw new Error("calculateMedian: empty array");
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sortedAscValues[mid];
  return Math.round((sortedAscValues[mid - 1] + sortedAscValues[mid]) / 2);
}

/** 同一destinationPrefectureに複数バージョンの料金がある場合、最新(effectiveFrom降順→version降順)の1件だけを採用する。 */
export function pickLatestPerPrefecture(rates: ShippingRateRecord[]): ShippingRateRecord[] {
  const byPrefecture = new Map<string, ShippingRateRecord>();
  for (const rate of rates) {
    const existing = byPrefecture.get(rate.destinationPrefecture);
    if (!existing) {
      byPrefecture.set(rate.destinationPrefecture, rate);
      continue;
    }
    const existingKey = `${existing.effectiveFrom ?? ""}|${existing.version}`;
    const candidateKey = `${rate.effectiveFrom ?? ""}|${rate.version}`;
    if (candidateKey > existingKey) byPrefecture.set(rate.destinationPrefecture, rate);
  }
  return Array.from(byPrefecture.values());
}

export interface RegionPriceRow {
  label: string;
  prefecture: string;
  price: number;
  total: number;
  diffFromMedian: number;
}

/** 第六ラウンド§9/§84: サービス対象外(price=null)の代表地域は「配送不可/要確認」として区別する——0円扱いにしない。 */
export type RepresentativeRegionRow = RegionPriceRow | { label: string; prefecture: string; status: "NO_DATA" } | { label: string; prefecture: string; status: "UNAVAILABLE" };

export type ShippingReferencePriceView =
  | {
      status: "INSUFFICIENT_DATA";
      /** 何件・何地域の検証済み料金が現時点であるか(UIの「送料データ不足」表示に添えるための実数)。 */
      availableRegionCount: number;
      requiredRegionCount: number;
    }
  | {
      status: "OK";
      plannedPrice: number;
      rank: ShippingRank;
      medianShipping: number;
      referenceTotal: number;
      /** §31.3: 東京・名古屋圏・大阪圏(データが無い/サービス対象外の代表地域は別途区別して返す)。 */
      representativeRegions: RepresentativeRegionRow[];
      /** §31.3: 代表地域以外で、中央値との差額が2,000円以上の地域(価格帯でグルーピング済み)。 */
      notableDifferenceRegions: RegionPriceRow[];
    };

/**
 * §31.1の計算本体。`verifiedRates`は呼び出し元(app/actions/shipping.ts)
 * が「対象rank・重複排除済み(pickLatestPerPrefecture)・verifiedAtが
 * 設定されている」ものだけに絞り込んで渡す前提——ここでは追加の
 * フィルタリングはしない(責務の分離: どのデータを「検証済み」と
 * 見なすかはservice層の判断、中央値計算そのものはこの純粋関数の責務)。
 *
 * 第六ラウンド§9/§84: status="UNAVAILABLE"(price=null、サービス対象外
 * と公式が明示したルート)の行は中央値の母集団(distinctPrefectures/
 * 中央値算出)には含めない——「データが無い」のではなく「価格という
 * 概念自体が存在しない」ため、0円として紛れ込ませない。ただし代表地域
 * (東京/名古屋圏/大阪圏)がUNAVAILABLEの場合は、それを利用者へ明示する
 * 意味があるため`representativeRegions`には残す。
 */
export function buildShippingReferencePriceView(input: {
  plannedPrice: number;
  rank: ShippingRank;
  verifiedRates: ShippingRateRecord[];
}): ShippingReferencePriceView {
  const pricedRates = input.verifiedRates.filter((r): r is ShippingRateRecord & { price: number } => r.price != null);
  const unavailableByPrefecture = new Map(input.verifiedRates.filter((r) => r.price == null).map((r) => [r.destinationPrefecture, r] as const));

  const distinctPrefectures = new Set(pricedRates.map((r) => r.destinationPrefecture));
  if (distinctPrefectures.size < MIN_DISTINCT_REGIONS_FOR_MEDIAN) {
    return { status: "INSUFFICIENT_DATA", availableRegionCount: distinctPrefectures.size, requiredRegionCount: MIN_DISTINCT_REGIONS_FOR_MEDIAN };
  }

  const prices = pricedRates.map((r) => r.price).sort((a, b) => a - b);
  const medianShipping = calculateMedian(prices);
  const referenceTotal = input.plannedPrice + medianShipping;

  const byPrefecture = new Map(pricedRates.map((r) => [r.destinationPrefecture, r] as const));

  const toRow = (label: string, prefecture: string): RepresentativeRegionRow => {
    const rate = byPrefecture.get(prefecture);
    if (rate) return { label, prefecture, price: rate.price, total: input.plannedPrice + rate.price, diffFromMedian: rate.price - medianShipping };
    if (unavailableByPrefecture.has(prefecture)) return { label, prefecture, status: "UNAVAILABLE" };
    return { label, prefecture, status: "NO_DATA" };
  };

  const representativeRegions = REPRESENTATIVE_REGIONS.map((r) => toRow(r.label, r.prefecture));
  const representativePrefectures = new Set(REPRESENTATIVE_REGIONS.map((r) => r.prefecture));

  // §31.3: 代表地域以外で差額が閾値以上のものだけ追加表示。同一価格の
  // 地域は「料金帯」としてラベルをまとめる(指示書「同一料金帯の地域を
  // 大量に羅列せず…まとめる」)。
  const others = pricedRates.filter((r) => !representativePrefectures.has(r.destinationPrefecture) && Math.abs(r.price - medianShipping) >= REGION_DIFFERENCE_THRESHOLD_YEN);
  const groupedByPrice = new Map<number, string[]>();
  for (const r of others) {
    const list = groupedByPrice.get(r.price) ?? [];
    list.push(r.destinationPrefecture);
    groupedByPrice.set(r.price, list);
  }
  const notableDifferenceRegions: RegionPriceRow[] = Array.from(groupedByPrice.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([price, prefectures]) => ({
      label: prefectures.length > 1 ? `${prefectures[0]}他${prefectures.length - 1}地域` : prefectures[0],
      prefecture: prefectures.join("、"),
      price,
      total: input.plannedPrice + price,
      diffFromMedian: price - medianShipping,
    }));

  return { status: "OK", plannedPrice: input.plannedPrice, rank: input.rank, medianShipping, referenceTotal, representativeRegions, notableDifferenceRegions };
}
