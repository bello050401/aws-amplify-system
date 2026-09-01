/**
 * 過去BASE商品の中から、いま説明文を書こうとしている商品に近いものを探す。
 *
 * ## 何のために使うのか — そして何に使ってはいけないのか
 *
 * ここで返す過去商品は **文体の参考** にするためのものであって、
 * **事実の出所ではない**。似た椅子の過去商品に「オーク材」と書いてあった
 * としても、いま書こうとしている椅子がオーク材である根拠には一切ならない。
 * 生成側は、素材・寸法・デザイナー・製造年といった事実を必ず在庫DBから
 * 取り、ここから取ってはいけない(§5「過去商品の固有事実を現在商品へ
 * 誤転記しない」)。
 *
 * 型の上でもそれを守れるよう、返す構造体には過去商品の**紹介文だけ**を
 * 載せ、価格・寸法・素材といった事実項目は載せていない。
 *
 * ## 似ているの定義(実測にもとづく)
 *
 * BASEの商品名は実測で 141/267 (53%) が `/` 区切りで、先頭の区切りが
 * 「ブランド + 商品名」(例: `NORR11 Langue Chair`)、以降が検索用の
 * 語の羅列になっている。したがって:
 *
 *   1. ブランド一致 …… 最も強い手がかり。文体(そのブランドをどう紹介するか)
 *      が最も揃う。
 *   2. カテゴリ一致 …… チェア/テーブル/照明など。文章の組み立てが変わる。
 *   3. 価格帯の近さ …… 高価格帯ほど説明が厚くなる傾向があるため。
 *   4. 商品名の語の重なり …… 同型・同シリーズを拾う。
 *
 * 重みは「上の順で効く」ことだけを保証する粗いもので、精密な類似度を
 * 主張しない。目的は上位3〜5件を選ぶことであって、順位の厳密さではない。
 */

import { inferCategory } from "@/lib/ai/productIntro/styleProfile";

/** 検索対象(アーカイブ側)。事実項目を持たせないのは意図的 —— 上のコメント参照。 */
export interface ArchivedStyleReference {
  baseItemId: string;
  /** 検索用に正規化した商品名(`/` の先頭区切り)。 */
  titleCore: string;
  brand: string | null;
  category: string | null;
  price: number | null;
  /** 文体の参考にする紹介文。 */
  introText: string;
}

/** 現在の商品(在庫)側の手がかり。 */
export interface SimilarityQuery {
  name: string;
  brand?: string | null;
  category?: string | null;
  price?: number | null;
}

export interface SimilarityHit {
  reference: ArchivedStyleReference;
  score: number;
  /** なぜ選ばれたか。監査と説明のために必ず残す。 */
  reasons: string[];
}

const SCORE_BRAND = 100;
/** ブランド名が2語まで一致した場合の上乗せ(MARUNI COLLECTION 等)。 */
const SCORE_BRAND_PHRASE = 20;
const SCORE_CATEGORY = 40;
const SCORE_PRICE_BAND = 15;
/** 語の重なり1つあたり。ブランド一致1件より軽くなるよう上限を抑える。 */
const SCORE_TOKEN = 6;
const MAX_TOKEN_SCORE = 30;

/**
 * BASEの商品名から「ブランド + 商品名」の部分だけを取り出す。
 * 実測: 53%が `/` 区切りで、先頭が商品本体、以降は検索語。
 */
export function baseTitleCore(title: string): string {
  const head = String(title || "").split("/")[0];
  return head.replace(/[\s　]+/g, " ").trim();
}

/**
 * 先頭の英字1語をブランド候補とする。実測で紹介文の 64% が英字ブランド名
 * で始まり、72% が「英字（カタカナ読み）」の書式を使う。
 * ここで返すのは**検索の手がかり**であって、確定した事実ではない。
 *
 * 【なぜ1語なのか — 実測で直した】当初は最大2語を取っていたが、
 * `NORR11 Langue Chair` から `NORR11 Langue` を取ってしまい、同じ
 * NORR11の別シリーズ(`NORR11 Duke Side Table`)と一致しなくなっていた。
 * 2語目はたいてい**シリーズ名**であってブランドではない。
 * `MARUNI COLLECTION` や `Herman Miller` のような2語ブランドも、1語目
 * (`MARUNI` / `Herman`)で十分に一意に絞れる —— 実測のブランド一覧で、
 * 1語目が衝突する別ブランドは存在しなかった。
 * 2語の並びは baseBrandPhrase() が別に返し、そちらは加点にのみ使う。
 */
