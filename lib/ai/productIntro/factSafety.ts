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
  | "PERSONAL_DATA"
  | "PERSON_NAME"
  | "PRICE_CLAIM"
  | "SECTION_HEADING_CONTAMINATION"
  | "PROMPT_LEAKAGE"
  | "EMPTY_OUTPUT"
  | "TOO_LONG"
  | "EXCESSIVE_REPETITION";

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
export const KNOWN_FURNITURE_BRANDS = [
  "HAY", "Muuto", "ムート", "ムーート", "BoConcept", "ボーコンセプト",
  "vitra", "Vitra", "ヴィトラ", "ビトラ",
  "Cassina", "カッシーナ", "USM", "Artek", "アルテック",
  "Fritz Hansen", "フリッツハンセン", "Herman Miller", "ハーマンミラー",
  "Knoll", "ノル", "Carl Hansen", "カールハンセン", "&Tradition", "アンドトラディション",
  "Louis Poulsen", "ルイスポールセン", "Flos", "フロス", "Kartell", "カルテル",
  "B&B Italia", "Minotti", "ミノッティ", "Poliform", "NATUZZI", "ナツッジ",
  "IKEA", "イケア", "無印良品", "MUJI", "Karimoku", "カリモク",
  "天童木工", "マルニ", "MARUNI", "yamagiwa", "ヤマギワ",
  "Arflex", "アルフレックス", "Ligne Roset", "リーンロゼ", "Time & Style",
] as const;

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
}): FactSafetyResult {
  const violations: FactSafetyViolation[] = [];
  const output = params.output ?? "";
  const text = normalizeForMatch(output);
  const factsText = normalizeForMatch(
    [params.facts.name, params.facts.dimensions, params.facts.categoryName, params.facts.conditionDisclosure, params.facts.publicNote]
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
  const invented = KNOWN_FURNITURE_BRANDS.filter((b) => mentionsBrand(output, b) && !mentionsBrand(factsText, b));
  if (invented.length > 0) {
    violations.push({
      code: "UNSUPPORTED_BRAND",
      detail: `商品の事実に含まれないブランド名が出ています: ${invented.join(", ")}`,
    });
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
