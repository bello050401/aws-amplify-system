/**
 * 社内向けの短い状態表現を、商品ページ向けの文へ整える
 * (2026-09-04 EC出品改修 追加指示 §5)。
 *
 * ── なぜ必要か(実データ) ────────────────────────────────────────
 *
 * `damageNotes` は社内のメモ欄で、実際に入っているのは
 *
 *   "小傷あり" / "擦れあり" / "汚れあり" / "小傷・擦れあり"
 *
 * のような**単語に近い断片**。これを商品説明の「◎コンディション」へ
 * そのまま出すと、文章の中に体言止めの断片がぽつんと並ぶ。
 *
 * ── AIに書かせない ──────────────────────────────────────────────
 *
 * §5「可能な限りAIの自由作文ではなく、限定的な condition normalizer /
 * formatter として実装してください」。ここは純粋関数で、
 * **語彙の対応表と決まった文型しか持たない**。
 *
 * ── 元情報に無いことを足さない(§5/§21/§28) ───────────────────────
 *
 * 「小傷あり」しか登録されていないのに
 *
 *   × 「脚部に小傷があります」    ← 場所を足している
 *   × 「目立たない程度です」      ← 程度を足している
 *   × 「使用には問題ありません」  ← 機能への影響を足している
 *
 * と書くことは禁止。この実装が足すのは
 *
 *   ・「使用に伴う」という、リユース品であることから言える前置き
 *   ・「ございます」という語尾
 *   ・「詳細はお写真をご確認ください。」という案内(§5が明示的に要求)
 *
 * だけで、**傷の場所・程度・原因・影響には一切触れない**。
 *
 * ── 既に文章になっているものは書き換えない ──────────────────────
 *
 * §5「元のdamageNotes等に詳細な文章がすでに存在する場合は、その事実を
 * 保持しつつ不自然な表現だけ整えてください」。文として成立している
 * ものは**そのまま**にし、写真の案内だけを添える。言い換えると事実が
 * 変わりうるので、整えるのは「断片であることが明らかなもの」に限る。
 *
 * ── 場所付きの断片(実データ) ────────────────────────────────────
 *
 * 実データには「天板小傷、脚にサビ」のように、**場所と傷語が「、」で
 * 並ぶだけ**の断片もある。上の「場所を足さない」原則は、元に無い場所を
 * 作文することの禁止であって、**元に既にある場所を落とすこと**は求めて
 * いない —— 落とせば「§5事実を保持しつつ」に反する。そこでこの場合は
 * 場所をそのまま残したうえで文章に整える(parseLocatedFragmentLine /
 * locatedFragmentToSentence)。ただし「大きな欠け」のように程度・大きさを
 * 示す語が前置きに混ざっていれば場所と決めつけず、書き換え自体を諦める
 * (§21 重大な欠け/破損を軽微に見せてはならない)。
 */

/** 「詳細はお写真をご確認ください。」(§5が要求する案内)。 */
export const PHOTO_REFERENCE_SENTENCE = "詳細はお写真をご確認ください。";

/**
 * 断片の語彙。**ここに無い語は言い換えない**(推測になるため)。
 *
 * `noun` は「〜がございます」の主語になる名詞。実データに現れた表記の
 * 揺れ(「キズ」「傷み」等)も同じ名詞へ寄せるが、意味は変えない。
 */
interface DamageTerm {
  /** 断片の中でこの語を見つけるための正規表現。 */
  pattern: RegExp;
  /** 文章にしたときの名詞。 */
  noun: string;
  /**
   * 「使用に伴う」を付けてよいか。
   *
   * 傷・擦れ・使用感はリユース品の使用によるものとして自然だが、
   * **汚れ・破れ・欠けは原因を断定できない**ので付けない
   * (「使用に伴う破れ」は原因を足したことになる)。
   */
  fromUse: boolean;
}

const DAMAGE_TERMS: DamageTerm[] = [
  { pattern: /小傷|小キズ|薄傷/, noun: "小傷", fromUse: true },
  { pattern: /擦れ|スレ|こすれ/, noun: "擦れ", fromUse: true },
  { pattern: /使用感/, noun: "使用感", fromUse: false },
  { pattern: /汚れ|ヨゴレ/, noun: "汚れ", fromUse: false },
  { pattern: /打痕|凹み|へこみ|ヘコミ/, noun: "打痕", fromUse: false },
  { pattern: /色褪せ|色あせ|日焼け/, noun: "色褪せ", fromUse: false },
  { pattern: /補修跡|補修/, noun: "補修跡", fromUse: false },
  { pattern: /剥がれ|はがれ|めくれ/, noun: "剥がれ", fromUse: false },
  { pattern: /割れ|ヒビ|ひび|クラック/, noun: "割れ", fromUse: false },
  { pattern: /破れ|やぶれ/, noun: "破れ", fromUse: false },
  { pattern: /欠け|カケ/, noun: "欠け", fromUse: false },
  { pattern: /ヘタり|へたり|ヘタリ/, noun: "ヘタり", fromUse: true },
  // サビは湿気・保管環境由来のこともあり、使用が原因と断定できない。
  { pattern: /サビ|錆/, noun: "サビ", fromUse: false },
  // 「傷」は上の複合語(小傷)に負けるよう最後に置く。
  { pattern: /傷|キズ/, noun: "傷", fromUse: true },
];

