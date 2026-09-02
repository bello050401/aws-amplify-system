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
 * 寸法文字列の中に現れる「数値1つ」と、その直前に書かれていたラベル。
 *
 * BELLOのInventory.width/depth/heightは自由入力の文字列で、実データには
 * 1つの欄に複数の寸法が書かれていることが普通にある(Staging実測):
 *
 *     width  = "座面直径34"
 *     depth  = "脚幅44"
 *     height = "75 フットレスト高さ25.5"
 *
 * 「最初に見つかった数値」を取ると、"75 フットレスト高さ25.5" はたまたま
 * 正しい75になるが、"座面奥行き43座面高さ44" のような値では**座面寸法**を
 * 送料判定に使ってしまう。指示書が明示的に禁止している判定
 * (W + D + SH / SH + AH + D 等)は、まさにこの読み方から生まれる。
 */
export interface DimensionToken {
  /** その数値の直前に書かれていた説明(無ければ空文字)。 */
  label: string;
  valueCm: number;
}

/**
 * 送料判定に使ってはいけない寸法のラベル(指示書§8/§10)。
 *
 * SH(座面高) / AH(肘高) / 座面幅・座面奥行・座面直径などの座面寸法は、
 * 家具を収める外枠の3辺ではない。数字が3つあるからといって選ぶ実装を
 * 禁止する、という要件をコード側で保証するのがこの表。
 *
 * 「3辺合計」も除外する —— それは辺ではなく既に合計された値で、
 * 1辺として足すと二重計上になる。
 */
const NON_OUTER_DIMENSION_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /座面|座高|シート高|seat/i, reason: "座面寸法は送料判定に使いません" },
  { pattern: /(?<![a-z])sh(?![a-z])/i, reason: "SH(座面高)は送料判定に使いません" },
  { pattern: /(?<![a-z])ah(?![a-z])/i, reason: "AH(肘高)は送料判定に使いません" },
  { pattern: /肘|ひじ|アーム|arm/i, reason: "肘掛の寸法は送料判定に使いません" },
  { pattern: /内寸|内径/, reason: "内寸は外形ではありません" },
  { pattern: /[3３三]辺|合計/, reason: "3辺合計は1辺ではありません" },
];

/**
 * 寸法文字列を「ラベル付きの数値」の並びへ分解する。
 *
 * 全角数字・全角ドットは半角へ寄せる。ラベルは「直前の数値の終わりから
 * この数値の始まりまで」の文字列で、先頭の数値なら文字列の先頭から。
 */
