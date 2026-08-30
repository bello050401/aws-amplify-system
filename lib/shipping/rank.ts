/**
 * BELLO統合業務OS指示書(2026-08-30) §61-63: 家財おまかせ便(アート
 * セッティングデリバリー)の配送ランク判定 — 純粋なロジックのみ
 * (lib/inventory/sales.ts / lib/listing/pricing.tsと同じ方針: AWS/
 * Amplifyへ一切触れない)。
 *
 * §63: ランクは幅+奥行+高さ(3辺合計、cm)の合計値で決まる、9段階
 * (SS〜G) + それを超える場合は「規格外候補」(このサイズは家財おまか
 * せ便の通常ランク表の範囲外で、個別見積りが必要 — 実際に運送可能かは
 * 別途要問い合わせ、という意味。運送不可を確定させるものではない)。
 * 各上限値は指示書§63で指定された値をそのまま使用しており、2026年
 * WebSearch調査(§66)で見つかった実例(埼玉→東京、3辺合計200cm以内=
 * Bランク、250cm以内=Cランク)とも整合する
 * (lib/shipping/ratesSeed.tsのコメント参照)。
 */

export type ShippingRank = "SS" | "S" | "A" | "B" | "C" | "D" | "E" | "F" | "G" | "OVERSIZE";

export const SHIPPING_RANKS: ShippingRank[] = ["SS", "S", "A", "B", "C", "D", "E", "F", "G", "OVERSIZE"];

/** 各ランクの3辺合計(cm)上限。OVERSIZEには上限が無い(このランク表の対象外という意味)。 */
const RANK_MAX_SUM_CM: { rank: Exclude<ShippingRank, "OVERSIZE">; maxSumCm: number }[] = [
  { rank: "SS", maxSumCm: 80 },
  { rank: "S", maxSumCm: 120 },
  { rank: "A", maxSumCm: 160 },
  { rank: "B", maxSumCm: 200 },
  { rank: "C", maxSumCm: 250 },
  { rank: "D", maxSumCm: 300 },
  { rank: "E", maxSumCm: 350 },
  { rank: "F", maxSumCm: 400 },
  { rank: "G", maxSumCm: 450 },
];

/** UI表示用ラベル(3辺合計の目安をカッコ内に添える)。 */
export const SHIPPING_RANK_LABEL: Record<ShippingRank, string> = {
  SS: "SS（〜80cm）",
  S: "S（〜120cm）",
  A: "A（〜160cm）",
  B: "B（〜200cm）",
  C: "C（〜250cm）",
  D: "D（〜300cm）",
  E: "E（〜350cm）",
  F: "F（〜400cm、地域限定・要事前確認）",
  G: "G（〜450cm、地域限定・要事前確認）",
  OVERSIZE: "規格外候補（451cm〜、個別見積り要問い合わせ）",
};

/**
 * §63: 3辺合計(cm)からランクを判定する。合計が負・0以下・非有限の
 * 場合はエラーを投げる(呼び出し元がInventoryの寸法から合計を作る時点
 * で既に「不明」をnullとして扱っているはずなので、ここに来る値は常に
 * 正の実数という契約 — 契約違反を静かに無視しない)。
 */
export function calculateShippingRankFromSum(sumCm: number): ShippingRank {
  if (!Number.isFinite(sumCm) || sumCm <= 0) {
    throw new Error(`calculateShippingRankFromSum: 3辺合計は正の数値である必要があります（受け取った値: ${sumCm}）`);
  }
  for (const { rank, maxSumCm } of RANK_MAX_SUM_CM) {
    if (sumCm <= maxSumCm) return rank;
  }
  return "OVERSIZE";
}

/**
 * Inventory.width/depth/height(自由入力の文字列、例: "50"や"50cm"、
 * 全角数字混在の可能性もある)から数値(cm)を抜き出す。数値が見つから
 * ない・0以下の場合はnull(「不明」として扱う — 呼び出し元は3辺すべて
 * 揃わない限りランク計算をしない)。
 */
export function parseDimensionCm(raw: string | null | undefined): number | null {
  if (!raw) return null;
  // 全角数字・全角ドットを半角へ寄せてから数値部分を抜き出す。
  const normalized = raw.replace(/[０-９．]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  const match = normalized.match(/[\d.]+/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface DimensionRankResult {
  widthCm: number;
  depthCm: number;
  heightCm: number;
  sumCm: number;
  rank: ShippingRank;
}

/**
 * 幅/奥行/高さの自由入力文字列からランクを判定する。3つすべてが数値
 * として読み取れない場合はnull(「サイズ情報が不足しているためランク
 * 判定できません」という意味 — 呼び出し元がその旨をUIに表示する)。
 */
export function calculateShippingRankFromDimensions(
  width: string | null | undefined,
  depth: string | null | undefined,
  height: string | null | undefined,
): DimensionRankResult | null {
  const widthCm = parseDimensionCm(width);
  const depthCm = parseDimensionCm(depth);
  const heightCm = parseDimensionCm(height);
  if (widthCm == null || depthCm == null || heightCm == null) return null;
  const sumCm = widthCm + depthCm + heightCm;
  return { widthCm, depthCm, heightCm, sumCm, rank: calculateShippingRankFromSum(sumCm) };
}
