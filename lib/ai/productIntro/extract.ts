/**
 * 既存の商品説明から「商品のご紹介」部分だけを取り出す
 * (夜間統合指示書 2026-09-01 §4.4)。
 *
 * ## 何のために取り出すのか
 *
 * 取り出した文章は **文章の書き方(スタイル)を学ぶための資料** であって、
 * **新しい商品の事実の出どころではない**。この区別が崩れると、
 * 過去商品のデザイナー名・製造年・寸法が新商品の説明へ紛れ込む
 * (§4.7が最重要品質要件として名指ししている事故)。
 * そのためこのモジュールは「文章」しか返さず、事実の抽出は一切しない。
 *
 * ## 対応する2つの書式
 *
 * ### 1. `◎商品のご紹介` 見出し形式(指示書が想定するBASEの書式)
 *
 * ### 2. 罫線で囲まれた導入部(BELLOが実際に使っている書式)
 *
 * 本番Inventory 300件を実測して分かった、BELLOの実際の商品説明の構造:
 *
 * ```
 * ＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿
 *
 * ヤマギワのテーブルライト「Libra」
 * モダンテイストでシンプルながらも存在感のあるデザイン。
 * …(ここが「商品のご紹介」に相当する)
 *
 * ＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿＿
 *
 * 【商品名】
 * …
 * 【サイズ】
 * …
 * ```
 *
 * つまり **2本の罫線に挟まれた冒頭部分** が紹介文で、その後ろは
 * 商品名・サイズ・状態・発送・注意事項といった定型セクション。
 * 見出しが `◎商品のご紹介` でなくとも、この構造から同じものを取れる。
 *
 * ## 取れなかったものは混ぜない
 *
 * 紹介部分を特定できない説明文を「とりあえず全文」としてスタイル資料へ
 * 入れると、送料・返品条項・注意事項といった定型文をスタイルとして
 * 学習してしまう。特定できない場合は理由付きで失敗を返し、
 * 呼び出し側が corpus から除外できるようにする。
 */

export type IntroExtractionFailure =
  | "EMPTY_INPUT"
  /** 紹介文にあたる部分を特定できなかった。 */
  | "NO_INTRO_SECTION"
  /** 見つかったが、スタイル資料として使うには短すぎる。 */
  | "TOO_SHORT"
  /** 見つかった範囲が定型セクションだけだった。 */
  | "ONLY_BOILERPLATE"
  /** 社内情報(販売価格・コンディションスコア等)が混ざっていた。 */
  | "INTERNAL_CONTAMINATION";

export type IntroExtractionResult =
  | { ok: true; intro: string; source: "HEADING" | "DIVIDER" | "LEADING_TEXT" }
  | { ok: false; reason: IntroExtractionFailure };

/**
 * 「商品のご紹介」見出しの表記ゆれ。
 * ◎/●/■/★ 等の装飾、全角/半角スペース、コロンの有無を吸収する。
 */
const INTRO_HEADING = /(?:^|\n)[\s　]*[◎●○■□★☆▼▽◆◇・>＞]*[\s　]*商品(?:の)?[ご御]?紹介[\s　]*[:：]?[\s　]*(?:\n|$)/;

/**
 * 紹介文の終わりを示す、次セクションの見出し。
 * 実データで確認したBELLOの書式(【 商品名 】のように内側に空白が入る
 * ものがある)に合わせ、空白を許容する。
 */
