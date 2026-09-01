/**
 * §11 問い合わせの種別判定。純粋関数のみ。
 *
 * 【なぜLLMに分類させないか】種別は「どの情報源を引くか」を決めるためだけに
 * 使う。送料の質問なら既存のらくらく家財DBを引き、営業時間ならナレッジを
 * 引く —— この分岐が確率的に揺れると、同じ問い合わせで毎回違う情報源を
 * 参照することになり、原因の追えない品質ばらつきになる。決定的な
 * キーワード判定なら、外した場合に「この語を足す」で確実に直せる。
 *
 * 判定は多重ラベル。「サイズと送料を教えてください」は SIZE と SHIPPING の
 * 両方になる。
 */
import type { InquiryIntent } from "./types";

/**
 * 各intentを示すキーワード。
 *
 * 表記ゆれ(漢字/ひらがな/カタカナ)は実際の日本語の問い合わせで普通に
 * 起きるため、代表的な形を並べる。正規表現ではなく単純な部分一致に
 * しているのは、後から運用者が語を足しやすくするため。
 */
const INTENT_KEYWORDS: { intent: InquiryIntent; keywords: string[] }[] = [
  {
    intent: "SHIPPING",
    keywords: ["送料", "配送料", "配送費", "送付料", "運賃", "発送料", "家財便", "らくらく家財", "配送ランク", "送料込", "送料別"],
  },
  {
    intent: "DELIVERY",
    keywords: ["配送", "発送", "納品", "搬入", "お届け", "届け", "配達", "何日", "いつ届", "日時指定", "設置"],
  },
  { intent: "SIZE", keywords: ["サイズ", "寸法", "大きさ", "幅", "奥行", "高さ", "全長", "何センチ", "cm", "ｃｍ", "横幅", "座面高"] },
  { intent: "MATERIAL", keywords: ["素材", "材質", "生地", "張地", "革", "レザー", "布", "ファブリック", "木製", "無垢"] },
  { intent: "PRODUCT_CONDITION", keywords: ["状態", "コンディション", "傷", "汚れ", "使用感", "damage", "ダメージ", "きれい", "劣化", "破れ"] },
  { intent: "COMPATIBILITY", keywords: ["適合", "合いますか", "使えますか", "対応", "互換", "組み合わせ", "スタッキング", "積み重ね", "取り付け", "交換できま"] },
  { intent: "STOCK", keywords: ["在庫", "まだあり", "売り切れ", "完売", "残って", "購入できま", "販売中"] },
  { intent: "PRICE", keywords: ["価格", "値段", "いくら", "金額", "税込", "税抜", "お値段"] },
  { intent: "NEGOTIATION", keywords: ["値引き", "値下げ", "おまけ", "安く", "割引", "交渉", "まけて"] },
  { intent: "RETURN_POLICY", keywords: ["返品", "キャンセル", "返金", "保証", "アフター"] },
  { intent: "BUSINESS_HOURS", keywords: ["営業時間", "何時から", "何時まで", "定休", "営業日", "やってま"] },
  { intent: "STORE_INFO", keywords: ["住所", "所在地", "場所", "どこにあり", "アクセス", "店舗", "お店"] },
  { intent: "VISIT", keywords: ["来店", "見に行", "実物", "内覧", "下見", "伺い", "訪問"] },
  { intent: "PRODUCT_SPEC", keywords: ["仕様", "スペック", "耐荷重", "重量", "重さ", "型番", "品番", "電球", "口金", "消費電力", "何人掛け", "色", "カラー"] },
];

/**
 * 問い合わせ本文から種別を判定する。
 *
 * 何にも当たらなければ OTHER 単独。OTHERを他の種別と併記しないのは、
 * 「その他」が付いていることが後段の分岐を一切変えないため —— 意味の
 * 無いラベルを増やすとUIのノイズになるだけ。
 */
export function extractIntents(text: string): InquiryIntent[] {
  const normalized = normalizeForIntent(text);
  const hits: InquiryIntent[] = [];
  for (const { intent, keywords } of INTENT_KEYWORDS) {
    if (keywords.some((k) => normalized.includes(normalizeForIntent(k)))) hits.push(intent);
  }
  return hits.length > 0 ? hits : ["OTHER"];
}

/**
 * 商品を特定しないと答えられない種別か(§4.4)。
 *
 * 営業時間・住所・来店方法は商品が分からなくても答えられる。一方、
 * サイズ・素材・状態・在庫・価格・送料は商品固有なので、商品が
 * 特定できていなければ「商品特定が必要」として扱う。
 */
const PRODUCT_DEPENDENT: ReadonlySet<InquiryIntent> = new Set<InquiryIntent>([
  "PRODUCT_SPEC",
  "PRODUCT_CONDITION",
  "SIZE",
  "MATERIAL",
  "COMPATIBILITY",
  "STOCK",
  "PRICE",
  "SHIPPING",
  "NEGOTIATION",
]);

export function requiresProduct(intents: InquiryIntent[]): boolean {
  return intents.some((i) => PRODUCT_DEPENDENT.has(i));
}

/** 商品が無くても答えられる種別を1つでも含むか。 */
export function hasProductIndependentIntent(intents: InquiryIntent[]): boolean {
  return intents.some((i) => !PRODUCT_DEPENDENT.has(i));
}

/**
 * 全角英数字を半角へ、大文字を小文字へ寄せる。
 * 「ＣＭ」「Cm」「cm」を同じものとして扱うため。
 */
function normalizeForIntent(text: string): string {
  return text
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase();
}