export function tokenizeDimension(raw: string | null | undefined): DimensionToken[] {
  if (!raw) return [];
  const normalized = raw.replace(/[０-９．]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  const tokens: DimensionToken[] = [];
  let cursor = 0;
  for (const m of normalized.matchAll(/\d+(?:\.\d+)?/g)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    // 直後が助数詞なら、それは寸法ではなく個数。"3辺合計224" の先頭の
    // 3 を 3cm の寸法として拾ってしまうのを防ぐ。
    if (/^[辺個点台脚枚人段箇口組]/.test(normalized.slice(end))) {
      cursor = end;
      continue;
    }
    tokens.push({ label: normalized.slice(cursor, start).trim(), valueCm: Number(m[0]) });
    cursor = end;
  }
  return tokens.filter((t) => Number.isFinite(t.valueCm) && t.valueCm > 0);
}

export interface OuterDimensionResult {
  /** 送料判定に使える最大外形値(cm)。使える候補が1つも無ければnull。 */
  valueCm: number | null;
  /** 採用した候補のラベル(表示用。ラベル無しの素の数値なら空文字)。 */
  usedLabel: string | null;
  /** 送料判定から除外した候補と、その理由(管理者へ提示する)。 */
  excluded: { label: string; valueCm: number; reason: string }[];
  /** 元の入力(表示用)。 */
  raw: string | null;
}

/**
 * 1つの軸(幅/奥行/高さ)の文字列から、**送料判定に使う最大外形値**を決める。
 *
 * 手順:
 *   1. ラベル付きの数値へ分解する
 *   2. 座面/SH/AH/肘/内寸/3辺合計のラベルが付いた候補を除外する
 *   3. 残った候補の**最大値**を採る(指示書§11「最も張り出した幅・奥行・
 *      最も高い位置」)
 *
 * すべて除外された場合はnullを返す。ここで「仕方ないので座面寸法を使う」
 * ことは絶対にしない —— 小さく見積もった送料ランクは、実際の請求と
 * 食い違って損失になる。判定できないことを返し、人に外形寸法を入れて
 * もらう(指示書§12「不明なら人間確認」)。
 */
export function resolveOuterDimensionCm(raw: string | null | undefined): OuterDimensionResult {
  const tokens = tokenizeDimension(raw);
  const excluded: { label: string; valueCm: number; reason: string }[] = [];
  const usable: DimensionToken[] = [];

  for (const token of tokens) {
    const hit = NON_OUTER_DIMENSION_PATTERNS.find((p) => p.pattern.test(token.label));
    if (hit) excluded.push({ label: token.label, valueCm: token.valueCm, reason: hit.reason });
    else usable.push(token);
  }

  if (usable.length === 0) {
    return { valueCm: null, usedLabel: null, excluded, raw: raw ?? null };
  }
  const best = usable.reduce((a, b) => (b.valueCm > a.valueCm ? b : a));
  return { valueCm: best.valueCm, usedLabel: best.label, excluded, raw: raw ?? null };
}

/**
 * 後方互換の薄いラッパー。既存の呼び出し(と既存テスト)がそのまま動く
 * ように残すが、中身は最大外形の解決へ委譲する —— 「最初の数値」を
 * 返す旧実装をどこかに残しておくと、いつか誰かがそちらを使ってしまう。
 */
export function parseDimensionCm(raw: string | null | undefined): number | null {
  return resolveOuterDimensionCm(raw).valueCm;
}

/** 送料判定に使った1軸ぶんの根拠(「送料込み参考価格」カードに表示する)。 */
export interface AxisEvidence {
  axis: "width" | "depth" | "height";
  label: string;
  raw: string | null;
  valueCm: number | null;
  usedLabel: string | null;
  excluded: { label: string; valueCm: number; reason: string }[];
}

export interface DimensionRankResult {
  widthCm: number;
  depthCm: number;
  heightCm: number;
  sumCm: number;
  rank: ShippingRank;
  /** どの寸法をどう読んで判定したか。指示書§13の「計測根拠」表示用。 */
  axes: AxisEvidence[];
}

export interface DimensionRankFailure {
  /** 判定できなかった軸。 */
  missingAxes: AxisEvidence[];
  /** 読めた軸も含めた全軸の根拠(UIで「幅だけ足りない」と示せるように)。 */
  axes: AxisEvidence[];
}

const AXIS_LABEL = { width: "幅", depth: "奥行", height: "高さ" } as const;

function buildAxes(
  width: string | null | undefined,
  depth: string | null | undefined,
  height: string | null | undefined,
): AxisEvidence[] {
  return (["width", "depth", "height"] as const).map((axis) => {
    const raw = axis === "width" ? width : axis === "depth" ? depth : height;
    const r = resolveOuterDimensionCm(raw);
    return { axis, label: AXIS_LABEL[axis], raw: r.raw, valueCm: r.valueCm, usedLabel: r.usedLabel, excluded: r.excluded };
  });
}

/**
 * 幅/奥行/高さの自由入力文字列から、**最大外形3辺**でランクを判定する。
 *
 * A = 最大幅 / B = 最大奥行 / C = 最大高さ、A + B + C が荷物サイズ
 * (指示書§9)。SH・AH・座面寸法は resolveOuterDimensionCm が除外済み。
 *
 * 3軸のいずれかが決められない場合はnull(呼び出し元がその旨を表示する)。
 * 詳しい理由が要る場合は calculateShippingRankFromDimensionsDetailed を使う。
 */
export function calculateShippingRankFromDimensions(
  width: string | null | undefined,
  depth: string | null | undefined,
  height: string | null | undefined,
): DimensionRankResult | null {
  const result = calculateShippingRankFromDimensionsDetailed(width, depth, height);
  return "rank" in result ? result : null;
}

export function calculateShippingRankFromDimensionsDetailed(
  width: string | null | undefined,
  depth: string | null | undefined,
  height: string | null | undefined,
): DimensionRankResult | DimensionRankFailure {
  const axes = buildAxes(width, depth, height);
  const missingAxes = axes.filter((a) => a.valueCm == null);
  if (missingAxes.length > 0) return { missingAxes, axes };

  const [w, d, h] = axes.map((a) => a.valueCm!);
  const sumCm = w + d + h;
  return { widthCm: w, depthCm: d, heightCm: h, sumCm, rank: calculateShippingRankFromSum(sumCm), axes };
}
