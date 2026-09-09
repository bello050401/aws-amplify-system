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

/**
 * ── 「◎商品のご紹介」への状態(コンディション)混入の検査(2026-09-09 追加指示) ──
 *
 * 報告: ◎商品のご紹介に「傷」「錆」等の状態説明が書かれ、コンディション欄
 * (buildConditionSection / conditionSection)へ分離されていない。寸法混入と
 * 同じ構造の不具合 —— プロンプトで「書くな」と指示するだけでは守られない
 * ことがある(寸法検査の実測がすでにそれを示している)ので、同じ形で
 * 機械検査を用意する。
 *
 * ── 2026-09-10 再検収での修正(表記ゆれ・情報欠損時の創作・誤削除の3件) ──
 *
 * 初版は「TRUSTED_FACTS(conditionDisclosure)に**同じ表記**で現れている
 * 語だけを違反とする」実装だった。実測で3つの不具合が見つかった。
 *
 *   1. 表記ゆれですり抜ける: 紹介文「脚にサビがあります」/開示文
 *      「脚に錆」——カタカナと漢字で表記が違うだけで、disclosure側の
 *      「錆」とintro側の「サビ」が文字列として一致せず、検出できない。
 *   2. 情報欠損なのに検出できない: 紹介文「天板に小傷があります。」で
 *      disclosureが空の場合、旧実装は比較対象が無いので無条件に合格に
 *      していた。これは「確認していない状態を紹介文が言い切っている」
 *      という**創作**であり、disclosureが空だからこそ危険 —— 本来
 *      個体の状態説明は(開示の有無によらず)紹介文に書いてはならず、
 *      コンディション欄でだけ扱う。
 *   3. 素材の一般的な性質まで誤って状態説明として弾く:
 *      「傷に強い素材を採用しています。」はこの個体の状態(傷がある)を
 *      述べているのではなく、素材の耐久性という一般的な性質の説明。
 *      disclosureに「傷」があるかどうかとは無関係に、これは削除すべき
 *      情報ではない。
 *
 * ── 新しい判定方法 ──────────────────────────────────────────────
 *
 * disclosureとの文字列一致ではなく、**紹介文自身の言い回し**を見る。
 *
 *   - 「keyword + が/も + あり/ある/見られ/見受けられ/見つかり/目立ち/
 *     生じ/出て/付いて/残って...」のように、その個体に実際にその状態が
 *     存在する(または存在しない)と言い切っている形だけを「状態の主張」
 *     とみなす。この形であれば、disclosureが空でも(=まだ何も確認して
 *     いなくても)紹介文がそれを言い切ってよい理由にはならないので、常に
 *     違反として扱う(不具合2の修正)。
 *   - 「keyword + に強い/がつきにくい/を防ぐ/耐◯◯」のように、素材や
 *     加工の一般的な性質を述べている形は状態の主張ではないため、
 *     除外する(不具合3の修正)。
 *   - 判定はkeywordの見た目の表記そのもの(CONDITION_VOCABに登録済みの
 *     カタカナ/ひらがな/漢字いずれの表記でも)に対して行うため、
 *     disclosure側の表記と一致している必要がない(不具合1の修正)。
 *
 * conditionDisclosureは引数として残す(呼び出し側・テストとの互換、
 * および将来の監査用途のため)が、上記のとおり判定そのものはintro単体の
 * 言い回しだけで完結する —— 「確認していない状態を作り出さない」という
 * 目的の方が「disclosureとの重複」を見る目的より優先度が高いため。
 */
export type ConditionKeyword =
  | "傷"
  | "キズ"
  | "汚れ"
  | "シミ"
  | "染み"
  | "錆"
  | "サビ"
  | "スレ"
  | "擦れ"
  | "破れ"
  | "ひび"
  | "亀裂"
  | "変色"
  | "色あせ"
  | "色褪せ"
  | "剥がれ"
  | "はがれ"
  | "へこみ"
  | "凹み"
  | "欠け"
  | "割れ"
  | "焼け"
  | "日焼け"
  | "カビ"
  | "におい"
  | "臭い";

const CONDITION_VOCAB: ConditionKeyword[] = [
  "傷", "キズ", "汚れ", "シミ", "染み", "錆", "サビ", "スレ", "擦れ",
  "破れ", "ひび", "亀裂", "変色", "色あせ", "色褪せ", "剥がれ", "はがれ",
  "へこみ", "凹み", "欠け", "割れ", "焼け", "日焼け", "カビ", "におい", "臭い",
];

