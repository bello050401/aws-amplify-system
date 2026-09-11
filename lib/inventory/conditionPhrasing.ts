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

/**
 * 「取った/除去した」のように、**その場でメモ書きされた口語の物語文**
 * (2026-09-11 追加指示、2026-09-12 事実区分の修正)。
 *
 * ── 何が足りなかったか(実データで報告された例) ────────────────────
 *
 *   「カップの内側に錆があった。取ったけど跡あり。」
 *
 * この文字列には句点(。)があるため、上の isDamageFragment /
 * parseLocatedFragmentLine のどちらも「文として成立している」と判定して
 * 素通りさせていた —— しかしこれは丁寧語で書かれた完成文ではなく、
 * 担当者がその場で書いた口語のメモ(「あった」「取った」「あり」という
 * 常体の羅列)であり、そのまま顧客向けに出すのは§5の要求(丁寧語)を
 * 満たさない。
 *
 * ── 何を書き換え、何を書き換えないか ──────────────────────────────
 *
 * すでに「です/ます/ございます/しております」等の丁寧語で書かれている
 * 文は対象にしない(§5「既に文章になっているものは書き換えない」を維持)。
 * 対象にするのは常体のメモだけ。
 *
 * 場所(「カップの内側」)・元の問題(「錆」)・処置の有無(取った/取って
 * いない/取れなかった/取る予定)・残存状態(跡あり/跡なし)を分けて読み取り、
 * **読み取れた範囲だけ**を丁寧語へ組み直す。処置の有無が読み取れない、
 * または傷語が複数(=どの処置がどの箇所に対応するか特定できない)場合は
 * 書き換えを諦め、呼び出し元の「そのまま句点だけ整える」経路へ委ねる —
 * 不明な対応関係を機械的に決め打ちすると、元に無い事実を作ることになる。
 *
 * ── 処置内容と実施事実を変えない(2026-09-12 QA指摘の修正) ──────────
 *
 * 当初の実装には次の2つの不具合があった。
 *
 *   1. PLANNED(予定)を一律「除去を予定」と書いていた。「清掃予定」
 *      「研磨予定」も除去に置き換わり、**予定している処置内容**が
 *      元のメモと変わってしまう。→ 予定の語から実際の動作(清掃/研磨/
 *      除去/対応)を読み取り、その語をそのまま使う(TREATMENT_PLANNED_ACTIONS)。
 *   2. 「取れなかった」(除去を試みたが取りきれず残った)を「取っていない」
 *      (そもそも着手していない)と同じ NOT_DONE 扱いにし、どちらも
 *      「除去は行っておりません」と書いていた。前者は**試みた**という
 *      事実が消え、後者と真逆の印象になる。→ 試行後残存(TRIED_NOT_REMOVED)
 *      を未着手(NOT_DONE)から分離する。
 */

type TreatmentStatus = "DONE" | "TRIED_NOT_REMOVED" | "NOT_DONE" | "PLANNED";

/**
 * 除去を試みたが取りきれなかった(=残存している)ことを示す語。
 *
 * 「取っていない」等の未着手とは異なり、**処置を行った事実がある**。
 * この事実を「除去は行っておりません」と書くと、試みた事実そのものを
 * 消してしまう(2026-09-12 QA指摘)。未着手の語より先に見る必要は無い
 * (語彙が重ならないため)が、DONEの動詞(「取った」等)より先に見る —
 * 「取ったけど取れなかった」のように両方の語が混在する行では、
 * 最終的な事実である「取りきれず残った」を優先するため。
 */
const TREATMENT_TRIED_NOT_REMOVED =
  /(取れなかった|取りきれなかった|取れきらなかった|落ちなかった|落ちきらなかった|除去できなかった|除去しきれなかった)/;

/** 未着手(そもそも処置を行っていない)を示す語。 */
const TREATMENT_NOT_DONE =
  /(未対応|未処置|未除去|取れていない|取っていない|除去していない|対応していない|処置していない|そのままに?なって(?:い)?(?:る|ます))/;