/**
 * 断片から取り除いてよい語。
 *
 * これらを外して何も残らなければ「語の羅列だけの断片」と判断できる。
 * 残るものがあれば、それは説明が書かれているということなので触らない。
 */
const FRAGMENT_FILLER =
  /(あり|有り|有|アリ|少々|やや|多少|若干|一部|部分的に|全体的に|軽微な?|多め|少なめ|など|等|&|＆|および|及び)/g;
const FRAGMENT_PUNCT = /[、,。・／\/\s　]/g;

/**
 * 「小傷・擦れあり」のような**語の羅列だけ**の断片か。
 *
 * 判定は「知っている傷の語と、上の付随語・記号を取り除いて何も残らないか」。
 * 残るもの(場所・状況の説明)があれば断片ではない —— 書き換えると事実を
 * 削ることになるので、そのまま残す。
 */
export function isDamageFragment(text: string): boolean {
  let residue = text.trim();
  if (!residue) return false;
  // 文として成立しているものは断片ではない(語尾・句点で判断)。
  if (/[。！？]/.test(residue)) return false;
  if (/(です|ます|ございます|ました|しております)/.test(residue)) return false;
  for (const term of DAMAGE_TERMS) residue = residue.replace(new RegExp(term.pattern.source, "g"), "");
  residue = residue.replace(FRAGMENT_FILLER, "").replace(FRAGMENT_PUNCT, "");
  return residue.length === 0;
}

/** 断片に含まれる傷の語を、書かれている順で拾う(重複は1回)。 */
export function extractDamageTerms(text: string): DamageTerm[] {
  const found: { term: DamageTerm; at: number }[] = [];
  let remaining = text;
  for (const term of DAMAGE_TERMS) {
    const m = remaining.match(term.pattern);
    if (!m || m.index === undefined) continue;
    found.push({ term, at: m.index });
    // 見つけた語は消す。「小傷」を拾ったあとに「傷」で二重に拾わない。
    remaining = remaining.replace(new RegExp(term.pattern.source, "g"), " ");
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.term);
}

/**
 * 断片を1文にする。
 *
 * 「使用に伴う」は、**その語のすべてが使用由来として自然な場合だけ**
 * 付ける。傷と汚れが混ざっているなら付けない —— 汚れの原因を使用だと
 * 断定したことになる。
 */
function fragmentToSentence(terms: DamageTerm[]): string {
  const nouns = terms.map((t) => t.noun);
  const joined = nouns.length === 1 ? nouns[0] : `${nouns.slice(0, -1).join("や")}や${nouns[nouns.length - 1]}`;
  // 「使用に伴う使用感」は同じことを2回言っている。使用感が含まれる場合は
  // 前置きを付けない —— 語を足さない方針とも噛み合う。
  const prefix = terms.every((t) => t.fromUse) && !nouns.includes("使用感") ? "使用に伴う" : "一部に";
  return `${prefix}${joined}がございます。`;
}

/**
 * 実データには「天板小傷、脚にサビ」のように、**場所+傷語**が「、」区切りで
 * 並ぶだけの断片もある(場所の助詞「に」が付く/付かないは書き手次第)。
 *
 * これは既存の `isDamageFragment`(場所があれば断片ではないと判定)には
 * 引っかからず、そのまま句点を付けるだけでは体言止めが並んで読みにくい。
 * ここだけを対象にした、もう1段別の書き換えを用意する。
 *
 * 「程度・大きさを示す語」が前置きに混ざっている場合は場所と決めつけず
 * 諦める(§21 重大な欠け/破損を軽微に見せない。「大きな欠け」を場所扱いで
 * 素通りさせて中身を壊さないための安全弁)。
 */
const SEVERITY_HINT = /(大きな|大きい|深い|長さ|長め|長い|広い|全面|全体|複数|重度|激しい|数か所|数箇所|かなり)/;

interface FragmentClause {
  /** 前置きの場所(「天板」「脚」等)。書かれていなければ null。 */
  location: string | null;
  terms: DamageTerm[];
}

/**
 * 1つの「、」区切り片が「(場所+)傷語(+付随語)」だけで説明できるか。
 *
 * 傷語より前の文字列を場所の前置きとみなすが、それが短い語でない、
 * または程度・数値を含む場合は場所と決めつけず null を返す —— 誤って
 * 程度の語を場所扱いにして中身ごと素通りさせないため。
 */
