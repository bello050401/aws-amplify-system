/**
 * §4.1/§35 問い合わせ本文から「どの商品の話か」の手がかりを取り出す。
 *
 * 純粋関数のみ(server-onlyではない) —— DBにも外部にも触らない。
 * ここで取り出すのは**候補**であって、商品の確定はproductResolver.tsが行う。
 *
 * 【設計方針】取りこぼしより誤検出のほうが害が大きい、とは限らない。
 * ここでの誤検出は「照合しても在庫に一致しない」で終わり、実害が無い。
 * 逆に取りこぼすと商品が特定できず返信案の質が落ちる。そのため抽出は
 * やや広めに取り、確からしさの判断は照合側(スコアリング)へ委ねる。
 */

/** BASEのショップURLに使われるホスト。BASE公式が案内している2形式。 */
const BASE_HOSTS = [".base.shop", ".thebase.in", ".base.ec"];

/** URL末尾に紛れ込みやすい閉じ括弧・句読点。URLの一部ではない。 */
const URL_TRAILING_JUNK = /[)）」』】>＞。、,.！!？?"']+$/;

/**
 * URLを取り出す。
 *
 * 【「URL以外の文字が来るまで」で切らない理由】日本語の文では
 * `https://example.com/items/1）を見ました。` のようにURLの直後へ
 * そのまま文が続く。「空白か記号まで」で切ると本文まで巻き込み、
 * 末尾の句読点だけを落としても「）を見ました」が残ってしまう
 * (実際にそうなった)。RFC 3986がURLに許す文字だけを取り込み、
 * 日本語文字が現れた時点で終わりにする。
 */
const URL_CHARS = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;

export function extractUrls(text: string): string[] {
  const found = text.match(URL_CHARS) ?? [];
  const cleaned = found.map((u) => u.replace(URL_TRAILING_JUNK, "")).filter((u) => u.length > "https://".length);
  return unique(cleaned);
}

export function isBaseUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return BASE_HOSTS.some((suffix) => host.endsWith(suffix));
}

/**
 * BASEの商品URLから商品IDを取り出す。
 *
 * BASEの商品ページは `https://<shop>.base.shop/items/<数字>` の形。
 * ホストがBASEでない限りIDとして採用しない —— 他のECサイトも
 * `/items/<数字>` を使うため、ホストを見ずに拾うと別サイトの商品IDを
 * BASEのIDだと誤認する。
 */
export function extractBaseItemId(url: string): string | null {
  if (!isBaseUrl(url)) return null;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = pathname.match(/\/items\/(\d{1,20})(?:\/|$)/);
  return m ? m[1] : null;
}

/**
 * URLを比較可能な形へ正規化する。
 *
 * 実際の問い合わせでは、同じ商品ページのURLが末尾スラッシュの有無・
 * httpとhttps・`?utm_source=...`のような計測用クエリの有無で違う文字列に
 * なる。そのまま文字列比較すると同じページを別物として扱ってしまう。
 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.protocol = "https:";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    u.hash = "";
    u.search = "";
    u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * BELLOのSKU(B + 6桁)。
 *
 * 前後が英数字でないことを要求する —— 「AB000123」のような無関係の
 * 文字列の一部を拾わないため。
 */
export function extractSkus(text: string): string[] {
  const found = text.match(/(?<![0-9A-Za-z])B\d{6}(?![0-9A-Za-z])/g) ?? [];
  return unique(found.map((s) => s.toUpperCase()));
}

/**
 * ZAICO由来の表示用在庫ID(8桁の数字)。
 *
 * 「在庫ID」「商品番号」等のラベルが前にある場合と、単独で現れる場合の
 * 両方を拾う。単独の8桁数字は電話番号・郵便番号・金額とは桁数が違う
 * ため実用上ぶつかりにくいが、確信度は照合側で下げて扱う。
 */
