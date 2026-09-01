/**
 * §31/§33 値下げ交渉エンジンと配送希望日ルールの検証。
 * 外部サービスへは一切接続しない。
 *
 * Run with: npm run verify:negotiation
 *
 * ここで固定したいこと:
 *
 *  1. 7%引き・全国中央値・地域補正を**コードが**決めること（Novaに
 *     金額を考えさせない）。
 *  2. どれか1つでも欠けたら金額を作らないこと。「たぶんこれくらい」は
 *     顧客への提示になってしまう。
 *  3. 14日の境界。14日は対応可能、15日は人間判断 —— ここが1日ずれると
 *     業務ルールそのものが変わる。
 *  4. 仕入価格・販売開始日時が顧客向けの事実へ混ざらないこと。
 */
import {
  BASE_DISCOUNT_RATE,
  buildDiscountOffer,
  calculateBaseDiscountedPrice,
  calculateShippingAdjustment,
  customerSafeDiscountFacts,
  daysOnSale,
  detectDiscountIntent,
  nationalMedianShipping,
} from "@/lib/inquiry/discount";
import {
  calendarDaysBetween,
  detectDeliveryDateIntent,
  evaluateDeliveryWindow,
  extractRequestedDeliveryDate,
  STANDARD_DELIVERY_WINDOW_DAYS,
} from "@/lib/inquiry/deliveryWindow";
import {
  buildKeigoSystemPrompt,
  buildKeigoUserPrompt,
  checkKeigoFidelity,
  detectAmbiguity,
  isFirstOutgoingReply,
} from "@/lib/inquiry/keigo";
import type { ShippingRateRecord } from "@/lib/shipping/types";

let failures = 0;
let passes = 0;