function parseFragmentClause(clause: string): FragmentClause | null {
  const trimmed = clause.trim();
  if (!trimmed) return null;
  if (/[。！？]/.test(trimmed)) return null;
  if (/(です|ます|ございます|ました|しております)/.test(trimmed)) return null;

  const terms = extractDamageTerms(trimmed);
  if (terms.length === 0) return null;

  let firstIdx = Infinity;
  for (const term of DAMAGE_TERMS) {
    const m = trimmed.match(term.pattern);
    if (!m || m.index === undefined) continue;
    firstIdx = Math.min(firstIdx, m.index);
  }

  let location: string | null = null;
  let rest = trimmed;
  if (firstIdx > 0 && firstIdx !== Infinity) {
    const prefix = trimmed.slice(0, firstIdx);
    const prefixCore = prefix.replace(/(に|の)$/, "");
    if (!prefixCore || prefixCore.length > 6 || SEVERITY_HINT.test(prefix) || /\d/.test(prefix)) {
      return null;
    }
    location = prefixCore;
    rest = trimmed.slice(firstIdx);
  }

  let residue = rest;
  for (const term of terms) residue = residue.replace(new RegExp(term.pattern.source, "g"), "");
  residue = residue.replace(FRAGMENT_FILLER, "").replace(FRAGMENT_PUNCT, "");
  if (residue.length !== 0) return null;

  return { location, terms };
}

/**
 * 行全体が「(場所+)傷語」の並びだけで説明できるか。1つでも説明できない
 * 片があれば諦める(全体を書き換えず、そのまま句点だけ整える側へ回す)。
 */
function parseLocatedFragmentLine(line: string): FragmentClause[] | null {
  if (/[。！？]/.test(line)) return null;
  if (/(です|ます|ございます|ました|しております)/.test(line)) return null;

  const clauses = line
    .split(/[、,]/)
    .map((c) => c.trim())
    .filter(Boolean);
  if (clauses.length === 0) return null;

  const parsed = clauses.map(parseFragmentClause);
  if (parsed.some((p) => p === null)) return null;
  return parsed as FragmentClause[];
}

/**
 * 場所付きの断片を1文にする。
 *
 * 場所ごとの事実(「天板に小傷」「脚にサビ」)は変えず、「、」でつないで
 * 文末に「がございます。」を付けるだけ —— 場所が複数あると原因を1つに
 * 断定できないため、fragmentToSentence のような「使用に伴う」は付けない。
 */
function locatedFragmentToSentence(clauses: FragmentClause[]): string {
  const parts = clauses.map((c) => {
    const nouns = c.terms.map((t) => t.noun);
    const joined = nouns.length === 1 ? nouns[0] : `${nouns.slice(0, -1).join("や")}や${nouns[nouns.length - 1]}`;
    return c.location ? `${c.location}に${joined}` : joined;
  });
  return `${parts.join("、")}がございます。`;
}

export interface NormalizedCondition {
  /** 商品説明へ入れる文章。 */
  text: string;
  /** 断片を文章へ言い換えたか(監査用)。 */
  rewritten: boolean;
  /** 傷・汚れ等が存在すると読める内容か(写真の案内を入れるかの判断)。 */
  hasDamage: boolean;
}

/**
 * 顧客向けの状態説明を整える。
 *
 * @param disclosure 既にメンテナンス記録の行を落とした状態説明
 *   (lib/inventory/maintenance.ts の stripMaintenanceOnlyLines 済み)。
 */
export function normalizeConditionDisclosure(disclosure: string | null | undefined): NormalizedCondition | null {
  const raw = disclosure?.trim();
  if (!raw) return null;

  // 行ごとに見る。実データには「研磨\n小傷あり」のように行で分かれた
  // 書き方がある(メンテナンス行は呼び出し前に落ちている)。
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  let rewritten = false;
  let hasDamage = false;
  const out: string[] = [];

  for (const line of lines) {
    const terms = extractDamageTerms(line);
    if (terms.length > 0) hasDamage = true;
    if (isDamageFragment(line) && terms.length > 0) {
      out.push(fragmentToSentence(terms));
      rewritten = true;
      continue;
    }
    // 「天板小傷、脚にサビ」のような場所付きの断片。上の isDamageFragment は
    // 場所があると断片ではないと判定するので、ここで別に拾う。
    const locatedClauses = parseLocatedFragmentLine(line);
    if (locatedClauses) {
      out.push(locatedFragmentToSentence(locatedClauses));
      rewritten = true;
      continue;
    }
    // 断片でない(=説明が書かれている)ものは触らない。句点だけ整える。
    out.push(/[。！？]$/.test(line) ? line : `${line}。`);
  }

  const body = out.join("\n");
  // §5 傷・擦れ・汚れ等がある商品には写真の案内を入れる。
  // 既に同じ趣旨が書かれているなら重ねない。
  const alreadyMentionsPhoto = /(写真|画像|お写真)/.test(raw);
  const text = hasDamage && !alreadyMentionsPhoto ? `${body}${PHOTO_REFERENCE_SENTENCE}` : body;

  return { text, rewritten, hasDamage };
}