export function extractInventoryIds(text: string): string[] {
  const ids: string[] = [];
  const labelled = text.matchAll(/(?:在庫\s*(?:ID|番号)|商品\s*(?:ID|番号|コード)|管理\s*番号)\s*[:：#＃]?\s*([0-9]{4,12})/gi);
  for (const m of labelled) ids.push(m[1]);
  const bare = text.match(/(?<![0-9A-Za-z-])[0-9]{8}(?![0-9A-Za-z-])/g) ?? [];
  ids.push(...bare);
  return unique(ids);
}

/**
 * 型番らしき文字列。
 *
 * 実在庫の商品名から確認できた形(例: "SS226B", "PH-5", "CH24")に合わせ、
 * 「英字と数字が混ざった2〜20文字のトークン」を型番候補とする。
 * 日本語の文中でも `型番` `モデル` `品番` というラベルの直後は優先的に拾う。
 *
 * 純粋な数字だけ・純粋な英字だけは型番として扱わない —— それぞれ
 * 金額・寸法や普通の英単語と衝突するため。
 */
export function extractModelNumbers(text: string): string[] {
  const out: string[] = [];
  const labelled = text.matchAll(/(?:型番|品番|モデル(?:番号)?|model)\s*[:：#＃]?\s*([0-9A-Za-z][0-9A-Za-z\-/.]{1,19})/gi);
  for (const m of labelled) out.push(m[1]);

  for (const token of text.split(/[\s　、,。「」『』()（）\[\]【】:：;；]+/)) {
    const t = token.replace(/^[-/.]+|[-/.]+$/g, "");
    if (t.length < 2 || t.length > 20) continue;
    if (!/^[0-9A-Za-z][0-9A-Za-z\-/.]*$/.test(t)) continue;
    if (!/[A-Za-z]/.test(t) || !/[0-9]/.test(t)) continue;
    // "10cm" "3人掛け" のような単位付き数値は型番ではない。
    if (/^\d+(?:\.\d+)?(?:cm|mm|m|kg|g|w|v|a|inch|in)$/i.test(t)) continue;
    out.push(t);
  }
  return unique(out.map((t) => t.toUpperCase()));
}

/**
 * 既知ブランド名の出現。
 *
 * 独自にブランド辞書を作らず、既存のlib/ai/productIntro/factSafety.tsの
 * KNOWN_FURNITURE_BRANDSをそのまま使う —— 同じブランド名の一覧を2箇所で
 * 持つと、片方だけ更新されて挙動が食い違う。
 */
export function extractBrandNames(text: string, knownBrands: readonly string[]): string[] {
  const out: string[] = [];
  for (const brand of knownBrands) {
    if (containsBrand(text, brand)) out.push(brand);
  }
  return unique(out);
}

/**
 * ブランド名が含まれるか。英字ブランドは前後が英数字でないことを要求する
 * ("HAY"が"highway"にヒットするのを避ける) —— factSafety.tsと同じ判定。
 * 日本語のブランド名は単語境界の概念が無いため単純な部分一致で見る。
 */
/** 正規表現のメタ文字を無効化する。ブランド名に "&" や "-" が含まれるため必要。 */
export function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsBrand(text: string, brand: string): boolean {
  if (/^[\x20-\x7E]+$/.test(brand)) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(brand)}([^a-z0-9]|$)`, "i");
    return re.test(text);
  }
  return text.includes(brand);
}

/** 商品名の断片になりうる語。助詞・定型句を落として2文字以上の語だけ残す。 */
const STOP_WORDS = new Set([
  "こちら", "この", "その", "あの", "商品", "こと", "もの", "ください", "お願い", "いたし", "ます", "です",
  "教えて", "いただけ", "でしょうか", "ますか", "ですか", "について", "サイズ", "送料", "在庫", "価格", "値段",
  "営業", "時間", "住所", "場所", "どこ", "いくら", "問い合わせ", "よろしく", "お世話", "はじめまして",
]);

/**
 * 商品名の一部になりそうな語を取り出す。
 *
 * 形態素解析器は導入しない(§8「過剰なRAG基盤を作らない」と同じ判断 ——
 * 依存を増やすだけの価値がまだ無い)。代わりに、日本語の文からは
 * カタカナ・漢字の連続を、英数字混じりの語はそのまま取り出す。
 * 精度は照合側のスコアで吸収する。
 */
export function extractProductNameFragments(text: string): string[] {
  const out: string[] = [];
  // 全角/半角の英数字語(ブランド名・シリーズ名が該当しやすい)
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9&'\-]{1,29}/g)) out.push(m[0]);
  // カタカナ語(3文字以上 — 「ソファ」「テーブル」「チェア」等)
  for (const m of text.matchAll(/[ァ-ヴー]{3,20}/g)) out.push(m[0]);
  // 漢字語(2文字以上 — 「照明」「家具」「木製」等)
  for (const m of text.matchAll(/[\u4E00-\u9FFF]{2,10}/g)) out.push(m[0]);
  return unique(out.filter((w) => !STOP_WORDS.has(w)));
}

/**
 * 問い合わせ本文からすべての手がかりを取り出す。
 *
 * knownBrandsを引数で受け取るのは、このファイルをfactSafety.tsから
 * 独立させておくため(テストからブランド一覧を差し替えられる)。
 */
export function extractProductReferences(text: string, knownBrands: readonly string[]): ProductReferenceResult {
  const urls = extractUrls(text);
  const baseUrls = urls.filter(isBaseUrl);
  const baseItemIds = unique(baseUrls.map(extractBaseItemId).filter((v): v is string => v !== null));
  return {
    urls,
    baseUrls,
    baseItemIds,
    skus: extractSkus(text),
    inventoryIds: extractInventoryIds(text),
    modelNumbers: extractModelNumbers(text),
    brandNames: extractBrandNames(text, knownBrands),
    productNameFragments: extractProductNameFragments(text),
  };
}

export type ProductReferenceResult = {
  urls: string[];
  baseUrls: string[];
  baseItemIds: string[];
  skus: string[];
  inventoryIds: string[];
  modelNumbers: string[];
  brandNames: string[];
  productNameFragments: string[];
};

/** 手がかりが1つも無いか(= 商品を指していない問い合わせ)。 */
export function hasNoProductReference(ref: ProductReferenceResult): boolean {
  return (
    ref.baseItemIds.length === 0 &&
    ref.skus.length === 0 &&
    ref.inventoryIds.length === 0 &&
    ref.modelNumbers.length === 0 &&
    ref.brandNames.length === 0 &&
    ref.urls.length === 0 &&
    ref.productNameFragments.length === 0
  );
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