/**
 * 予定(まだ実施していない)を示す語と、その動作名。
 *
 * 動作ごとに配列を分けるのは、「清掃予定」「研磨予定」を「除去予定」と
 * 同じ語へ丸めない(§5/§21 処置内容を書き換えて事実を変えない)ため。
 * 具体的な動作語が書かれていない汎用の言い回し(「予定です」等)だけは
 * 動作名を確定できないので action は null にし、呼び出し側で中立の
 * 「対応」を補う(=新しい処置内容を作文するのではなく、最小限の
 * 汎用語で留める)。
 */
const TREATMENT_PLANNED_ACTIONS: { pattern: RegExp; action: string | null }[] = [
  { pattern: /清掃(?:する)?予定/, action: "清掃" },
  { pattern: /研磨(?:する)?予定/, action: "研磨" },
  { pattern: /除去(?:する)?予定/, action: "除去" },
  { pattern: /(?:対応|処置)(?:する)?予定/, action: "対応" },
  { pattern: /(?:する予定|予定です|予定しております)/, action: null },
];

/**
 * 処置済みを示す語。動詞ごとに文章化するときの動作名を変える
 * (すべて「除去」に寄せると、磨いた/クリーニングしたのような処置内容を
 * 誤って言い換えることになる)。
 */
const TREATMENT_DONE_ACTIONS: { pattern: RegExp; action: string }[] = [
  { pattern: /(取り除いた|除去した|除去済み|取った|落とした)/, action: "除去" },
  { pattern: /研磨した/, action: "研磨" },
  { pattern: /(磨いた|クリーニングした|洗浄した|拭いた|清掃した)/, action: "清掃" },
  { pattern: /(対応した|処置した)/, action: "対応" },
];

interface TreatmentDetection {
  status: TreatmentStatus;
  /** 実際に処置(または予定)した動作名。読み取れない場合は null。 */
  action: string | null;
  /** 判定の根拠になった、文中の一致部分(残差チェック用)。 */
  matched: string;
}

/**
 * 文から処置の状態を読み取る。優先順位は
 * 「試行後残存 → 未着手 → 予定 → 完了」。
 *
 * 試行後残存を最初に見るのは、「取ったけど取れなかった」のように
 * DONE語(取った)と TRIED_NOT_REMOVED語(取れなかった)が同じ文に
 * 混在する場合、**最終的な事実**(取りきれず残った)を優先するため
 * (試みた過程ではなく結果を書く)。
 */
function detectTreatment(text: string): TreatmentDetection | null {
  const tried = text.match(TREATMENT_TRIED_NOT_REMOVED);
  if (tried) return { status: "TRIED_NOT_REMOVED", action: null, matched: tried[0] };
  const notDone = text.match(TREATMENT_NOT_DONE);
  if (notDone) return { status: "NOT_DONE", action: null, matched: notDone[0] };
  for (const { pattern, action } of TREATMENT_PLANNED_ACTIONS) {
    const m = text.match(pattern);
    if (m) return { status: "PLANNED", action, matched: m[0] };
  }
  for (const { pattern, action } of TREATMENT_DONE_ACTIONS) {
    const m = text.match(pattern);
    if (m) return { status: "DONE", action, matched: m[0] };
  }
  return null;
}

/** 跡が残っていないことを示す語。「跡が残っている」と部分一致で誤検出しないよう、否定形を先に見る。 */
const REMAIN_ABSENT = /(跡は残って?いな|跡は残らな|跡もな|跡なし|きれいに(?:取れた|なった)|完全に取れた|残らなかった)/;
/** 跡が残っていることを示す語。 */
const REMAIN_PRESENT = /(跡あり|跡が残|跡は残って|シミが残|痕が残|跡が薄く残|多少跡)/;

function detectRemainState(text: string): boolean | null {
  if (REMAIN_ABSENT.test(text)) return false;
  if (REMAIN_PRESENT.test(text)) return true;
  return null;
}

/** 傷語の直前を場所とみなせるか(parseFragmentClauseと同じ判断基準)。 */
function extractLocationBeforeTerm(text: string, term: DamageTerm): string | null {
  const m = text.match(term.pattern);
  if (!m || m.index === undefined) return null;
  const prefixStart = Math.max(text.lastIndexOf("。", m.index), text.lastIndexOf("\n", m.index)) + 1;
  const prefix = text.slice(prefixStart, m.index);
  const core = prefix.replace(/(に|の)$/, "").trim();
  if (!core || core.length > 10 || SEVERITY_HINT.test(prefix) || /\d/.test(prefix)) return null;
  return core;
}

