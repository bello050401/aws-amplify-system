import { looksLikePersonalData, type CustomerSafeFacts } from "./facts";

/**
 * 生成された顧客向け文章の機械検査(夜間統合指示書 2026-09-01 §4.9 / §5.2)。
 *
 * プロンプトで「書くな」と指示するだけでは守られないことがある、という
 * 前提に立つ。実際に報告された不具合:
 *
 *   - 「コンディションは4です」      → 社内スコアの露出
 *   - 「在庫は2点あります」          → 在庫数の露出
 *   - 「関連ブランドにはムートやHAYがあります」
 *                                    → 事実に無いブランドの捏造
 *
 * ここでの判定は **決定的(deterministic)** であり、AIの再判定に頼らない。
 * 検査に落ちた生成結果は採用せず、呼び出し側が再生成するか諦めるかを決める。
 *
 * 誤検知(false positive)より見逃し(false negative)のほうが害が大きい、
 * という前提で閾値を決めている —— 顧客向けの公開文章に社内情報や他人の
 * 住所が載る事故は、文章がもう一度生成されることより遥かに重い。
 */

export type FactSafetyViolationCode =
  | "INTERNAL_CONDITION_SCORE"
  | "STOCK_DISCLOSURE"
  | "SKU_OR_MANAGEMENT_ID"
  | "UNSUPPORTED_BRAND"
  // 2026-09-11 追加指示: ブランドが生まれた国と、この個体の実際の製造国は
  // 別の事実。「イタリアのブランドだからイタリア製」のように、facts側に
  // 単に国名の文字列が出ているだけ(ブランドの本国・素材の産地としての
  // 言及)を製造国の裏付けとして扱わない。製造国が事実として確認できた
  // (facts側にも「製造国は〜」「〜製」のように明示的な製造国の記述が
  // あり、かつそれが完成品(個体)自体を指し、否定・不明・推測を述べて
  // いない)場合だけ承認する。2026-09-12 追加指示: 「イタリア製レザー」
  // 「脚はイタリア製」のように部材・素材だけを指す記述は、完成品全体の
  // 製造国の主張・裏付けのどちらにも使わない(下のPART_OR_MATERIAL_WORDS
  // 参照)。
  | "UNSUPPORTED_COUNTRY_CLAIM"
  // 2026-09-11 追加指示: 照明をデザイナーズ「家具」と呼ぶ等、渡された
  // カテゴリと矛盾する一般名称。判定・除去は lib/ai/productPage/
  // introValidator.ts (findCategoryMismatchViolations) が担当し、
  // service.ts がここと同じ violations の並びへ載せる。
  | "INTRO_CATEGORY_MISMATCH"
  | "PERSONAL_DATA"
  | "PERSON_NAME"
  | "PRICE_CLAIM"
  | "SECTION_HEADING_CONTAMINATION"
  | "PROMPT_LEAKAGE"
  | "EMPTY_OUTPUT"
  | "TOO_LONG"
  | "EXCESSIVE_REPETITION"
  // 2026-09-02 指示書§5/§7: 商品ページ生成の品質ゲート。
  // 「◎商品のご紹介」に寸法が残っている / 一般的なEC表現に偏っている。
  // 事実の捏造ではないが、どちらも「そのまま採用してはいけない」種類の
  // 問題なので、同じ violations の仕組みで扱う。
  | "INTRO_CONTAINS_DIMENSIONS"
  | "GENERIC_PHRASING"
  // 2026-09-09 追加指示: 「◎商品のご紹介」に傷・錆・汚れ等のコンディション
  // 説明が混入している(◎コンディションへ分離すべき情報)。
  | "INTRO_CONTAINS_CONDITION";

export interface FactSafetyViolation {
  code: FactSafetyViolationCode;
  /** 管理者向けの説明。顧客には出さない。 */
  detail: string;
}

export interface FactSafetyResult {
  ok: boolean;
  violations: FactSafetyViolation[];
}

/**
 * BELLOが実際に扱う家具・インテリアのブランド名。
 *
 * 生成文にこの中のブランドが出てきたとき、それが**現在の商品の事実に
 * 含まれていない**なら捏造とみなす。報告された
 * 「関連ブランドにはムートやHAYがあります」がまさにこれで、
 * BoConceptの商品説明に無関係のMuuto/HAYが現れていた。
 *
 * 網羅リストである必要はない —— 実際に混入が観測された/観測されやすい
 * 著名ブランドを押さえられればよい。ここに無いブランドを捏造された場合は
 * 検出できないが、それは「検査が緩い」のであって「誤って弾く」のではない。
 */
