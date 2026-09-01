/**
 * BELLO Style Profile —— 過去のBASE商品説明文を全体分析した結果を、
 * 構造化して持つ。
 *
 * ## 既存の styleGuide.ts との違い(二重実装ではない)
 *
 * `styleGuide.ts` は「文体の例文を選んでプロンプトへ差し込む」ための
 * 仕組みで、これからも生成時に使う。こちらが担うのは、**例文からは
 * 読み取れない構造的なルール** ——どの見出しをどの順で使うか、寸法を
 * どこへ置くか、何を書いてはいけないか——を、実測した頻度とともに
 * 明示的に持つこと。前者が「お手本」、後者が「型」にあたる。
 *
 * ## 数値はすべて実測から入る
 *
 * このファイルは規則をハードコードしない。`buildStyleProfile()` に
 * 過去商品を渡すと、そこから頻度を数えて規則を組み立てる。だから
 * 商品が増えれば規則も変わるし、「なぜこの規則なのか」は必ず
 * `observedCount` / `sampleSize` に戻って説明できる。
 *
 * 参考として、2026-09-02 にStagingの実データ267件で得られた値:
 *   - 「◎商品のご紹介」を使う          255/267 (96%)
 *   - 「コンディション」を使う          266/267 (100%)
 *   - 「発送について」を使う            254/267 (95%)
 *   - 紹介文の長さ                     中央値 531字(176〜932)
 *   - 紹介文の段落数                   中央値 6(4〜10)
 *   - 「〜のご紹介です。」を含む        242/267 (91%)
 *   - 感嘆符「！」を使う                 0/267 (0%)
 *   - 「★」「☆」「♪」を使う              0/267 (0%)
 */

import { splitBaseDescription, type BaseSectionKind } from "@/lib/base/archive/sections";
import { extractProductIntro } from "./extract";

export const STYLE_PROFILE_SCHEMA_VERSION = "bello-style-profile-v1";

/** 分析にかける1件ぶんの入力。BASEの生データでも、アーカイブ行でも同じ形にできる。 */
export interface StyleProfileSourceItem {
  baseItemId: string;
  title: string;
  description: string;
  /** BASE側の最終更新(ISO)。分析対象期間の算出に使う。 */
  modifiedAt?: string | null;
  price?: number | null;
}

/** ひとつの観測事実。規則ではなく「何件中何件そうだったか」。 */
export interface Observation<T = string> {
  value: T;
  observedCount: number;
  /** 母数に対する割合(0〜1)。 */
  ratio: number;
}

export interface NumericStat {
  min: number;
  median: number;
  max: number;
  /** 生成時に狙う範囲(中央値の前後、実測の四分位に近い幅)。 */
  targetMin: number;
  targetMax: number;
}

export interface SectionRule {
  kind: BaseSectionKind;
  heading: string;
  observedCount: number;
  ratio: number;
  /** 説明文中の平均的な出現順。小さいほど前。 */
  averageOrder: number;
  /** この割合を超えて使われているセクションは、生成時にも必ず入れる。 */
  required: boolean;
}

export interface BelloStyleProfile {
  schemaVersion: string;
  generatedAt: string;
  analyzedItemCount: number;
  /** 紹介文を抽出できた件数。analyzedItemCount との差が分析の取りこぼし。 */
  introExtractedCount: number;
  analysisPeriod: { start: string | null; end: string | null };
  /** サンプル数から機械的に導く確からしさ(0〜1)。件数が少なければ低くなる。 */
  confidence: number;

  /** どの見出しを、どの順で使うか。 */
  sectionRules: SectionRule[];
  /** 生成時に推奨するセクションの並び(averageOrder順)。 */
  recommendedSectionOrder: BaseSectionKind[];

  introRules: {
    length: NumericStat;
    paragraphs: NumericStat;
    sentences: NumericStat;
    /** 「〜のご紹介です。」のような、紹介文を締める/始める定型。 */
    commonOpeningForms: Observation[];
    commonClosingForms: Observation[];
  };

  /**
   * 寸法をどのセクションへ置くか。実測では「商品のご紹介」の出現順が
   * 0.0、寸法を含む「商品詳細」が1.3 —— 紹介文には寸法を書かない、
   * というのがBELLO自身の書き方。
   */
  sizePlacementRules: {
    /** 寸法が現れたセクション種別の内訳。 */
    placement: Observation<BaseSectionKind>[];
    /** 紹介文の中に寸法表記が現れた割合。低いほど「紹介文に寸法を書かない」が強い規則。 */
    dimensionInIntroRatio: number;
  };