function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ FAIL ${label}\n    expected: ${e}\n    actual:   ${a}`);
  } else {
    passes++;
    console.log(`✓ ${label}`);
  }
}

function assertTrue(cond: boolean, label: string) {
  assertEqual(cond, true, label);
}

function rate(prefecture: string, rank: string, price: number | null, extra: Partial<ShippingRateRecord> = {}): ShippingRateRecord {
  return {
    id: `${prefecture}-${rank}`,
    provider: "アートセッティングデリバリー",
    service: "家財おまかせ便",
    originPrefecture: "埼玉県",
    originArea: null,
    destinationPrefecture: prefecture,
    destinationArea: null,
    rank: rank as ShippingRateRecord["rank"],
    price,
    taxIncluded: true,
    currency: "JPY",
    surcharge: null,
    effectiveFrom: null,
    effectiveTo: null,
    sourceReference: null,
    acquiredAt: null,
    verifiedAt: null,
    status: null,
    rawHash: null,
    importBatchId: null,
    version: 1,
    createdBy: null,
    updatedBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

// ── §9.1 値下げ交渉の検出 ────────────────────────────────────────

function testDiscountIntent() {
  for (const text of [
    "値下げできますか",
    "お安くなりますか",
    "いくらまで下がりますか",
    "即決なら安くなりますか",
    "振込なら安くできますか",
    "LINEなら安くなりますか",
    "価格交渉できますか",
    "もう少しまけてもらえませんか",
  ]) {
    assertTrue(detectDiscountIntent(text), `値下げ意図: 「${text}」を交渉として検出する`);
  }

  assertTrue(!detectDiscountIntent("価格はいくらですか"), "値下げ意図: 単なる価格質問は交渉としない");
  assertTrue(!detectDiscountIntent("お値段はいくらでしょうか"), "値下げ意図: 「お値段はいくら」も交渉としない");
  assertTrue(!detectDiscountIntent("サイズを教えてください"), "値下げ意図: 無関係な問い合わせを拾わない");
}

// ── §9.2 7%引き ─────────────────────────────────────────────────

function testBaseDiscount() {
  assertEqual(BASE_DISCOUNT_RATE, 0.07, "7%引き: 基本値引き率は7%");
  assertEqual(calculateBaseDiscountedPrice(100_000), 93_000, "7%引き: 100,000円 → 93,000円");
  assertEqual(calculateBaseDiscountedPrice(38_500), 35_805, "7%引き: 端数は既存の値下げと同じくMath.floorで丸める");
  assertEqual(calculateBaseDiscountedPrice(1), 0, "7%引き: 極小額でも例外を作らない");
}

// ── §11.1 全国送料中央値 ───────────────────────────────────────

function testNationalMedian() {
  const odd = [rate("東京都", "B", 8000), rate("大阪府", "B", 9000), rate("福岡県", "B", 12000)];
  assertEqual(nationalMedianShipping(odd, "B"), 9000, "中央値: 奇数件は真ん中の値");

  const even = [rate("東京都", "B", 8000), rate("大阪府", "B", 9000), rate("福岡県", "B", 11000), rate("北海道", "B", 15000)];
  assertEqual(nationalMedianShipping(even, "B"), 10000, "中央値: 偶数件は中央2つの平均");

  const withMissing = [...odd, rate("沖縄県", "B", null)];
  assertEqual(nationalMedianShipping(withMissing, "B"), 9000, "中央値: 金額が無い行は母集団から除く");

  const withUnavailable = [...odd, rate("沖縄県", "B", 30000, { status: "UNAVAILABLE" })];
  assertEqual(nationalMedianShipping(withUnavailable, "B"), 9000, "中央値: 配送不可の行は母集団から除く");

  const withZero = [...odd, rate("島根県", "B", 0)];
  assertEqual(nationalMedianShipping(withZero, "B"), 9000, "中央値: 0円のような異常値は除く");

  const duplicated = [rate("東京都", "B", 8000), rate("東京都", "B", 20000, { version: 2 }), rate("大阪府", "B", 9000), rate("福岡県", "B", 12000)];
  assertEqual(nationalMedianShipping(duplicated, "B"), 12000, "中央値: 同一都道府県は version の新しい行だけを使う");

  const otherRank = [rate("東京都", "C", 5000), ...odd];
  assertEqual(nationalMedianShipping(otherRank, "C"), 5000, "中央値: ランクごとに別々に計算する");
  assertEqual(nationalMedianShipping(odd, "G"), null, "中央値: その ランクの行が無ければnull");
}

// ── §11.2 地域補正と参考提示額 ─────────────────────────────────

function offer(overrides: Partial<Parameters<typeof buildDiscountOffer>[0]> = {}) {
  return buildDiscountOffer({
    productResolved: true,
    salePrice: 100_000,
    shippingRank: "B",
    destinationPrefecture: "東京都",
    destinationShipping: 8_000,
    nationalMedian: 8_000,
    ...overrides,
  });
}

function testDiscountOffer() {
  // 仕様書§31にある3件をそのまま固定する。
  assertEqual(offer().referenceOffer, 93_000, "提示額: 100,000円 / 中央値8,000 / 配送先8,000 → 93,000円");
  assertEqual(offer({ destinationShipping: 15_000 }).referenceOffer, 100_000, "提示額: 配送先15,000（中央値+7,000）→ 100,000円");
  assertEqual(offer({ destinationShipping: 6_000 }).referenceOffer, 93_000, "提示額: 配送先が中央値より安くても追加値引きしない");

  assertEqual(calculateShippingAdjustment(6_000, 8_000), 0, "地域補正: 中央値以下なら補正0");
  assertEqual(calculateShippingAdjustment(15_000, 8_000), 7_000, "地域補正: 差額だけを戻す");

  const noShipping = offer({ destinationShipping: null });
  assertTrue(!noShipping.determined, "未確定: 送料不明なら提示額を作らない");
  assertEqual(noShipping.referenceOffer, null, "未確定: 送料不明で金額を創作しない");
  assertTrue(noShipping.undeterminedReasons.includes("DESTINATION_RATE_UNKNOWN"), "未確定: 理由を返す（送料不明）");

  const noPrice = offer({ salePrice: null });
  assertTrue(!noPrice.determined && noPrice.referenceOffer === null, "未確定: 商品価格不明なら金額生成なし");
  assertEqual(noPrice.baseDiscountedPrice, null, "未確定: 価格が無ければ7%引きも出さない");

  const noProduct = offer({ productResolved: false });
  assertTrue(!noProduct.determined && noProduct.referenceOffer === null, "未確定: 商品未特定なら金額生成なし");

  const noDestination = offer({ destinationPrefecture: null, destinationShipping: null });
  assertTrue(noDestination.undeterminedReasons.includes("DESTINATION_UNKNOWN"), "未確定: 配送先不明を理由として返す");
  assertEqual(noDestination.baseDiscountedPrice, 93_000, "未確定: 配送先が無くても7%引きの内部計算自体は持つ（スタッフ表示用）");

  const noMedian = offer({ nationalMedian: null });
  assertTrue(noMedian.undeterminedReasons.includes("NATIONAL_MEDIAN_UNKNOWN"), "未確定: 中央値が出せない場合も理由を返す");
}

// ── §12.2 内部情報の境界 ───────────────────────────────────────

function testInternalBoundary() {
  const facts = customerSafeDiscountFacts(offer());
  const serialized = JSON.stringify(facts);
  assertTrue(serialized.includes("93,000"), "境界: 確定した提示額は顧客向け事実に含まれる");
  assertTrue(!serialized.includes("8,000") && !serialized.includes("8000"), "境界: 送料の内訳（中央値・配送先送料）は顧客向け事実に出さない");

  const undetermined = customerSafeDiscountFacts(offer({ destinationShipping: null }));
  assertEqual(undetermined, [], "境界: 提示額が未確定なら顧客向け事実は空（金額を作らない）");

  // 仕入価格・販売開始日時は customerSafeDiscountFacts が扱わない。
  // 型としても DiscountOffer に含まれないことをここで固定する。
  assertTrue(!("purchasePrice" in offer()), "境界: 仕入価格はDiscountOfferに含まれない");
  assertTrue(!("saleStartDate" in offer()), "境界: 販売開始日時はDiscountOfferに含まれない");
}

function testDaysOnSale() {
  const now = new Date("2026-09-01T12:00:00+09:00");
  assertEqual(daysOnSale("2026-08-01", now), 31, "経過日数: 日付のみの販売開始日を日本時間で数える");
  assertEqual(daysOnSale("2026-09-01T00:00:00+09:00", now), 0, "経過日数: 当日は0日");
  assertEqual(daysOnSale(null, now), null, "経過日数: 販売開始日が無ければnull");
  assertEqual(daysOnSale("2026-12-01", now), 0, "経過日数: 未来日は0（負数にしない）");
}

// ── §14 配送希望日 ─────────────────────────────────────────────

function testDeliveryWindow() {
  assertEqual(STANDARD_DELIVERY_WINDOW_DAYS, 14, "配送: 標準のお預かり期間は14日");

  const purchase = new Date("2026-09-01T10:00:00+09:00");
  const at = (days: number) => new Date(purchase.getTime() + days * 86_400_000);

  assertEqual(evaluateDeliveryWindow({ purchaseDate: purchase, requestedDeliveryDate: at(7) }).state, "WITHIN_STANDARD_WINDOW", "配送: 購入後7日 → 原則対応可能");
  assertEqual(evaluateDeliveryWindow({ purchaseDate: purchase, requestedDeliveryDate: at(13) }).state, "WITHIN_STANDARD_WINDOW", "配送: 購入後13日 → 原則対応可能");
  assertEqual(evaluateDeliveryWindow({ purchaseDate: purchase, requestedDeliveryDate: at(14) }).state, "WITHIN_STANDARD_WINDOW", "配送: 購入後14日 → 原則対応可能（境界）");
  assertEqual(evaluateDeliveryWindow({ purchaseDate: purchase, requestedDeliveryDate: at(15) }).state, "HUMAN_REVIEW_REQUIRED", "配送: 購入後15日 → 人間判断（境界）");
  assertEqual(evaluateDeliveryWindow({ purchaseDate: purchase, requestedDeliveryDate: at(21) }).state, "HUMAN_REVIEW_REQUIRED", "配送: 購入後21日 → 人間判断");

  assertEqual(evaluateDeliveryWindow({ purchaseDate: purchase, requestedDeliveryDate: null }).state, "DATE_INFO_REQUIRED", "配送: 希望日不明 → 確認する");
  assertEqual(evaluateDeliveryWindow({ purchaseDate: null, requestedDeliveryDate: at(7) }).state, "DATE_INFO_REQUIRED", "配送: 購入日不明 → 推測しない");
  assertEqual(evaluateDeliveryWindow({ purchaseDate: null, requestedDeliveryDate: null }).missing.length, 2, "配送: 足りない項目を両方返す");

  // 時刻ではなく暦日で数える。23:00購入 → 15日後09:00 は15日。
  const lateNight = new Date("2026-09-01T23:00:00+09:00");
  const earlyMorning = new Date("2026-09-16T09:00:00+09:00");
  assertEqual(calendarDaysBetween(lateNight, earlyMorning), 15, "配送: 日数は暦日で数える（時刻差で14日台に丸めない）");
  assertEqual(evaluateDeliveryWindow({ purchaseDate: lateNight, requestedDeliveryDate: earlyMorning }).state, "HUMAN_REVIEW_REQUIRED", "配送: 暦日15日は人間判断");

  assertEqual(evaluateDeliveryWindow({ purchaseDate: at(10), requestedDeliveryDate: purchase }).state, "HUMAN_REVIEW_REQUIRED", "配送: 過去日の希望も人間判断へ回す");
}

function testDeliveryDateExtraction() {
  const now = new Date("2026-09-01T12:00:00+09:00");

  assertEqual(extractRequestedDeliveryDate("9月20日に届けてほしい", now)?.toISOString(), new Date(Date.UTC(2026, 8, 20) - 9 * 3600_000).toISOString(), "日付抽出: 「9月20日」");
  assertEqual(extractRequestedDeliveryDate("2027年1月5日希望です", now)?.toISOString(), new Date(Date.UTC(2027, 0, 5) - 9 * 3600_000).toISOString(), "日付抽出: 年付き");
  assertEqual(extractRequestedDeliveryDate("3月10日でお願いします", now)?.getUTCFullYear(), 2027, "日付抽出: 既に過ぎた月日は翌年とみなす");
  assertEqual(extractRequestedDeliveryDate("10日後に届きますか", now)?.toISOString(), new Date(now.getTime() + 10 * 86_400_000).toISOString(), "日付抽出: 「10日後」");
  assertEqual(extractRequestedDeliveryDate("2週間後でお願いします", now)?.toISOString(), new Date(now.getTime() + 14 * 86_400_000).toISOString(), "日付抽出: 「2週間後」");

  // 幅のある表現は日付に確定させない（推測禁止）。
  assertEqual(extractRequestedDeliveryDate("1ヶ月後くらいに届けてほしい", now), null, "日付抽出: 「1ヶ月後」は日付として確定させない");
  assertEqual(extractRequestedDeliveryDate("来月あたりでお願いします", now), null, "日付抽出: 「来月あたり」は確定させない");
  assertEqual(extractRequestedDeliveryDate("なるべく早めに", now), null, "日付抽出: 曖昧な表現は確定させない");

  assertTrue(detectDeliveryDateIntent("配送希望日は指定できますか"), "配送意図: 配送希望日の質問を検出する");
  assertTrue(detectDeliveryDateIntent("いつ頃届きますか"), "配送意図: 到着時期の質問を検出する");
  assertTrue(detectDeliveryDateIntent("1ヶ月ほど預かってもらえますか"), "配送意図: お預かりの相談を検出する");
  assertTrue(!detectDeliveryDateIntent("サイズを教えてください"), "配送意図: 無関係な問い合わせを拾わない");
  assertTrue(!detectDeliveryDateIntent("営業時間は何時までですか"), "配送意図: 営業時間の質問を拾わない");
}


// ── §6/§29 敬語に整える ─────────────────────────────────────────

function keigo(original: string, rewritten: string, greeting?: string) {
  const r = checkKeigoFidelity({ original, rewritten, allowedGreeting: greeting });
  return { ok: r.ok, codes: r.violations.map((v) => v.code) };
}

function testKeigoFidelity() {
  assertTrue(
    keigo("明日発送できます。送料は確認します。", "明日発送させていただきます。送料につきましては確認のうえご連絡いたします。").ok,
    "敬語: 意味を変えない言い換えは通る",
  );

  // §29-3 未確定の送料を確定させない。
  const strengthened = keigo("明日発送できます。送料は確認します。", "明日発送いたします。送料は無料で対応できます。");
  assertTrue(!strengthened.ok, "敬語: 未確定の送料を確定として書いたら弾く");

  const amountAdded = keigo("送料は確認します。", "送料は5,000円でご案内いたします。");
  assertTrue(!amountAdded.ok && amountAdded.codes.includes("AMOUNT_ADDED"), "敬語: 原文に無い金額を足したら弾く");

  const dateAdded = keigo("発送日はお知らせします。", "9月15日に発送いたします。");
  assertTrue(!dateAdded.ok, "敬語: 原文に無い日付を足したら弾く");

  const measureAdded = keigo("サイズはご確認ください。", "幅120cmでございます。");
  assertTrue(!measureAdded.ok, "敬語: 原文に無い寸法を足したら弾く");

  const modelAdded = keigo("こちらの照明です。", "型番AW-0573の照明でございます。");
  assertTrue(!modelAdded.ok && modelAdded.codes.includes("MODEL_NUMBER_ADDED"), "敬語: 原文に無い型番を足したら弾く");

  const urlAdded = keigo("商品ページをご覧ください。", "商品ページ https://example.com/x をご覧ください。");
  assertTrue(!urlAdded.ok && urlAdded.codes.includes("URL_ADDED"), "敬語: 原文に無いURLを足したら弾く");

  // §6.2 約束を強めない。
  const promise = keigo("在庫を確認します。", "在庫はご用意できます。");
  assertTrue(!promise.ok && promise.codes.includes("PROMISE_STRENGTHENED"), "敬語: 「確認します」を「ご用意できます」へ強めたら弾く");

  const possibility = keigo("配送が遅れる可能性があります。", "配送は可能です。");
  assertTrue(!possibility.ok, "敬語: 「可能性があります」を「可能です」へ強めたら弾く");

  const flipped = keigo("お値引きはできません。", "お値引きできます。");
  assertTrue(!flipped.ok && flipped.codes.includes("NEGATION_FLIPPED"), "敬語: 否定を肯定へ反転したら弾く");

  // §29-4 原文にある数字・型番・金額はそのまま残ってよい。
  assertTrue(
    keigo("価格は38,500円です。型番はAW-0573です。", "価格は38,500円でございます。型番はAW-0573でございます。").ok,
    "敬語: 原文にある金額・型番はそのまま残せる",
  );

  assertTrue(!keigo("よろしくお願いします。", "").ok, "敬語: 空の出力は不合格");

  // §6.1 初回挨拶は原文に無くても足してよい。
  const greeting = "初めまして。BELLOカスタマーサービスでございます。\nこのたちはお問い合わせいただきまして、ありがとうございます。";
  assertTrue(
    keigo("在庫ございます。", `${greeting}\n在庫はございます。`, greeting).ok,
    "敬語: 許可された初回挨拶は「原文に無い」として弾かない",
  );
}

function testFirstReplyDetection() {
  const inbound = { direction: "INBOUND" as const, deliveryStatus: "RECEIVED" };
  assertTrue(isFirstOutgoingReply([inbound]), "初回判定: 受信だけなら初回");
  assertTrue(isFirstOutgoingReply([]), "初回判定: メッセージが無くても初回");

  // §6.1 AI下書きがあるだけでは「返信済み」にしない。
  assertTrue(
    isFirstOutgoingReply([inbound, { direction: "OUTBOUND", deliveryStatus: "DRAFT" }]),
    "初回判定: 下書き(DRAFT)があるだけでは返信済みにしない",
  );
  assertTrue(
    !isFirstOutgoingReply([inbound, { direction: "OUTBOUND", deliveryStatus: "SENT" }]),
    "初回判定: 実際に送信済みの返信があれば初回ではない",
  );
  assertTrue(
    !isFirstOutgoingReply([inbound, { direction: "OUTBOUND", deliveryStatus: "SENDING" }]),
    "初回判定: 送信中も初回ではない",
  );
  assertTrue(
    isFirstOutgoingReply([inbound, { direction: "OUTBOUND", deliveryStatus: "FAILED" }]),
    "初回判定: 送信に失敗した返信は「送れていない」ので初回のまま",
  );
}

function testAmbiguityDetection() {
  assertTrue(detectAmbiguity("たぶん明日には発送できます").length > 0, "曖昧: 推量表現を検出する");
  assertTrue(detectAmbiguity("それで大丈夫です").length > 0, "曖昧: 指示語を検出する");
  assertTrue(detectAmbiguity("早めに発送します").length > 0, "曖昧: 時期の曖昧表現を検出する");
  assertEqual(detectAmbiguity("9月15日に発送いたします。送料は1,200円です。"), [], "曖昧: 具体的な文は警告しない");
}

function testKeigoPrompt() {
  const system = buildKeigoSystemPrompt();
  assertTrue(system.includes("事実の正本"), "敬語プロンプト: 下書きが事実の正本だと明示する");
  assertTrue(system.includes("下書きに無い情報を足さない"), "敬語プロンプト: 情報を足さないと明示する");
  assertTrue(system.includes("商品を調べたり"), "敬語プロンプト: 調べ直さないと明示する");

  const withGreeting = buildKeigoUserPrompt({
    original: "在庫ございます。",
    knowledgeExcerpts: [{ title: "BELLO敬語返信ルール", excerpt: "丁寧に" }],
    greeting: "初めまして。",
    history: [],
  });
  assertTrue(withGreeting.includes("FIRST_REPLY_GREETING"), "敬語プロンプト: 初回挨拶のブロックがある");
  assertTrue(withGreeting.includes("STAFF_DRAFT"), "敬語プロンプト: 下書きのブロックがある");
  assertTrue(withGreeting.includes("BELLO敬語返信ルール"), "敬語プロンプト: ナレッジの文体ルールを渡す");

  const withoutGreeting = buildKeigoUserPrompt({ original: "はい。", knowledgeExcerpts: [], greeting: null, history: [] });
  assertTrue(withoutGreeting.includes("初めまして」は書かないでください"), "敬語プロンプト: 2回目以降は挨拶を書かないと明示する");
}

function main() {
  testDiscountIntent();
  testBaseDiscount();
  testNationalMedian();
  testDiscountOffer();
  testInternalBoundary();
  testDaysOnSale();
  testDeliveryWindow();
  testDeliveryDateExtraction();
  testKeigoFidelity();
  testFirstReplyDetection();
  testAmbiguityDetection();
  testKeigoPrompt();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