/**
 * 同じブランドの別表記をひとまとまりにしたもの。
 *
 * 【2026-09-02 実測で必要になった】在庫名が「カリモク」で、生成文が
 * 「Karimoku」と書いたケースを UNSUPPORTED_BRAND として弾いていた。
 * 同じブランドの英字表記と日本語表記であって、捏造ではない。
 * 表記ごとに独立した文字列として並べていたため、事実側の「カリモク」と
 * 生成側の「Karimoku」が結び付かなかった。
 *
 * ここを組にしておけば、**事実に含まれるブランドのどの表記が出ても
 * 通り、事実に無いブランドは表記を変えても弾ける**。検査は緩くならない。
 */
const BRAND_ALIAS_GROUPS: readonly (readonly string[])[] = [
  ["HAY"],
  ["Muuto", "ムート", "ムーート"],
  ["BoConcept", "ボーコンセプト"],
  ["vitra", "Vitra", "ヴィトラ", "ビトラ"],
  ["Cassina", "カッシーナ"],
  ["USM"],
  ["Artek", "アルテック"],
  ["Fritz Hansen", "フリッツハンセン"],
  ["Herman Miller", "ハーマンミラー"],
  ["Knoll", "ノル"],
  ["Carl Hansen", "カールハンセン"],
  ["&Tradition", "アンドトラディション"],
  ["Louis Poulsen", "ルイスポールセン"],
  ["Flos", "フロス"],
  ["Kartell", "カルテル"],
  ["B&B Italia"],
  ["Minotti", "ミノッティ"],
  ["Poliform"],
  ["NATUZZI", "ナツッジ"],
  ["IKEA", "イケア"],
  ["無印良品", "MUJI"],
  ["Karimoku", "カリモク"],
  ["天童木工"],
  ["マルニ", "MARUNI"],
  ["yamagiwa", "ヤマギワ"],
  ["Arflex", "アルフレックス"],
  ["Ligne Roset", "リーンロゼ"],
  ["Time & Style"],
] as const;

/** 平坦な一覧。既存の呼び出し側・テストが参照しているため形は変えない。 */
export const KNOWN_FURNITURE_BRANDS = BRAND_ALIAS_GROUPS.flat() as readonly string[];

/**
 * 「〜製」「製造国は〜」の形で出やすい国名。網羅リストである必要はなく、
 * BELLOが扱う家具・什器の産地として実際に出現しやすいものを押さえる
 * (KNOWN_FURNITURE_BRANDS と同じ考え方 —— ここに無い国名の捏造は
 * 検出できないが、それは検査が緩いだけで誤って弾くよりましという判断)。
 */
const COUNTRY_NAMES = [
  "日本", "中国", "台湾", "韓国", "タイ", "ベトナム", "インドネシア", "インド",
  "イタリア", "ドイツ", "フランス", "デンマーク", "スウェーデン", "ノルウェー", "フィンランド",
  "イギリス", "オランダ", "ベルギー", "スペイン", "ポルトガル", "スイス", "オーストリア",
  "アメリカ", "カナダ", "ブラジル", "メキシコ", "ポーランド",
] as const;

/**
 * 「完成品(個体)全体」ではなく、脚・部材・交換部品・素材だけを指している
 * 語。網羅リストである必要はない(COUNTRY_NAMES・KNOWN_FURNITURE_BRANDS
 * と同じ考え方)。
 *
 * 2026-09-12 QAレビュー指摘への対応: manufactureCountryClaimPattern は
 * 「イタリア製」という文字列にしか一致しないため、「イタリア製レザーを
 * 使用」「脚はイタリア製」のように部材・素材だけの製造国・産地を述べた
 * 記述までもが、完成品全体のイタリア製という主張・裏付けの両方に
 * 使われてしまっていた。ここに挙げた語が国名+「製」の直前(主語として)・
 * 直後(修飾する名詞として)にある場合は、完成品全体の製造国を述べたもの
 * ではないとみなす。
 */