export function baseBrandHint(title: string): string | null {
  const core = baseTitleCore(title);
  const m = /^([A-Za-z][A-Za-z0-9&.'-]*)/.exec(core);
  if (!m) return null;
  const brand = m[1].trim();
  return brand.length >= 2 ? brand : null;
}

/** 先頭の英字2語まで。`MARUNI COLLECTION` のような複合ブランド名の一致に加点するため。 */
export function baseBrandPhrase(title: string): string | null {
  const core = baseTitleCore(title);
  const m = /^([A-Za-z][A-Za-z0-9&.'-]*(?:\s+[A-Za-z][A-Za-z0-9&.'-]*)?)/.exec(core);
  if (!m) return null;
  const phrase = m[1].trim();
  return phrase.length >= 2 ? phrase : null;
}

function normalizeBrand(brand: string | null | undefined): string | null {
  if (!brand) return null;
  const n = brand.toLowerCase().replace(/[^a-z0-9]/g, "");
  return n.length >= 2 ? n : null;
}

/** 商品名を語へ割る。1文字の語は雑音になるので落とす。 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of String(text || "").split(/[\s　/,、。()（）\[\]【】]+/)) {
    const t = raw.trim().toLowerCase();
    if (t.length >= 2) tokens.add(t);
  }
  return tokens;
}

function priceBandIndex(price: number | null | undefined): number | null {
  if (price === null || price === undefined || !Number.isFinite(price) || price <= 0) return null;
  if (price < 20000) return 0;
  if (price < 50000) return 1;
  if (price < 100000) return 2;
  if (price < 200000) return 3;
  return 4;
}

export function findSimilarArchivedProducts(
  query: SimilarityQuery,
  archive: ArchivedStyleReference[],
  options: { limit?: number } = {},
): SimilarityHit[] {
  const limit = options.limit ?? 5;

  const queryBrand = normalizeBrand(query.brand ?? baseBrandHint(query.name));
  const queryCategory = query.category ?? inferCategory(query.name);
  const queryPhrase = normalizeBrand(baseBrandPhrase(query.name));
  const queryTokens = tokenize(baseTitleCore(query.name));
  const queryBand = priceBandIndex(query.price ?? null);

  const hits: SimilarityHit[] = [];

  for (const ref of archive) {
    // 紹介文が無い過去商品は文体の参考にならない。
    if (!ref.introText || !ref.introText.trim()) continue;

    let score = 0;
    const reasons: string[] = [];

    const refBrand = normalizeBrand(ref.brand ?? baseBrandHint(ref.titleCore));
    if (queryBrand && refBrand && queryBrand === refBrand) {
      score += SCORE_BRAND;
      reasons.push(`ブランド一致(${ref.brand ?? refBrand})`);

      // 2語目まで揃うなら、同じブランドの中でもより近い(MARUNI COLLECTION 等)。
      const refPhrase = normalizeBrand(baseBrandPhrase(ref.titleCore));
      if (queryPhrase && refPhrase && queryPhrase === refPhrase && queryPhrase !== queryBrand) {
        score += SCORE_BRAND_PHRASE;
        reasons.push("ブランド名が2語まで一致");
      }
    }

    const refCategory = ref.category ?? inferCategory(ref.titleCore);
    if (queryCategory && refCategory && queryCategory === refCategory) {
      score += SCORE_CATEGORY;
      reasons.push(`カテゴリ一致(${refCategory})`);
    }

    const refBand = priceBandIndex(ref.price);
    if (queryBand !== null && refBand !== null && queryBand === refBand) {
      score += SCORE_PRICE_BAND;
      reasons.push("価格帯が近い");
    }

    const refTokens = tokenize(ref.titleCore);
    let overlap = 0;
    for (const t of queryTokens) {
      if (refTokens.has(t)) overlap++;
    }
    if (overlap > 0) {
      const tokenScore = Math.min(MAX_TOKEN_SCORE, overlap * SCORE_TOKEN);
      score += tokenScore;
      reasons.push(`商品名の語が${overlap}件一致`);
    }

    if (score <= 0) continue;
    hits.push({ reference: ref, score, reasons });
  }

  return hits
    .sort((a, b) => b.score - a.score || a.reference.baseItemId.localeCompare(b.reference.baseItemId))
    .slice(0, limit);
}