  brandRules: {
    /** 「英字ブランド名（カタカナ読み）」という書式が使われた割合。 */
    latinWithKanaReadingRatio: number;
    /** 紹介文の冒頭がブランド名で始まる割合。 */
    startsWithBrandRatio: number;
    topBrands: Observation[];
  };

  toneRules: {
    /** ですます調の文の割合。 */
    politeSentenceRatio: number;
    /** 使われていない(=避けるべき)記号。実測で0件だったもの。 */
    unusedSymbols: string[];
    /** 実際に使われている記号とその頻度。 */
    usedSymbols: Observation[];
  };

  /** 実測で頻出する言い回し。生成時の語彙の手がかり。 */
  preferredPhrases: Observation[];
  /**
   * 書いてはいけない表現。実測で0件だったものと、既存の
   * factSafety/styleGuide が既に禁じているものを合わせる。
   */
  prohibitedPhrases: string[];

  /** カテゴリ(商品名から機械的に導いた語)ごとの件数。偏りの確認用。 */
  categoryDistribution: Observation[];
  priceBands: Observation[];
}

// ── 以下、分析の実装 ────────────────────────────────────────────────

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.floor(sorted.length / 2)];
}

function stat(values: number[]): NumericStat {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return { min: 0, median: 0, max: 0, targetMin: 0, targetMax: 0 };
  const q1 = s[Math.floor(s.length * 0.25)];
  const q3 = s[Math.floor(s.length * 0.75)];
  return { min: s[0], median: median(s), max: s[s.length - 1], targetMin: q1, targetMax: q3 };
}

function toObservations(counts: Map<string, number>, total: number, limit: number): Observation[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, observedCount]) => ({ value, observedCount, ratio: total ? observedCount / total : 0 }));
}

/** 寸法らしい表記。「W120」「幅120cm」「120×60」など、実際の書式に合わせる。 */
const DIMENSION_PATTERN = /(?:[WDHwdh]\s*[:：]?\s*\d|[幅奥行高][さきみ]?\s*[:：]?\s*\d|\d+\s*[×x]\s*\d+|\d+\s*(?:cm|mm|センチ))/;

