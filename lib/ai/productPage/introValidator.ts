/**
 * 「◎商品のご紹介」に寸法を書かせないための決定的な検査(2026-09-02 指示書§4/§5)。
 *
 * 純粋関数のみ。AIも外部も触らないので、実データの断片で回帰にかけられる。
 *
 * ── なぜプロンプトだけでは足りないのか ──────────────────────────
 *
 * 実測: 12商品を生成したうち2件で、紹介文の冒頭に
 *
 *     「幅72 × 奥行71 × 高さ81（cm）のサイズで、ゆったりとくつろげる…」
 *
 * が入った。「書かないでください」という指示は守られないことがある。
 * 守られたかどうかは機械的に判定できるので、判定する。
 *
 * ── 「残ったまま成功にしない」 ──────────────────────────────────
 *
 * 以前の実装は1回だけ書き直させ、それでも残っていたらそのまま採用して
 * いた(ループを抜けるだけで、判定結果をどこにも反映していなかった)。
 * 指示書が明示的に禁じている「寸法が残った状態での成功扱い」そのもの。
 *
 * ここでは検出だけでなく **安全な除去** も用意する。寸法を含む文だけを
 * 落とし、残りで紹介文が成立するなら採用する。成立しなければ失敗として
 * 返す —— 黙って通さない。
 *
 * ── なぜ「単位付きの数値すべて」を弾かないのか ────────────────────
 *
 * 「3人掛け」「2灯」のような数え方まで弾くと、書けることが不当に狭まる。
 * 弾きたいのは寸法の表記であって数字ではない。ラベル(幅/奥行/高さ/W/D/H/
 * SH/AH/座面高/肘高)を伴う数値と、cm/mm を伴う数値、「○×○」の形に限る。
 */

export type IntroDimensionKind =
  | "AXIS_LABEL" // 幅120 / W72 / 奥行き60
  | "SEAT_OR_ARM" // SH45 / 座面高44 / AH65
  | "UNIT" // 72cm / 720mm
  | "MULTIPLIED" // 72×71 / 72 x 71
  | "THREE_SIDE_SUM"; // 3辺合計224

export interface IntroDimensionViolation {
  kind: IntroDimensionKind;
  /** 実際に検出した文字列(管理者へ「何が引っかかったか」を出す)。 */
  matched: string;
}

