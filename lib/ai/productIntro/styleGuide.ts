import { extractProductIntro } from "./extract";

/**
 * 過去のBELLO商品説明から「書き方」を取り出し、
 * 新しい商品の紹介文生成に使う few-shot 例を選ぶ層
 * (夜間統合指示書 2026-09-01 §4.5 / §4.6)。
 *
 * ## 最重要の前提: これは「書き方」の資料であって「事実」ではない
 *
 * §4.7が最重要品質要件として名指ししている事故は、過去商品の事実
 * (デザイナー・製造年・素材・寸法・関連ブランド)が新商品の説明へ
 * 紛れ込むこと。実際に報告された
 * 「関連ブランドにはムートやHAYがあります」がまさにそれで、
 * BoConceptの商品にMuuto/HAYが現れていた。
 *
 * そのためこの層は:
 *
 *   - 過去商品の**文章**だけを扱い、事実を構造化して持ち出さない。
 *   - プロンプトへ載せるときは「文体の参考であって事実の出典ではない」と
 *     明示する(buildStyleExamplesBlock)。
 *   - 生成後は lib/ai/productIntro/factSafety.ts が、事実に無いブランドが
 *     出ていないかを機械的に検査する —— プロンプトの但し書きだけに頼らない。
 *
 * ## 全文をプロンプトへ入れない
 *
 * §4.6「毎回全corpusを送らない」。カテゴリ・商品種別の近さで少数を選び、
 * 文字数にも上限を設ける。1件の過去商品へ引っ張られないよう、
 * 同じ商品の例を重複させず、複数件を混ぜる。
 */

export interface StyleExample {
  /** どの在庫から取った文章か(監査用。顧客には出さない)。 */
  inventoryId: string;
  /** 商品名(類似度の判定に使う)。 */
  name: string;
  /** 抽出済みの紹介文。 */
  intro: string;
}

export interface StyleCorpusStats {
  /** 抽出を試みた件数。 */
  attempted: number;
  /** 紹介文を取り出せた件数。 */
  extracted: number;
  /** 取り出せなかった理由の内訳。 */
  failures: Record<string, number>;
}

export interface StyleGuide {
  /** 生成規則を変えたら上げる。プロンプトの再現性を追えるようにするため。 */
  version: string;
  generatedAt: string;
  stats: StyleCorpusStats;
  /** 紹介文の平均文字数。 */
  averageLength: number;
  /** 紹介文の平均段落数。 */
  averageParagraphs: number;
  /** corpusから観測された、BELLOらしい書き方の特徴。 */
  positivePatterns: string[];
  /** 避けたい書き方。 */
  prohibitedPatterns: string[];
}

export const BELLO_STYLE_GUIDE_VERSION = "bello-intro-style-v1";

/** 在庫1件ぶんの、スタイル抽出への入力。 */
export interface StyleSourceRow {
  id: string;
  name: string;
  /** 商品説明の全文(Inventory.note、または将来的にBASEのdescription)。 */
  description: string | null | undefined;
}

/**
 * 説明文の集合から、紹介文だけを取り出して corpus を作る。
 * 取り出せなかったものは理由付きで数え、**全文で代用しない**
 * (§4.4「抽出不能商品は勝手に全文をstyle corpusへ混ぜない」)。
 */
export function buildStyleCorpus(rows: StyleSourceRow[]): { examples: StyleExample[]; stats: StyleCorpusStats } {
  const examples: StyleExample[] = [];
  const failures: Record<string, number> = {};
  let attempted = 0;

  for (const row of rows) {
    if (!row.description || !row.description.trim()) continue;
    attempted++;
    const result = extractProductIntro(row.description);
    if (result.ok) {
      examples.push({ inventoryId: row.id, name: row.name, intro: result.intro });
    } else {
      failures[result.reason] = (failures[result.reason] ?? 0) + 1;
    }
  }

  return { examples, stats: { attempted, extracted: examples.length, failures } };
}