/**
 * 助詞・活用語尾・句読点だけの「つなぎ」の語。読み取った要素(場所/傷語/
 * 処置/残存状態)をすべて取り除いたあとにこれらしか残っていなければ、
 * メモの中身を取りこぼさずに読めたとみなす。
 */
const NARRATIVE_CONNECTIVE_FILLER = /(あった|けど|けれど|ので|でも|まだ|が|は|の|に|も|し|て|た|、|。|\s|　)/g;

/**
 * 読み取った処置の語が、本当にこの傷語について述べたものかを確かめる。
 *
 * detectTreatment は文字列全体を正規表現で見ているだけなので、
 * 「コーティング除去済み、天板に小傷あり」のように**無関係な処置の記述**
 * と傷語がたまたま同じ行にあるだけでも DONE と誤判定しうる —— この場合
 * 「除去済み」はコーティングの話であって天板の小傷とは無関係なのに、
 * 「天板の小傷は除去しております」と書くと事実を捏造したことになる。
 *
 * 場所・傷語・処置語・残存状態語を全て取り除いたあとの残り(つなぎの
 * 助詞・句読点を除く)がほぼ無ければ「これで全部読み取れた」とみなし、
 * 何か実質的な文字列が残るなら「読み取れていない部分がある」と判断して
 * 書き換えを諦める(誤った対応関係を作らない)。
 */
function residueAfterNarrativeParse(text: string, consumed: (string | null)[]): string {
  let residue = text;
  for (const c of consumed) {
    if (!c) continue;
    residue = residue.replace(c, "");
  }
  return residue.replace(NARRATIVE_CONNECTIVE_FILLER, "");
}

/**
 * 常体の物語メモを丁寧語の1文へ書き換える。書き換えられない(=処置の
 * 有無が読み取れない/傷語が複数ある/読み取った要素だけでは説明しきれない
 * 記述が混ざっている)場合は null を返し、呼び出し元が元の文をそのまま使う。
 */
function tryRewriteTreatmentNarrative(text: string): string | null {
  if (/(です|ます|ございます|ました|しております)/.test(text)) return null; // 既に丁寧語なら対象外(§5)
  const terms = extractDamageTerms(text);
  if (terms.length !== 1) return null; // 複数箇所は対応関係を特定できないため対象外
  const term = terms[0];

  const detection = detectTreatment(text);
  if (!detection) return null; // 処置の有無が読み取れないものは書き換えない
  const { status, action, matched } = detection;

  const location = extractLocationBeforeTerm(text, term);
  const termMatch = text.match(term.pattern);
  const remain = status === "DONE" ? detectRemainState(text) : null;
  const remainMatch = remain === true ? text.match(REMAIN_PRESENT) : remain === false ? text.match(REMAIN_ABSENT) : null;

  // 読み取れた要素だけで文の中身を説明しきれているかを確かめる。
  // 説明しきれない記述が残るなら、無関係な処置の混入を疑い書き換えを諦める。
  const residue = residueAfterNarrativeParse(text, [location, termMatch?.[0] ?? null, matched, remainMatch?.[0] ?? null]);
  if (residue.length > 2) return null;

  if (status === "NOT_DONE") {
    return `${location ? `${location}に` : ""}${term.noun}がございますが、除去は行っておりません。`;
  }
  if (status === "TRIED_NOT_REMOVED") {
    // 「取れなかった」は除去を試みた事実がある。「行っておりません」
    // (未着手)と書くと試みた事実が消えるため、試行と残存の両方を書く。
    return `${location ? `${location}に` : ""}${term.noun}がございます。除去を試みましたが、取りきれておりません。`;
  }
  if (status === "PLANNED") {
    // 動作を特定できた場合はその語を使う(除去に丸めない)。特定できない
    // 汎用の言い回し(「予定です」等)だけは中立の「対応」で留める。
    const label = action ?? "対応";
    return `${location ? `${location}に` : ""}${term.noun}がございます。${label}を予定しておりますが、現状は未対応です。`;
  }
  // DONE
  const subject = location ? `${location}の${term.noun}` : term.noun;
  if (remain === true) return `${subject}は${action}しておりますが、処理後の跡が残っています。`;
  if (remain === false) return `${subject}は${action}しており、跡も残っておりません。`;
  return `${subject}は${action}しております。`;
}