const PART_OR_MATERIAL_WORDS = [
  "脚", "部材", "部品", "交換部品", "パーツ", "素材", "生地", "張地",
  "レザー", "革", "天板", "座面", "背面", "フレーム", "金具", "取っ手", "ハンドル", "キャスター",
] as const;

/**
 * 文中で国名の直後に「製造国そのもの」を述べている箇所を探す正規表現。
 * ブランドの本国(「イタリアのブランド」)や素材の産地(「イタリア産」)は
 * 「製」「製造国」「原産国」のいずれの語も伴わないので、ここには一致しない
 * —— それが狙いで、この正規表現一つで両者を区別している。
 */
function manufactureCountryClaimPattern(country: string): RegExp {
  return new RegExp(`${country}製|(?:製造国|原産国)\\s*(?:は|:|：)?\\s*${country}`, "g");
}

/**
 * マッチの直前・直後を見て、部材・素材だけを指す記述でないかを確認する。
 *
 * - 直前: 「脚は」「レザーは」のように、部材・素材が主語としてマッチの
 *   直前に置かれている場合(「脚はイタリア製です」)。
 * - 直後: 「イタリア製レザー」のように、国名+「製」が直後の名詞を修飾する
 *   複合語になっている場合(間に句読点を挟まない、この形の場合だけ)。
 *
 * どちらも完成品(個体)全体の製造国を述べたものではないので、国主張の
 * 検出・裏付けのどちらにも使わない(下の呼び出し側を参照)。
 */
function isPartOrMaterialScopedAt(source: string, matchStart: number, matchEnd: number): boolean {
  const partOrMaterial = PART_OR_MATERIAL_WORDS.join("|");
  const before = source.slice(Math.max(0, matchStart - 14), matchStart);
  if (new RegExp(`(?:${partOrMaterial})\\s*(?:は|が|も)\\s*$`).test(before)) return true;
  const after = source.slice(matchEnd, matchEnd + 8);
  return new RegExp(`^の?(?:${partOrMaterial})`).test(after);
}

/**
 * マッチ直後に否定・不明・推測の語が続いていないか、直前に「おそらく」
 * 等の推測の語が置かれていないかを見る。
 *
 * 「イタリア製ではない」「製造国はイタリアではありません」のように、
 * facts側にたまたま国名+「製」の並びが出ていても、それが否定文なら
 * 製造国イタリアを裏付ける記述ではない —— むしろ逆である。
 * 「不明」「未確認」「おそらく〜だろう」「〜と思われる」も同様に、
 * 確認できた事実として断定されたわけではないので裏付けにしない
 * (2026-09-12 追加指示: 推測も承認しない)。
 */
function isNegatedOrUnknownAt(source: string, matchStart: number, matchEnd: number): boolean {
  const before = source.slice(Math.max(0, matchStart - 8), matchStart);
  if (/おそらく|たぶん|恐らく|多分/.test(before)) return true;
  const after = source.slice(matchEnd, matchEnd + 12);
  return /ではな|でな|じゃな|とは言えな|不明|未確認|わかりません|分かりません|と思われ|かもしれ|と推測/.test(after);
}

/**
 * facts側(事実コーパス)に、この個体(完成品)の製造国としてcountryが
 * 明示的に記録されているか。国名が単独で出ているだけ(ブランドの本国・
 * 素材の産地としての言及)や、脚・部材・素材だけを指す記述では裏付けに
 * ならない —— 「製造国は〜」「〜製」のように、完成品そのものの製造国を
 * 述べた記述だけを裏付けとして扱う。
 */
function factsAssertManufactureCountry(factsText: string, country: string): boolean {
  const re = manufactureCountryClaimPattern(country);
  let m: RegExpExecArray | null;
  while ((m = re.exec(factsText))) {
    const matchEnd = m.index + m[0].length;
    if (isNegatedOrUnknownAt(factsText, m.index, matchEnd)) continue;
    if (isPartOrMaterialScopedAt(factsText, m.index, matchEnd)) continue;
    return true;
  }
  return false;
}

/**
 * 生成文が「商品紹介」以外の定型セクションへ侵食していないかを見る見出し。
 * 実データ(Inventory.note)で確認した、BELLOが実際に使っている書式。
 */