/** corpusから、versioned な style guide を導出する。再生成可能。 */
export function deriveStyleGuide(examples: StyleExample[], stats: StyleCorpusStats): StyleGuide {
  const lengths = examples.map((e) => e.intro.length);
  const paragraphs = examples.map((e) => e.intro.split(/\n\s*\n/).filter((p) => p.trim()).length);
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : 0);

  return {
    version: BELLO_STYLE_GUIDE_VERSION,
    generatedAt: new Date().toISOString(),
    stats,
    averageLength: avg(lengths),
    averageParagraphs: avg(paragraphs),
    // corpusを読んで確認できた、BELLOの実際の書き方。
    positivePatterns: [
      "商品そのものの説明から入り、次にデザインの特徴、最後に置き場所・使い方の提案へ移る。",
      "「お部屋のアクセントとして最適です」「リビングや玄関、寝室、書斎などのインテリアとして最適です」のように、置かれる場面を具体的に描く。",
      "ですます調で、落ち着いた丁寧さを保つ。過度な感嘆や煽りを使わない。",
      "1段落を2〜4文程度にまとめ、段落間を空ける。",
      "ブランド名・シリーズ名は、商品名として確認できる場合にだけ書く。",
    ],
    prohibitedPatterns: [
      "商品名をそのまま復唱するだけで終わる(「BoConceptのElba Lounge Chairです。」だけ、のような文)。",
      "「関連ブランド」「同系統のブランド」として、商品名に無いブランドを列挙する。",
      "コンディションを数値・段階・ランクで表す。",
      "在庫数・残り点数に言及する。",
      "「〜と言えるでしょう」「〜ではないでしょうか」のような、AI特有の曖昧な締め方を繰り返す。",
      "確認できない製造年・デザイナー・素材・製造国を書く。",
    ],
  };
}

/**
 * 新しい商品に対して、参考にする過去の文章を少数だけ選ぶ(§4.6)。
 *
 * 複雑なベクトル検索は導入しない —— 有料インフラを増やす前に、
 * まず商品名の語の重なりという単純な指標で足りるかを見る、という判断
 * (§4.6「必要なら単純metadata retrievalから開始し、複雑なvector infraは
 * 費用対効果を見て判断」)。
 */
export function selectStyleExamples(params: {
  /** 生成対象の商品名。 */
  targetName: string;
  examples: StyleExample[];
  /** 何件まで載せるか。 */
  limit?: number;
  /** 例の合計文字数の上限(プロンプト予算)。 */
  maxTotalChars?: number;
}): StyleExample[] {
  const limit = params.limit ?? 3;
  const maxTotalChars = params.maxTotalChars ?? 1500;

  const targetTokens = tokenize(params.targetName);
  const scored = params.examples
    // 同じ商品の文章を自分自身の手本にしない。
    .filter((e) => e.name !== params.targetName)
    .map((e) => ({ example: e, score: similarity(targetTokens, tokenize(e.name)) }))
    // 全く似ていないものも「BELLOらしい書き方」の代表としては使えるので、
    // 0点でも候補には残す(scoreの高い順に採るだけ)。
    .sort((a, b) => b.score - a.score || a.example.intro.length - b.example.intro.length);

  const picked: StyleExample[] = [];
  const seenIntros = new Set<string>();
  let total = 0;
  for (const { example } of scored) {
    if (picked.length >= limit) break;
    // 同一文面の重複を避ける(同じ定型の使い回しが複数商品にあるため)。
    const key = example.intro.slice(0, 60);
    if (seenIntros.has(key)) continue;
    if (total + example.intro.length > maxTotalChars) continue;
    picked.push(example);
    seenIntros.add(key);
    total += example.intro.length;
  }
  return picked;
}

/** 商品名を、比較に使える語の集合へ分解する。 */
function tokenize(name: string): Set<string> {
  const normalized = name
    .toLowerCase()
    .replace(/[【】\[\]（）()「」『』]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ");
  const tokens = normalized.split(/\s+/).filter((t) => t.length >= 2);
  // 日本語は空白で区切られないため、2文字の並び(bigram)も足して
  // 「サイドテーブル」と「テーブル」が重なるようにする。
  const out = new Set<string>(tokens);
  for (const t of tokens) {
    if (/[ぁ-んァ-ヶ一-龠]/.test(t)) {
      for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2));
    }
  }
  return out;
}

/** Jaccard係数。0〜1。 */
function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * プロンプトへ載せる文体例のブロックを組み立てる。
 *
 * 「事実の出典ではない」ことを、例の直前と直後の両方で明示する ——
 * 長いブロックの手前だけに書いた注意書きは無視されやすいため。
 */
export function buildStyleExamplesBlock(examples: StyleExample[]): string {
  if (examples.length === 0) return "";
  const body = examples.map((e, i) => `【文体例${i + 1}】\n${e.intro}`).join("\n\n");
  return [
    "以下は、BELLOが過去に書いた商品紹介文です。**文章の書き方・語り口・構成の参考にするためだけ**に示します。",
    "これらは別の商品についての文章であり、**事実の出典ではありません**。ここに出てくるブランド名・デザイナー名・製造年・素材・寸法・型番を、今回の商品の説明へ持ち込んではいけません。",
    "",
    body,
    "",
    "（文体例はここまで。以降、今回の商品について書けるのは、この後に示す事実だけです。）",
  ].join("\n");
}