const NEXT_SECTION = new RegExp(
  [
    // `【…】` は、この実データでは**常にセクション見出し**として使われて
    // おり、紹介文の地の文には現れない。個別の見出し名を列挙して
    // 追いかけるときりが無い(実際に `【商品外装】3/10`『【コメント】…』
    // という見出しを取りこぼし、社内の10段階評価と「数量 1個」が
    // corpus へ紛れ込んでいた)ため、`【…】` が出た時点で紹介文は
    // 終わりとみなす。
    "(?:^|\\n)[\\s　]*【[^】]{0,20}】",
    // 見出し記号を伴わない、単独行の定型セクション名。
    "(?:^|\\n)[\\s　]*(?:商品説明|商品情報|商品詳細|数量|個数|商品種別|カテゴリ|付属品|保証|支払方法)[\\s　]*(?:\\n|$)",
    "(?:^|\\n)[\\s　]*［[\\s　]*(?:到着日|発送|返品|返金|補償)[^］]*］",
    "(?:^|\\n)[\\s　]*\\[[\\s　]*(?:到着日|発送|返品|返金|補償)[^\\]]*\\]",
    // 見出し記号付きの定型セクション名。
    //
    // 【2026-09-02 実データで発見】BELLOは「◎商品詳細」のように記号を
    // 付けて書くが、`商品詳細` はここ(記号を許す側)に無く、記号なしの
    // 単独行を見る別の枝にしか無かった。そのため `◎商品詳細` が
    // セクションの切れ目として認識されず、**抽出した「紹介文」が寸法や
    // 型番の羅列を丸ごと飲み込んでいた**。
    // 実測: 紹介文267件のうち87%に寸法表記が含まれてしまっていたが、
    // セクション単位で数えると寸法が紹介文に置かれているのは2.8%しかない
    // —— つまり数字の出所は取りこぼした後続セクションだった。
    // 「紹介文の冒頭に寸法を並べない」という要件を守るには、まずここで
    // 正しく切れている必要がある。実データに出現した見出しを追加する。
    "(?:^|\\n)[\\s　]*[◎●○■□★☆▼▽◆◇]*[\\s　]*(?:商品(?:の)?状態|コンディション|状態ランク基準|サイズ|寸法|商品詳細|商品情報|こんな空間[^\\n]{0,12}|発送(?:について)?|配送(?:について)?|送料(?:について)?|お取り置き(?:について)?|注意事項|ご注意|返品|保証|関連リンク|SALEアイテム)[\\s　]*[:：]?[\\s　]*(?:\\n|$)",
  ].join("|"),
);

/** 罫線: ＿＿＿ / ─── / ___ / --- / ━━━ などが3つ以上連続する行。 */
const DIVIDER_LINE = /^[\s　]*[＿_─―ー—–\-─━═＝=~〜*＊✳︎]{3,}[\s　]*$/;