/**
 * 隣接する2行が「傷の発見」+「処置の結果」に分かれているだけの限定ケースを
 * 検出し、1文へ結合する(2026-09-12 改行ありの物語メモ対応)。
 *
 * ── なぜ隣接行だけを見るのか ────────────────────────────────────
 *
 * 実データには「カップの内側に錆があった。\n取ったけど跡あり。」のように、
 * 発見と処置結果が改行で分かれた書き方がある。tryRewriteTreatmentNarrative
 * は1行分の文字列しか見ないため、改行で分断されたままだと結合できず、
 * 生の改行が商品説明にそのまま残ってしまう(改行なしなら自然文になるのに、
 * 改行ありだけ要件未達になっていた実測結果への対応)。
 *
 * ── 結合してよい条件(限定ケース) ──────────────────────────────
 *
 *   1. current行に傷語がちょうど1つだけあり、処置の語は無い
 *      (=「傷が見つかった」という事実だけを述べている)。
 *   2. next行に傷語が無く、処置の語がある
 *      (=「処置した/しなかった/する予定」という事実だけを述べている)。
 *   3. どちらも既に丁寧語の完成文ではない(§5「既に文章になっているものは
 *      書き換えない」を維持)。
 *   4. 結合した文字列を tryRewriteTreatmentNarrative に渡し、実際に
 *      書き換えられる(=読み取れた要素だけで説明しきれる)場合だけ採用する。
 *
 * これらを1つでも満たさなければ結合しない。特に next行に傷語がある場合
 * (=別の箇所・別の傷の可能性)は結合を諦め、2行のまま(改行を残したまま)
 * それぞれ個別に処理させる —— 別の傷の処置を誤って結び付けない(§5/§21
 * 事実の捏造禁止)ための安全弁であり、「改行を全消去する」だけの修正には
 * しない。
 */
function tryMergeAdjacentTreatmentLines(current: string, next: string): string | null {
  const isAlreadyPolite = (t: string) => /(です|ます|ございます|ました|しております)/.test(t);
  if (isAlreadyPolite(current) || isAlreadyPolite(next)) return null;

  const currentTerms = extractDamageTerms(current);
  if (currentTerms.length !== 1) return null;
  // 発見行に処置の言及が既にあるなら、単独行の書き換え経路に任せる
  // (そちらで既に解決できているはず。ここで重ねて扱うと二重処理になる)。
  if (detectTreatment(current)) return null;

  const nextTerms = extractDamageTerms(next);
  // next行に傷語があるなら、別の箇所・別の傷の可能性がある。
  // 機械的に結び付けず、行を分けたまま個別に処理させる。
  if (nextTerms.length !== 0) return null;
  if (!detectTreatment(next)) return null;

  const sep = /[。！？]$/.test(current) ? "" : "。";
  return tryRewriteTreatmentNarrative(`${current}${sep}${next}`);
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
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
    // 常体の物語メモ(「錆があった。取ったけど跡あり。」等)は、句点が
    // あるだけで丁寧語の完成文とは限らない。読み取れる範囲でだけ書き換える。
    const narrative = tryRewriteTreatmentNarrative(line);
    if (narrative) {
      out.push(narrative);
      rewritten = true;
      continue;
    }
    // 「カップの内側に錆があった。\n取ったけど跡あり。」のように、発見と
    // 処置結果が改行で分かれているだけの限定ケース。結合できたときだけ
    // 次の行を読み飛ばす(結合できなければ、この行はそのまま個別に扱う)。
    const nextLine = lines[i + 1];
    if (nextLine !== undefined) {
      const merged = tryMergeAdjacentTreatmentLines(line, nextLine);
      if (merged) {
        out.push(merged);
        rewritten = true;
        i += 1;
        continue;
      }
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