/**
 * keywordの直後に続けば「その個体に実在する(/しない)状態」を言い切って
 * いるとみなす語。否定形(「〜ありません」)も「あり」を含むため一緒に
 * 拾う —— 状態の有無を断定している点では同じ扱いにする(文意の肯定/
 * 否定までは判定しない軽量な検査である、という既存方針を踏襲)。
 */
const STATE_EXISTENCE_MARKERS = /(?:あり|ある|ございます|ございません|見られ|見受けられ|見つかり|目立ち|生じ|出て|付いて|ついて|残って|残り)/;

/**
 * keywordの前後がこれに当たれば、個体の状態ではなく素材・加工の一般的な
 * 性質を述べていると判定し、状態の主張として扱わない
 * (例: 「傷に強い素材」「汚れがつきにくい加工」「耐傷仕様」)。
 */
const GENERAL_PROPERTY_AFTER = /(?:に強|につよ|がつきにく|つきにく|つきづら|しにく|しづら|目立ちにく|目立ちづら|を防|防止|抗菌|抗ウイルス)/;
const GENERAL_PROPERTY_BEFORE = /(?:耐|防)$/;

/** keyword出現位置の直後、次の句読点までの短い window だけを見る。 */
function afterContext(text: string, endIndex: number): string {
  const raw = text.slice(endIndex, endIndex + 16);
  const stop = raw.search(/[。\n]/);
  return stop >= 0 ? raw.slice(0, stop) : raw;
}

export interface IntroConditionViolation {
  keyword: ConditionKeyword;
}

/**
 * 紹介文に、その個体の状態(傷・錆・汚れ等)を言い切っている箇所が
 * ないかを検査する。
 *
 * conditionDisclosure は監査用に受け取るが、判定そのものはintroの
 * 言い回しだけで行う —— disclosureが空/不一致であっても、紹介文が
 * 個体の状態を言い切っていれば違反にする(「情報が無いのに創作した」
 * ケースを見逃さないため。上のコメント参照)。
 */
export function findIntroConditionViolations(
  intro: string | null | undefined,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 監査用の引数。判定には使わない(コメント参照)。
  conditionDisclosure?: string | null | undefined,
): IntroConditionViolation[] {
  if (!intro) return [];
  const found: IntroConditionViolation[] = [];
  const seen = new Set<ConditionKeyword>();
  for (const keyword of CONDITION_VOCAB) {
    let searchFrom = 0;
    for (;;) {
      const idx = intro.indexOf(keyword, searchFrom);
      if (idx < 0) break;
      const end = idx + keyword.length;
      searchFrom = end;

      const before = intro.slice(Math.max(0, idx - 2), idx);
      const after = afterContext(intro, end);
      if (GENERAL_PROPERTY_BEFORE.test(before) || GENERAL_PROPERTY_AFTER.test(after)) continue;
      if (!STATE_EXISTENCE_MARKERS.test(after)) continue;

      if (seen.has(keyword)) continue;
      seen.add(keyword);
      found.push({ keyword });
    }
  }
  return found;
}

export interface IntroConditionSanitizeResult {
  /** コンディション語を含む文を除いた紹介文。 */
  text: string;
  /** 実際に落とした文(監査用)。 */
  removedSentences: string[];
  /** 除去後も残っているか。 */
  stillViolating: IntroConditionViolation[];
}

/**
 * コンディションの語を含む文だけを落として紹介文を組み直す
 * (stripDimensionSentences と同じ考え方。文ごと落とし、部分的に切り取らない)。
 */
export function stripConditionSentences(
  intro: string,
  conditionDisclosure: string | null | undefined,
): IntroConditionSanitizeResult {
  const sentences = splitSentences(intro);
  const removed: string[] = [];
  const kept = sentences.filter((s) => {
    if (findIntroConditionViolations(s, conditionDisclosure).length === 0) return true;
    removed.push(s.trim());
    return false;
  });
  const text = kept.join("").replace(/\n{3,}/g, "\n\n").trim();
  return { text, removedSentences: removed, stillViolating: findIntroConditionViolations(text, conditionDisclosure) };
}