/** HTMLをプレーンテキストへ落とす。BASEのdescriptionはHTMLを含み得る。 */
export function htmlToPlainText(input: string): string {
  return input
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(?:p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

/** 行末空白を落とし、3行以上の空行を2行へ畳む。 */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[\s　]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 定型文しか無いか(=紹介文として使えない)。 */
function isOnlyBoilerplate(text: string): boolean {
  const boilerplate = [
    /ノークレーム|ノーリターン/,
    /画像にて(?:ご)?判断/,
    /佐川急便|ヤマト|らくらく家財便/,
    /到着をお急ぎの方/,
    /保険加入/,
    /返品|返金|補償/,
  ];
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return true;
  const boilerplateLines = lines.filter((l) => boilerplate.some((re) => re.test(l)));
  return boilerplateLines.length / lines.length >= 0.7;
}

const MIN_INTRO_LENGTH = 20;

/**
 * 社内向けの記述。これを含む範囲はスタイル資料として採用しない。
 *
 * 実データでの検出例: 見出しも罫線も無い説明文の冒頭を紹介文とみなした
 * ところ、「販売価格25,000別 / コンディション4.0 / 天板は研磨をして…」
 * という、**社内の販売価格と5段階スコアがそのまま入った塊** が取れた。
 * これをスタイル資料へ混ぜると、AIは「コンディション4.0です」のような
 * 文章を書くのが正しい書き方だと学習してしまう —— まさに§5.2が
 * 再発防止を求めている不具合そのもの。取れたものを無条件に信用しない。
 */
const INTERNAL_MARKERS = [
  /(?:販売|仕入|仕入れ|原価|卸)価格/,
  /(?:コンディション|状態|評価|ランク|外装)\s*[:：]?\s*\d+(?:\.\d+)?/,
  // 「3/10」のような社内の段階評価。実データの `【商品外装】3/10` で発見。
  /\d+\s*\/\s*(?:5|10)(?![0-9])/,
  /在庫\s*(?:数)?\s*[:：]?\s*\d+/,
  /数量\s*[:：]?\s*\d+/,
  /(?:管理番号|在庫ID|SKU)\s*[:：]/i,
];

function hasInternalContamination(text: string): boolean {
  const normalized = text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  return INTERNAL_MARKERS.some((re) => re.test(normalized));
}

/**
 * 商品説明全文から紹介部分を取り出す。
 *
 * @param description BASEのdescription、またはBELLOのInventory.note等。
 */
export function extractProductIntro(description: string | null | undefined): IntroExtractionResult {
  if (!description || !description.trim()) return { ok: false, reason: "EMPTY_INPUT" };

  const text = normalizeWhitespace(htmlToPlainText(description));
  if (!text) return { ok: false, reason: "EMPTY_INPUT" };

  // ── 1. `◎商品のご紹介` 見出しがある場合 ────────────────────────
  const headingMatch = INTRO_HEADING.exec(text);
  if (headingMatch) {
    const after = text.slice(headingMatch.index + headingMatch[0].length);
    const end = NEXT_SECTION.exec(after);
    const body = (end ? after.slice(0, end.index) : after).trim();
    return finalize(body, "HEADING");
  }

  // ── 2. 罫線に挟まれた導入部(BELLOの実際の書式) ──────────────────
  const lines = text.split("\n");
  const dividerIndexes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (DIVIDER_LINE.test(lines[i])) dividerIndexes.push(i);
  }
  if (dividerIndexes.length >= 2) {
    // 最初の罫線と、その次の罫線の間。
    const body = lines.slice(dividerIndexes[0] + 1, dividerIndexes[1]).join("\n").trim();
    const result = finalize(body, "DIVIDER");
    // 中身が空(TOO_SHORT)のときだけ次の手を試す —— 罫線で囲まれた範囲が
    // 定型文だけ/社内情報混じりだったという判断は、それ自体が結論なので、
    // 別の切り出し方で拾い直して上書きしてはいけない(拾い直すと、
    // まさに弾いたはずの文章を別経路で採用してしまう)。
    if (result.ok || result.reason !== "TOO_SHORT") return result;
  }
  if (dividerIndexes.length === 1) {
    // 罫線が1本だけなら、その手前を導入部とみなす(罫線の後ろは定型セクション)。
    const body = lines.slice(0, dividerIndexes[0]).join("\n").trim();
    const result = finalize(body, "DIVIDER");
    if (result.ok || result.reason !== "TOO_SHORT") return result;
  }

  // ── 3. 最初の定型セクション見出しまでを導入部とみなす ──────────
  const nextSection = NEXT_SECTION.exec(text);
  if (nextSection && nextSection.index > 0) {
    return finalize(text.slice(0, nextSection.index).trim(), "LEADING_TEXT");
  }

  // 見出しも罫線もセクションも無い —— 紹介部分を特定できない。
  return { ok: false, reason: "NO_INTRO_SECTION" };
}

function finalize(body: string, source: "HEADING" | "DIVIDER" | "LEADING_TEXT"): IntroExtractionResult {
  const intro = normalizeWhitespace(body);
  if (!intro || intro.length < MIN_INTRO_LENGTH) return { ok: false, reason: "TOO_SHORT" };
  if (isOnlyBoilerplate(intro)) return { ok: false, reason: "ONLY_BOILERPLATE" };
  if (hasInternalContamination(intro)) return { ok: false, reason: "INTERNAL_CONTAMINATION" };
  return { ok: true, intro, source };
}