const SECTION_HEADINGS = [
  "【商品名】", "【 商品名 】", "【サイズ】", "【 サイズ 】",
  "【状態】", "【 状態 】", "【発送】", "【 発送 】",
  "【注意事項】", "【 注意事項 】", "［到着日について］", "[到着日について]",
  "［発送に関する返金・補償について］", "【商品情報】",
];

/** 空白差を吸収して見出しを検出する。 */
function containsSectionHeading(text: string): string | null {
  const compact = text.replace(/[\s　]/g, "");
  for (const h of SECTION_HEADINGS) {
    if (compact.includes(h.replace(/[\s　]/g, ""))) return h;
  }
  return null;
}

function normalizeForMatch(text: string): string {
  return text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 全角/半角・大小文字を吸収してブランド名を含むか見る。 */
function mentionsBrand(text: string, brand: string): boolean {
  const t = text.toLowerCase();
  const b = brand.toLowerCase();
  if (!/^[\x20-\x7e]+$/.test(brand)) {
    // 日本語のブランド表記はそのまま部分一致でよい。
    return text.includes(brand);
  }
  // 英字ブランドは単語境界で見る("Knoll"が"Knolls"に化けるのは許容、
  // "HAY"が"highway"のような無関係語へ誤ヒットするのを避けるのが目的)。
  const re = new RegExp(`(^|[^a-z0-9])${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
  return re.test(t);
}

export function checkFactSafety(params: {
  /** 生成された顧客向け文章。 */
  output: string;
  /** 生成の根拠として認めた事実。 */
  facts: CustomerSafeFacts;
  /** 在庫数(顧客向け文章に出してはいけない)。 */
  stockQuantity?: number | null;
  /** 在庫ID/SKU(顧客向け文章に出してはいけない)。 */
  sku?: string | null;
  /** 許容する最大文字数。 */
  maxLength?: number;
  /**
   * CustomerSafeFacts に含まれない、事実として確認済みの追加情報
   * (例: 商品名から機械的に導いたブランド、ZAICO「⚪︎材質」)。
   *
   * 2026-09-11 追加: ブランド・金額・製造国の「事実に裏付けがあるか」の
   * 判定はここまでの factsText だけを見ていたため、商品名に現れていない
   * 形でしかブランドを確認できない場合や、材質欄に明記された製造国
   * (例: ZAICO備考の「イタリア製」)があっても裏付けとして扱えなかった。
   * ここへ渡せば同じ判定へ合流する(検査を二重に作らない)。
   */
  extraFactsText?: string | null;
}): FactSafetyResult {
  const violations: FactSafetyViolation[] = [];
  const output = params.output ?? "";
  const text = normalizeForMatch(output);
  const factsText = normalizeForMatch(
    [
      params.facts.name,
      params.facts.dimensions,
      params.facts.categoryName,
      params.facts.conditionDisclosure,
      params.facts.publicNote,
      params.extraFactsText,
    ]
      .filter((v): v is string => Boolean(v))
      .join("\n"),
  );

  if (!output.trim()) {
    return { ok: false, violations: [{ code: "EMPTY_OUTPUT", detail: "生成結果が空でした。" }] };
  }

  const maxLength = params.maxLength ?? 1200;
  if (output.length > maxLength) {
    violations.push({ code: "TOO_LONG", detail: `生成結果が${output.length}文字で、上限${maxLength}文字を超えています。` });
  }

  // ── 社内コンディションスコアの露出 ───────────────────────────────
  // 「コンディションは4です」「状態: 3.5」「コンディションランク4」等。
  // 数値そのものが顧客にとって意味を持たない社内語彙なので、
  // 「コンディション/状態 + 数値」の共起を禁止する。
  const conditionScorePatterns = [
    /(?:コンディション|状態|評価|ランク|グレード)(?:ランク|評価|レベル)?\s*(?:は|が|:|：|\/)?\s*\d+(?:\.\d+)?\s*(?:です|でした|点|段階|ランク|\/\s*5|$|[。、\s])/,
    /(?:コンディション|状態)\s*[:：]\s*\d+(?:\.\d+)?/,
    /\d+(?:\.\d+)?\s*(?:段階評価|点満点)/,
  ];
  for (const re of conditionScorePatterns) {
    const m = re.exec(text);
    if (m) {
      violations.push({ code: "INTERNAL_CONDITION_SCORE", detail: `社内のコンディション評価スコアが露出しています: ${JSON.stringify(m[0])}` });
      break;
    }
  }

  // ── 在庫数の露出 ─────────────────────────────────────────────────
  const stockPatterns = [
    /在庫(?:数)?\s*(?:は|が|:|：)?\s*\d+\s*(?:点|個|台|脚|客|セット|つ)/,
    /(?:残り|のこり)\s*\d+\s*(?:点|個|台|脚|客|セット)/,
    /\d+\s*(?:点|個|台|脚)\s*(?:の)?(?:在庫|ご用意)/,
  ];
  for (const re of stockPatterns) {
    const m = re.exec(text);
    if (m) {
      violations.push({ code: "STOCK_DISCLOSURE", detail: `在庫数が露出しています: ${JSON.stringify(m[0])}` });
      break;
    }
  }

  // ── SKU / 管理番号の露出 ─────────────────────────────────────────
  if (params.sku && params.sku.trim() && text.includes(normalizeForMatch(params.sku.trim()))) {
    violations.push({ code: "SKU_OR_MANAGEMENT_ID", detail: "在庫ID(SKU)が露出しています。" });
  } else if (/(?:管理番号|在庫ID|SKU)\s*(?:は|:|：)/i.test(text)) {
    violations.push({ code: "SKU_OR_MANAGEMENT_ID", detail: "管理番号・在庫IDへの言及があります。" });
  }

  // ── 事実に無いブランドの捏造 ─────────────────────────────────────
  // 判定はブランド単位(表記の組)で行う。事実側にそのブランドのいずれかの
  // 表記があれば、生成側がどの表記で書いても捏造ではない。
  const invented: string[] = [];
  for (const group of BRAND_ALIAS_GROUPS) {
    const inOutput = group.filter((b) => mentionsBrand(output, b));
    if (inOutput.length === 0) continue;
    const supportedByFacts = group.some((b) => mentionsBrand(factsText, b));
    if (!supportedByFacts) invented.push(...inOutput);
  }
  if (invented.length > 0) {
    violations.push({
      code: "UNSUPPORTED_BRAND",
      detail: `商品の事実に含まれないブランド名が出ています: ${invented.join(", ")}`,
    });
  }

  // ── ブランドの本国・素材の産地・部材と製造国の混同 ───────────────
  // 「イタリアのブランドだからイタリア製」「イタリア産のレザーだから
  // イタリア製」のように、ブランドが生まれた国・素材の産地と、この
  // 個体が実際に作られた国は別の事実。実データには製造国を確認できる
  // 項目が無い(ZAICO_ATTRIBUTE_MAPに該当フィールドが無い)ため、
  // 「〜製」「製造国は〜」「原産国は〜」の形の国名主張は、その国名が
  // 事実コーパスへ**完成品(個体)の製造国そのものとして**明示されている
  // 場合(担当者が備考等へ「製造国は〜」「〜製」と明記した場合)だけ
  // 裏付けありとみなす。
  //
  // 国名が事実コーパスに単独で出ているだけ(「イタリアのブランド」
  // 「イタリア産」)では裏付けにしない —— factsText.includes(country) の
  // ような単純一致だと、ブランドの本国・素材の産地の言及にまで製造国の
  // 裏付けが成立してしまい、報告された「イタリアのブランド→イタリア製」
  // の誤承認を防げない。
  //
  // 2026-09-12 QAレビュー指摘: 「イタリア製レザーを使用」「脚はイタリア製」
  // のように部材・素材だけを指す記述も、上と同じ理由で完成品全体の製造国
  // の主張・裏付けのどちらにも使わない(isPartOrMaterialScopedAt)。
  //
  // facts側の記述が否定(「イタリア製ではない」)・不明(「製造国は不明」)・
  // 推測(「イタリア製と思われる」)を述べている場合も、裏付けにはしない
  // (肯定として読み替えない)。
  for (const country of COUNTRY_NAMES) {
    const re = manufactureCountryClaimPattern(country);
    let claimed = false;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const matchEnd = m.index + m[0].length;
      // 出力側が否定・保留・推測(「イタリア製ではない」「不明」
      // 「おそらくイタリア製」)を述べているだけなら、そもそも完成品の
      // 製造国を断定していないので検査対象にしない。
      if (isNegatedOrUnknownAt(text, m.index, matchEnd)) continue;
      // 「イタリア製レザー」「脚はイタリア製」のように部材・素材だけを
      // 指す記述は、完成品全体の製造国の主張にしない。
      if (isPartOrMaterialScopedAt(text, m.index, matchEnd)) continue;
      claimed = true;
      break;
    }
    if (claimed && !factsAssertManufactureCountry(factsText, country)) {
      violations.push({
        code: "UNSUPPORTED_COUNTRY_CLAIM",
        detail: `事実として確認できていない製造国の記述があります: ${country}（ブランドの国・素材の産地・部材の製造国と、完成品(個体)の製造国は別の情報です）`,
      });
      break;
    }
  }

  // ── 個人情報 ─────────────────────────────────────────────────────
  if (looksLikePersonalData(output)) {
    violations.push({ code: "PERSONAL_DATA", detail: "住所・電話番号らしき記述が含まれています。" });
  }

  // 個人名。商品名の`【…】`に「林田様確定」「伊藤様」「井口へ売却」のような
  // 取引先・顧客の氏名が入っている実データがあり(実測300件中に複数)、
  // 事実として渡ってしまうと顧客向けの文章へ出得る。敬称付きの人名は
  // 商品説明に登場する理由が無いので、出たら不合格にする。
  //
  // 敬称の直前が「漢字/カタカナ2〜4文字」の場合だけを人名とみなす。
  // これで「お客様」「皆様」「奥様」のような一般語は自然に外れる ——
  // それらは敬称の直前が1文字(客/皆/奥)しかないため。
  const personName = /[一-龥ァ-ヶ]{2,4}\s*(?:様|さん)/.exec(output);
  if (personName) {
    violations.push({ code: "PERSON_NAME", detail: `個人名らしき記述が含まれています: ${JSON.stringify(personName[0])}` });
  }

  // ── 事実に無い金額の主張 ─────────────────────────────────────────
  // 説明文中の価格は、出品情報側の価格と食い違う原因になる。事実として
  // 渡していない金額が出ていれば不合格にする(渡している場合は通す)。
  const priceMatches = [...text.matchAll(/\d[\d,]*\s*円/g)].map((m) => m[0].replace(/\s/g, ""));
  const unsupportedPrice = priceMatches.find((p) => !normalizeForMatch(factsText).replace(/\s/g, "").includes(p));
  if (unsupportedPrice) {
    violations.push({ code: "PRICE_CLAIM", detail: `事実として渡していない金額が含まれています: ${unsupportedPrice}` });
  }

  // ── 定型セクションへの侵食 ───────────────────────────────────────
  const heading = containsSectionHeading(output);
  if (heading) {
    violations.push({ code: "SECTION_HEADING_CONTAMINATION", detail: `商品紹介以外の定型セクション見出しが含まれています: ${heading}` });
  }

  // ── プロンプト自体の漏れ ─────────────────────────────────────────
  const promptLeakPatterns = [
    /厳守事項/, /system\s*prompt/i, /あなたはBELLO/, /上記の(?:事実|情報)(?:だけ|のみ)/,
    /与えられ(?:た|ていない)事実/, /出力は.*(?:ツール|構造化データ)/,
  ];
  for (const re of promptLeakPatterns) {
    const m = re.exec(output);
    if (m) {
      violations.push({ code: "PROMPT_LEAKAGE", detail: `プロンプトの指示文が出力に混入しています: ${JSON.stringify(m[0])}` });
      break;
    }
  }

  // ── 同一文の繰り返し ─────────────────────────────────────────────
  const sentences = output
    .split(/[。\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 10);
  const seen = new Map<string, number>();
  for (const s of sentences) seen.set(s, (seen.get(s) ?? 0) + 1);
  const repeated = [...seen.entries()].find(([, n]) => n >= 3);
  if (repeated) {
    violations.push({ code: "EXCESSIVE_REPETITION", detail: `同じ文が${repeated[1]}回繰り返されています。` });
  }

  return { ok: violations.length === 0, violations };
}

/** 管理者向けに、違反内容を1行へまとめる(ログ・デバッグ表示用)。顧客には出さない。 */
export function describeViolations(violations: FactSafetyViolation[]): string {
  return violations.map((v) => `${v.code}: ${v.detail}`).join(" / ");
}
