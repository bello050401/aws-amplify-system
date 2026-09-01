/**
 * §10 送料の問い合わせ。純粋関数のみ。
 *
 * 【最重要の制約】新しい送料マスタを作らない。金額は必ず既存の
 * lib/shipping(ShippingRateモデル / 家財おまかせ便)から引く。ここが
 * するのは「どこ宛か」を本文から読み取ることと、「何が足りないか」を
 * 決めることだけで、金額の計算・保持は一切しない。
 *
 * 【勝手に推測しない】「大阪まで」だけでは市区町村が分からない。
 * 既存のShippingRateマスタは都道府県+ランクで引ける設計なので都道府県が
 * 分かれば概算は出せるが、それを確定額として案内すると実際の請求と
 * 食い違いうる。そのため「参考額」と「確認が必要」を明確に分ける。
 */
import { JAPAN_PREFECTURES } from "@/lib/shipping/prefectures";

/** 都道府県名の省略形 → 正式名。「大阪まで」「東京へ」と書かれるのが普通。 */
const PREFECTURE_ALIASES: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const full of JAPAN_PREFECTURES) {
    map[full] = full;
    const short = full.replace(/[都道府県]$/, "");
    // 「東京」「大阪」「北海道」など。北海道は末尾を落とすと「北海」になり
    // 誤りなので、3文字以上残る場合だけ短縮形を登録する。
    if (short.length >= 2 && short !== full) map[short] = full;
  }
  return map;
})();

/** 主要都市 → 都道府県。「札幌まで」「博多まで」と書かれることがある。 */
const CITY_TO_PREFECTURE: Record<string, string> = {
  札幌: "北海道", 仙台: "宮城県", さいたま: "埼玉県", 横浜: "神奈川県", 川崎: "神奈川県",
  名古屋: "愛知県", 京都: "京都府", 大阪市: "大阪府", 神戸: "兵庫県", 広島市: "広島県",
  福岡: "福岡県", 博多: "福岡県", 那覇: "沖縄県", 新宿: "東京都", 渋谷: "東京都",
};

export interface ShippingDestination {
  prefecture: string | null;
  /** 本文から読み取れた、より細かい地名(市区町村)。マスタは都道府県単位なので参考情報。 */
  cityHint: string | null;
  /** どの語から判断したか(管理画面向け)。 */
  matchedText: string | null;
}

/**
 * 本文から配送先を読み取る。
 *
 * 発送元(埼玉県)は固定なので、本文に「埼玉」とあっても発送先とは限らない
 * ——ただしここでは判別できないため、そのまま候補として返し、
 * 「本当に埼玉宛か」の判断は人に委ねる(返信案では確認を促す)。
 */
export function extractShippingDestination(text: string): ShippingDestination {
  // 「〜まで」「〜へ」「〜に送」の直前にある地名を優先して探す。
  const directed = text.match(/([\u4E00-\u9FFF\u30A0-\u30FFぁ-ん]{2,8})\s*(?:まで|へ|に(?:送|発送|配送|届))/);
  if (directed) {
    const resolved = resolvePlace(directed[1]);
    if (resolved) return { ...resolved, matchedText: directed[0] };
  }
  // 指示語が無い場合は、本文中の都道府県名をそのまま探す。
  for (const [alias, full] of Object.entries(PREFECTURE_ALIASES)) {
    if (alias.length >= 2 && text.includes(alias)) {
      return { prefecture: full, cityHint: null, matchedText: alias };
    }
  }
  for (const [city, full] of Object.entries(CITY_TO_PREFECTURE)) {
    if (text.includes(city)) return { prefecture: full, cityHint: city, matchedText: city };
  }
  return { prefecture: null, cityHint: null, matchedText: null };
}

function resolvePlace(raw: string): { prefecture: string; cityHint: string | null } | null {
  const trimmed = raw.trim();
  if (PREFECTURE_ALIASES[trimmed]) return { prefecture: PREFECTURE_ALIASES[trimmed], cityHint: null };
  if (CITY_TO_PREFECTURE[trimmed]) return { prefecture: CITY_TO_PREFECTURE[trimmed], cityHint: trimmed };
  // 「大阪府吹田市」のように都道府県+市区町村が続けて書かれている場合。
  for (const [alias, full] of Object.entries(PREFECTURE_ALIASES)) {
    if (alias.length >= 2 && trimmed.startsWith(alias)) {
      const rest = trimmed.slice(alias.length);
      return { prefecture: full, cityHint: rest.length > 0 ? rest : null };
    }
  }
  return null;
}

/**
 * 送料を案内するために足りない情報。
 *
 * §10.3「配送先が足りない場合、勝手に推測しない」。市区町村を尋ねるのは、
 * 実際の家財おまかせ便の見積りが市区町村まで要るため —— 都道府県だけで
 * 出した額を確定額として伝えると、後で食い違う。
 */
export function missingShippingInfo(params: {
  productResolved: boolean;
  destinationPrefecture: string | null;
  cityHint: string | null;
  hasDimensions: boolean;
}): string[] {
  const missing: string[] = [];
  if (!params.productResolved) missing.push("対象商品");
  if (!params.destinationPrefecture) missing.push("お届け先の都道府県");
  else if (!params.cityHint) missing.push("お届け先の市区町村");
  if (params.productResolved && !params.hasDimensions) missing.push("商品の寸法(社内で確認が必要)");
  return missing;
}

/** 顧客へ尋ねる文面の素材(そのまま送るのではなく、AIが自然な文へ組み込む)。 */
export function customerFacingShippingQuestions(missing: string[]): string[] {
  const questions: string[] = [];
  if (missing.includes("お届け先の都道府県") || missing.includes("お届け先の市区町村")) {
    questions.push("正確な送料を確認するため、お届け先の市区町村をお知らせいただきたい");
  }
  if (missing.includes("対象商品")) {
    questions.push("どの商品についてのお問い合わせかを確認したい");
  }
  return questions;
}
