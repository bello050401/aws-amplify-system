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