/** 英字ブランド名 + （カタカナ読み） の書式。実測の冒頭で最も多かった形。 */
const LATIN_WITH_KANA = /[A-Za-z][A-Za-z0-9&.'\- ]{1,30}\s*[（(][ァ-ヶー・\s]{2,20}[）)]/;

/** 冒頭のブランド名候補(英字の連なり)。 */
const LEADING_LATIN = /^[\s　]*([A-Za-z][A-Za-z0-9&.'\- ]{1,30})/;

/**
 * 実測で1件も使われていなかった記号は、BELLOの文体では使わないという
 * こと。生成側の禁止リストへそのまま渡せるよう、ここで確定させる。
 */
const CANDIDATE_SYMBOLS = ["！", "!", "★", "☆", "♪", "♡", "→", "●", "■", "※", "・", "◎"];

export function buildStyleProfile(items: StyleProfileSourceItem[], now: Date = new Date()): BelloStyleProfile {
  const total = items.length;

  const sectionCount = new Map<BaseSectionKind, number>();
  const sectionHeadings = new Map<BaseSectionKind, Map<string, number>>();
  const sectionOrders = new Map<BaseSectionKind, number[]>();
  const dimensionPlacement = new Map<string, number>();

  const introLengths: number[] = [];
  const introParagraphs: number[] = [];
  const introSentences: number[] = [];
  const openingForms = new Map<string, number>();
  const closingForms = new Map<string, number>();
  const phrases = new Map<string, number>();
  const brands = new Map<string, number>();
  const symbolCounts = new Map<string, number>();
  const categories = new Map<string, number>();
  const priceBands = new Map<string, number>();

  let introExtracted = 0;
  let dimensionInIntro = 0;
  let latinWithKana = 0;
  let startsWithBrand = 0;
  let politeSentences = 0;
  let totalSentences = 0;

  const timestamps: number[] = [];

  for (const item of items) {
    if (item.modifiedAt) {
      const t = Date.parse(item.modifiedAt);
      if (!Number.isNaN(t)) timestamps.push(t);
    }

    // ── セクション構造 ──
    const sections = splitBaseDescription(item.description);
    const seen = new Set<BaseSectionKind>();
    for (const s of sections) {
      if (!seen.has(s.kind)) {
        seen.add(s.kind);
        sectionCount.set(s.kind, (sectionCount.get(s.kind) ?? 0) + 1);
        if (!sectionOrders.has(s.kind)) sectionOrders.set(s.kind, []);
        sectionOrders.get(s.kind)!.push(s.order);
        if (!sectionHeadings.has(s.kind)) sectionHeadings.set(s.kind, new Map());
        const hm = sectionHeadings.get(s.kind)!;
        hm.set(s.heading, (hm.get(s.heading) ?? 0) + 1);
      }
      if (DIMENSION_PATTERN.test(s.body)) {
        dimensionPlacement.set(s.kind, (dimensionPlacement.get(s.kind) ?? 0) + 1);
      }
    }

    // ── 紹介文 ──
    const intro = extractProductIntro(item.description);
    if (intro.ok) {
      introExtracted++;
      const text = intro.intro;
      introLengths.push(text.length);
      introParagraphs.push(text.split(/\n{2,}/).filter((p) => p.trim()).length);

      const sentences = text.split(/(?<=[。！？])/).map((s) => s.trim()).filter(Boolean);
      introSentences.push(sentences.length);
      totalSentences += sentences.length;
      for (const s of sentences) {
        if (/(?:です|ます)[。！？]?$/.test(s)) politeSentences++;
      }

      if (DIMENSION_PATTERN.test(text)) dimensionInIntro++;
      if (LATIN_WITH_KANA.test(text)) latinWithKana++;

      const lead = LEADING_LATIN.exec(text);
      if (lead) {
        startsWithBrand++;
        const brand = lead[1].trim();
        if (brand.length >= 2) brands.set(brand, (brands.get(brand) ?? 0) + 1);
      }

      // 冒頭・文末の定型
      const firstSentence = sentences[0];
      if (firstSentence) {
        const head = firstSentence.slice(0, 14).trim();
        if (head) openingForms.set(head, (openingForms.get(head) ?? 0) + 1);
      }
      for (const s of sentences) {
        const m = /([ぁ-んァ-ヶ一-龥ー]{3,9}[。])$/.exec(s);
        if (m) closingForms.set(m[1], (closingForms.get(m[1]) ?? 0) + 1);
      }

      // 頻出フレーズ(かな漢字の連なりのみ。固有名詞を拾わないため英数を除く)
      const compact = text.replace(/\s+/g, "");
      for (let n = 6; n <= 10; n++) {
        for (let i = 0; i + n <= compact.length; i++) {
          const g = compact.slice(i, i + n);
          if (!/^[ぁ-んァ-ヶ一-龥ー、。]+$/.test(g)) continue;
          phrases.set(g, (phrases.get(g) ?? 0) + 1);
        }
      }

      for (const sym of CANDIDATE_SYMBOLS) {
        if (text.includes(sym)) symbolCounts.set(sym, (symbolCounts.get(sym) ?? 0) + 1);
      }
    }

    // ── カテゴリ・価格帯(偏りの確認用) ──
    const category = inferCategory(item.title);
    if (category) categories.set(category, (categories.get(category) ?? 0) + 1);
    const band = priceBand(item.price ?? null);
    if (band) priceBands.set(band, (priceBands.get(band) ?? 0) + 1);
  }

  // セクション規則
  const sectionRules: SectionRule[] = [...sectionCount.entries()]
    .map(([kind, observedCount]) => {
      const orders = sectionOrders.get(kind) ?? [0];
      const headingMap = sectionHeadings.get(kind) ?? new Map<string, number>();
      const topHeading = [...headingMap.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
      const ratio = total ? observedCount / total : 0;
      return {
        kind,
        heading: topHeading,
        observedCount,
        ratio,
        averageOrder: orders.reduce((a, b) => a + b, 0) / orders.length,
        // 9割以上で使われているものを「必ず入れる」とする。実測では
        // INTRO(96%) / CONDITION(100%) / SHIPPING(95%) がこれに当たる。
        required: ratio >= 0.9,
      };
    })
    .filter((r) => r.kind !== "OTHER")
    .sort((a, b) => a.averageOrder - b.averageOrder);

  const dimensionTotal = [...dimensionPlacement.values()].reduce((a, b) => a + b, 0);

  // 実測で1件も現れなかった記号 = BELLOの文体では使わない記号
  const unusedSymbols = CANDIDATE_SYMBOLS.filter((s) => !symbolCounts.has(s));

  const timeSorted = timestamps.sort((a, b) => a - b);

  return {
    schemaVersion: STYLE_PROFILE_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    analyzedItemCount: total,
    introExtractedCount: introExtracted,
    analysisPeriod: {
      start: timeSorted.length ? new Date(timeSorted[0]).toISOString() : null,
      end: timeSorted.length ? new Date(timeSorted[timeSorted.length - 1]).toISOString() : null,
    },
    confidence: computeConfidence(total, introExtracted),
    sectionRules,
    recommendedSectionOrder: sectionRules.map((r) => r.kind),
    introRules: {
      length: stat(introLengths),
      paragraphs: stat(introParagraphs),
      sentences: stat(introSentences),
      commonOpeningForms: toObservations(openingForms, introExtracted, 10),
      commonClosingForms: toObservations(closingForms, introExtracted, 12),
    },
    sizePlacementRules: {
      placement: toObservations(dimensionPlacement, dimensionTotal, 8) as Observation<BaseSectionKind>[],
      dimensionInIntroRatio: introExtracted ? dimensionInIntro / introExtracted : 0,
    },
    brandRules: {
      latinWithKanaReadingRatio: introExtracted ? latinWithKana / introExtracted : 0,
      startsWithBrandRatio: introExtracted ? startsWithBrand / introExtracted : 0,
      topBrands: toObservations(brands, introExtracted, 20),
    },
    toneRules: {
      politeSentenceRatio: totalSentences ? politeSentences / totalSentences : 0,
      unusedSymbols,
      usedSymbols: toObservations(symbolCounts, introExtracted, 12),
    },
    // 短いほど一般的な語になりがちなので、長いものを優先して残す。
    preferredPhrases: toObservations(phrases, introExtracted, 200)
      .filter((p) => p.observedCount >= Math.max(3, Math.floor(introExtracted * 0.05)))
      .sort((a, b) => b.value.length - a.value.length || b.observedCount - a.observedCount)
      .slice(0, 25),
    prohibitedPhrases: buildProhibitedPhrases(unusedSymbols),
    categoryDistribution: toObservations(categories, total, 20),
    priceBands: toObservations(priceBands, total, 10),
  };
}

/**
 * サンプル数からの確からしさ。件数が増えるほど1に近づき、
 * 抽出できなかったぶんは割り引く。恣意的な重みを避けるため、
 * 「200件で頭打ち」という1点だけを決めて残りは比例させる。
 */
function computeConfidence(total: number, extracted: number): number {
  if (total === 0) return 0;
  const sampleScore = Math.min(1, total / 200);
  const extractionScore = extracted / total;
  return Number((sampleScore * extractionScore).toFixed(3));
}

/**
 * 禁止表現。実測で0件だった記号に加え、既存の styleGuide.ts /
 * factSafety.ts が既に禁じている「確認できない事実を書く」系を
 * 文言として明示する(判定そのものは factSafety が行う)。
 */
function buildProhibitedPhrases(unusedSymbols: string[]): string[] {
  return [
    ...unusedSymbols.map((s) => `記号「${s}」を使う(過去の商品説明で1件も使われていない)`),
    "確認できない製造年・デザイナー・素材・製造国を書く",
    "在庫数・残り点数に言及する",
    "コンディションを独自の数値・ランクで言い換える",
    "「〜と言えるでしょう」「〜ではないでしょうか」のような曖昧な締め",
    "商品名に無いブランドを関連ブランドとして列挙する",
    "紹介文の冒頭で W/D/H などの寸法を並べる",
  ];
}

/** 商品名から機械的にカテゴリ語を拾う。推測した事実ではなく、集計のための粗い分類。 */
const CATEGORY_WORDS = [
  "チェア", "ソファ", "テーブル", "デスク", "シェルフ", "キャビネット", "ベッド",
  "照明", "ランプ", "ミラー", "スツール", "ラグ", "収納", "ハンガー", "ワゴン",
];

export function inferCategory(title: string): string | null {
  for (const w of CATEGORY_WORDS) {
    if (title.includes(w)) return w;
  }
  return null;
}

function priceBand(price: number | null): string | null {
  if (price === null || !Number.isFinite(price) || price <= 0) return null;
  if (price < 20000) return "〜2万円";
  if (price < 50000) return "2〜5万円";
  if (price < 100000) return "5〜10万円";
  if (price < 200000) return "10〜20万円";
  return "20万円〜";
}