const PATTERNS: { kind: IntroDimensionKind; re: RegExp }[] = [
  // 幅120 / 奥行き60 / 高さ81 / 全長72 / 直径34(全角数字も拾う)
  { kind: "AXIS_LABEL", re: /(?:幅|奥行[きぎ]?|高さ|全長|直径|間口|奥ゆき)\s*[:：]?\s*[0-9０-９]/g },
  // W72 / D71 / H81 / Ｗ７２(全角の軸ラベルも実データに出る)。
  // 前後が英数字でないことを要求して「HD1080」のような型番を巻き込まない。
  { kind: "AXIS_LABEL", re: /(?<![A-Za-zＡ-Ｚ0-9０-９])[WDHＷＤＨ]\s*[:：]?\s*[0-9０-９]+/g },
  // SH45 / AH65 / 座面高44 / 肘高65 / 座面幅50
  { kind: "SEAT_OR_ARM", re: /(?:(?<![A-Za-z0-9])(?:SH|AH)\s*[:：]?\s*[0-9０-９]|座面\s*[^\s]{0,3}\s*[0-9０-９]|肘\s*[^\s]{0,3}\s*[0-9０-９])/gi },
  // 72cm / 720mm / 81（cm） / 81 cm
  //
  // 数値と単位の間に括弧や空白が入る書き方が実データに普通にある
  // (「高さ81（cm）」)。ここを詰めて書いていたため、指示書が挙げた
  // 失敗例そのものを取りこぼしていた。
  { kind: "UNIT", re: /[0-9０-９][0-9０-９.．]*\s*[（(]?\s*(?:cm|ｃｍ|mm|ｍｍ|センチ|ミリ)/gi },
  // 72×71 / 72 x 71 / 72 × 奥行71
  //
  // 「×」の後に軸ラベルが挟まる書き方(「幅72 × 奥行71 × 高さ81」)が
  // 実データの標準形。ラベルを許さない形にしていたため検出できていなかった。
  { kind: "MULTIPLIED", re: /[0-9０-９][0-9０-９.．]*\s*[×xX✕＊*]\s*(?:[^\d\s０-９]{0,4}\s*)?[0-9０-９]/g },
  // 3辺合計224
  { kind: "THREE_SIDE_SUM", re: /[3３三]\s*辺\s*(?:合計)?\s*[:：]?\s*[0-9０-９]/g },
];

/** 紹介文に残っている寸法表記をすべて挙げる。空配列なら合格。 */
export function findIntroDimensionViolations(intro: string | null | undefined): IntroDimensionViolation[] {
  if (!intro) return [];
  const found: IntroDimensionViolation[] = [];
  const seen = new Set<string>();
  for (const { kind, re } of PATTERNS) {
    // /g 付きの正規表現は lastIndex を持ち回るので、毎回作り直す。
    const local = new RegExp(re.source, re.flags);
    for (const m of intro.matchAll(local)) {
      const key = `${kind}|${m[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ kind, matched: m[0].trim() });
    }
  }
  return found;
}

/**
 * 文を「。」「\n」で区切る。区切り文字は残す(落とすと文が繋がって読めなくなる)。
 */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  let buffer = "";
  for (const ch of text) {
    buffer += ch;
    if (ch === "。" || ch === "\n") {
      out.push(buffer);
      buffer = "";
    }
  }
  if (buffer.length > 0) out.push(buffer);
  return out;
}

export interface IntroSanitizeResult {
  /** 寸法を含む文を除いた紹介文。 */
  text: string;
  /** 実際に落とした文(監査用。何を消したか分からないまま採用しない)。 */
  removedSentences: string[];
  /** 除去後も寸法が残っているか(残っていれば採用してはいけない)。 */
  stillViolating: IntroDimensionViolation[];
}

/**
 * 寸法を含む文だけを落として紹介文を組み直す。
 *
 * 「幅72 × 奥行71 × 高さ81（cm）のサイズで、ゆったりとくつろげるデザイン
 * です。」のように、寸法と魅力の説明が1文に同居していることがある。
 * その場合は文ごと落とす —— 部分的に切り取ると意味の壊れた文が残る。
 */
export function stripDimensionSentences(intro: string): IntroSanitizeResult {
  const sentences = splitSentences(intro);
  const removed: string[] = [];
  const kept = sentences.filter((s) => {
    if (findIntroDimensionViolations(s).length === 0) return true;
    removed.push(s.trim());
    return false;
  });
  // 空行が2つ以上続かないように畳む。
  const text = kept.join("").replace(/\n{3,}/g, "\n\n").trim();
  return { text, removedSentences: removed, stillViolating: findIntroDimensionViolations(text) };
}

/** 除去後の紹介文が、商品説明としてまだ成立しているか。 */
export const MIN_INTRO_LENGTH_AFTER_STRIP = 80;

export function isIntroStillUsable(text: string): boolean {
  return text.trim().length >= MIN_INTRO_LENGTH_AFTER_STRIP;
}

/**
 * ── 一般的なECテンプレート表現の検出(指示書§7/§22) ────────────────
 *
 * 「ゆったりとくつろげるデザインです」「リビングやラウンジにぴったり」
 * のような、どの商品にも当てはまる言い回しに偏らせない。
 *
 * 1つ含まれるだけで不合格にはしない —— 日本語として自然な範囲で使われる
 * こともある。**数**を数えて、多すぎる場合に品質ゲートで落とす。
 */
const GENERIC_PHRASES = [
  "ゆったりとくつろげる",
  "くつろぎの時間",
  "くつろぎのひととき",
  "にぴったり",
  "にもぴったり",
  "空間を演出",
  "空間に馴染み",
  "お部屋のアクセント",
  "洗練された",
  "上質な時間",
  "毎日の暮らし",
  "暮らしに寄り添",
  "きっとお気に入り",
  "ぜひこの機会に",
  "おすすめの一品",
  "おすすめの逸品",
  "魅力的なアイテム",
  "存在感を放",
];

export function findGenericPhrases(text: string): string[] {
  return GENERIC_PHRASES.filter((p) => text.includes(p));
}

/** 紹介文で許容する一般表現の数。これを超えたら「テンプレ寄り」とみなす。 */
export const MAX_GENERIC_PHRASES = 2;
