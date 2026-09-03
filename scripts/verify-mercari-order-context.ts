/**
 * 2026-09-04 追加指示 §60/§70: 「注文番号 → 商品Context」の回帰。
 *
 *   npm run verify:mercari-order-context
 *
 * **ネットワークにもAWSにも繋がない。** 対象は
 *   ・購入通知/取引メッセージの解析(notificationMailParser)
 *   ・注文Contextのマージ規則(orderContextStore の純粋関数)
 *   ・出品タイトルの照合(scoring)
 *   ・会話Contextの引き継ぎ(conversationContext)
 *   ・社内通知の文面(lineNotify/format)
 * で、いずれも実データの形をそのまま fixture にしている。
 *
 * ── なぜここを固定するのか ──────────────────────────────────────
 *
 * 実機で起きたのは「メールに商品名も注文番号も載っているのに、社内通知は
 * 『対象商品：特定できませんでした』」だった。原因は解析でも文面でもなく、
 * **購入された商品を『販売中』からしか探していなかった**こと。境目が
 * 複数のファイルに分かれているので、通しで固定しないとまた片方だけ直る。
 */
import {
  canonicalOrderId,
  parseMercariNotificationMail,
  type MercariMailInput,
} from "@/lib/messaging/mercari/notificationMailParser";
import { mergeOrderContext } from "@/lib/messaging/mercari/orderContextStore";
import type { MercariOrderContextRecord } from "@/lib/messaging/mercari/orderContextStore";
import { normalizeProductTitle, scoreInventory, type MatchableInventory } from "@/lib/inquiry/scoring";
import { PRODUCT_MATCH_AUTO_CONFIRM } from "@/lib/inquiry/types";
import {
  emptyConversationContext,
  knownFacts,
  mergeConversationContext,
  parseConversationContext,
  serializeConversationContext,
} from "@/lib/inquiry/conversationContext";
import { buildSummaryMessage } from "@/lib/messaging/lineNotify/format";
import { decideUrlRequest } from "@/lib/inquiry/productIdentification";

let failures = 0;
let passes = 0;
function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ FAIL ${label}\n    期待: ${e}\n    実際: ${a}`);
  } else {
    passes++;
    console.log(`✓ ${label}`);
  }
}
const assertTrue = (c: boolean, label: string) => assertEqual(c, true, label);

/* ══════════════════════════════════════════════════════════════════
 * fixture — Staging接続済みGmailから取得した実メールの構造
 * ══════════════════════════════════════════════════════════════════ */

const SHOP = "evkhihBFFNn5hukMS9s36H";
const ORDER_ID = "order_2JW2rNd9i7WdFrivCjhfpw";
const ORDER_SUFFIX = "2JW2rNd9i7WdFrivCjhfpw";
const INQUIRY = "2JW3nvubFxXmjVXzDbNEkr";
const PRODUCT =
  "BoConcept Lugo / 北欧 デンマーク Morten Georgsen 名作 デザイナーズ テーブル ボーコンセプト ルーゴ コーヒーテーブル ローテーブル";

/** §62 購入通知(実メールの構造そのまま。購入者名だけ差し替え)。 */
const PURCHASE_TEXT = `メルカリShopsをご利用いただきありがとうございます。
下記の商品をテスト購入者さんが購入しました。商品の発送をお願いします。

▼商品情報

商品名 : ${PRODUCT}
商品価格 : ¥29,800
数量 : 1


▼注文情報
注文番号 : ${ORDER_ID}
商品代金 : ¥29,800
送料 : ¥0
クーポン割引 : -¥0
合計金額 : ¥29,800

▼配送先情報
購入者の配送先情報は以下のリンクよりご確認ください。

https://mercari-shops.com/seller/shops/${SHOP}/orders/${ORDER_SUFFIX}?source=deeplink

※ご注文の詳細はショップ管理画面の取引一覧からご確認いただけます

※このメールアドレスは送信専用です。ご返信いただいても対応できませんので、ご了承ください

ーーーーーーーーーー
株式会社メルカリ
ーーーーーーーーーー
`;

/** 後続の取引メッセージ。商品名が落ち、注文番号だけが残った形(§50 の想定)。 */
const ORDER_MESSAGE_TEXT_WITHOUT_PRODUCT = `メルカリShopsをご利用いただきありがとうございます。
お取引中の注文に関して、お客さまからの問い合わせを受け付けました。

▼お客さまからのメッセージ
9月11日の午前中でお願いします。

以下のURLより、内容をご確認ください。

▼問い合わせページ
https://mercari-shops.com/seller/shops/${SHOP}/inquiries/${INQUIRY}?source=deeplink

▼注文情報
注文番号 : ${ORDER_ID}
商品代金 : ¥29,800
送料 : ¥0
クーポン割引 : -¥0
合計金額 : ¥29,800

※このメールアドレスは送信専用です。ご返信いただいても対応できませんので、ご了承ください
`;

function mail(text: string, subject = "【メルカリShops】テスト", gmailId = "gmail-1"): MercariMailInput {
  return {
    subject,
    text,
    html: "",
    messageId: `<${gmailId}@example>`,
    receivedAt: "2026-09-03T09:56:16.000Z",
    from: '"メルカリShops" <no-reply@mercari-shops.com>',
  };
}

/* ══════════════════════════════════════════════════════════════════
 * §62/§69 購入通知の解析と種別の分離
 * ══════════════════════════════════════════════════════════════════ */

function testPurchaseNotificationParsing() {
  const p = parseMercariNotificationMail(mail(PURCHASE_TEXT));
  assertEqual(p.kind, "PURCHASE_NOTIFICATION", "§62 購入通知を種別として見分ける");
  assertEqual(p.status, "PURCHASE_NOTIFICATION", "§63 購入通知は問い合わせ(PARSED)にしない");
  assertEqual(p.productName, PRODUCT, "§62 購入通知から商品名を取り出す");
  assertEqual(p.order.orderNumber, ORDER_ID, "§62 購入通知から注文番号を取り出す");
  assertEqual(p.order.totalAmountYen, 29800, "§62 合計金額も取り出す");
  assertEqual(p.messageText, null, "§63 購入通知に顧客本文は無い(推測で埋めない)");
  assertEqual(p.inquiryId, null, "§53 購入通知には問い合わせスレッドが無い");
  assertTrue(p.orderUrl !== null, "§53 購入通知の注文ページURLを保持する");
}

function testOrderIdCanonicalization() {
  assertEqual(canonicalOrderId(ORDER_SUFFIX), ORDER_ID, "§53 URLのIDと注文番号は同じ鍵になる");
  assertEqual(canonicalOrderId(ORDER_ID), ORDER_ID, "§53 既に order_ 付きならそのまま");
  assertEqual(canonicalOrderId("  "), null, "§53 空文字から鍵を作らない");
}

/** §69 問い合わせでも購入通知でもないメールへ、返信を作らせない。 */
function testUnknownSystemMailIsNotInquiry() {
  const p = parseMercariNotificationMail(
    mail("【メルカリShops】入荷通知のリクエストがありました\n\nお客さまが入荷通知を希望しています。"),
  );
  assertEqual(p.status, "NOT_INQUIRY", "§69 未知のシステムメールは問い合わせにしない");
  assertEqual(p.kind, null, "§69 未知のシステムメールに種別を付けない");
}

/** 購入通知の定型文だけでは購入通知にしない(安全側 §69)。 */
function testPurchaseMarkerNeedsBothPhrases() {
  const p = parseMercariNotificationMail(
    mail("メルカリShopsをご利用いただきありがとうございます。\n商品の発送をお願いします。\n"),
  );
  assertEqual(p.kind, null, "§69 「発送をお願いします」だけでは購入通知と断定しない");
}

/* ══════════════════════════════════════════════════════════════════
 * ケースF/G/H — 注文Contextのマージ規則
 * ══════════════════════════════════════════════════════════════════ */

function baseRecord(): MercariOrderContextRecord {
  return {
    orderId: ORDER_ID,
    inquiryIds: [],
    productName: null,
    productPriceYen: null,
    quantity: null,
    itemAmountYen: null,
    shippingFeeYen: null,
    couponDiscountYen: null,
    totalAmountYen: null,
    requestedDeliveryDate: null,
    inventoryId: null,
    displayInventoryId: null,
    inventoryName: null,
    inventoryCandidateIds: [],
    inventoryStatus: "NONE",
    baseItemId: null,
    baseUrl: null,
    resolvedAt: null,
    evidenceSource: null,
    sourceGmailIds: [],
    purchaseMailGmailIds: [],
    purchaseNotificationSeen: false,
    shopId: null,
    orderUrl: null,
    purchasedAt: null,
    createdAt: null,
    updatedAt: null,
    createdBy: null,
    updatedBy: null,
  };
}

/** ケースG: 同じ購入通知を再取込しても対応が重複しない・増えない。 */
function testCaseG_Idempotent() {
  const patch = {
    productName: PRODUCT,
    evidenceSource: "PURCHASE_NOTIFICATION" as const,
    purchaseNotificationSeen: true,
    addSourceGmailIds: ["gmail-1"],
    addPurchaseMailGmailIds: ["gmail-1"],
    addInquiryIds: [] as string[],
  };
  const once = mergeOrderContext(baseRecord(), patch);
  const twice = mergeOrderContext(once, patch);
  assertEqual(twice.sourceGmailIds, ["gmail-1"], "ケースG 同じメールを2回取り込んでも由来が重複しない");
  assertEqual(twice.purchaseMailGmailIds, ["gmail-1"], "ケースG 購入通知の処理済み判定も重複しない");
  assertEqual(twice.productName, PRODUCT, "ケースG 商品名は変わらない");
  assertEqual(twice.orderId, ORDER_ID, "ケースG 行は1つのまま(識別子は注文番号)");
}

/** ケースF/H: 購入通知で確定した商品名を、後続の断片的な情報が消さない。 */
function testCaseFH_DoesNotWipeKnownProduct() {
  const afterPurchase = mergeOrderContext(baseRecord(), {
    productName: PRODUCT,
    totalAmountYen: 29800,
    evidenceSource: "PURCHASE_NOTIFICATION",
    purchaseNotificationSeen: true,
    inventoryStatus: "NOT_FOUND",
    addSourceGmailIds: ["gmail-1"],
    addPurchaseMailGmailIds: ["gmail-1"],
  });
  // 後続の取引メッセージ。商品名も金額も入っていない。
  const afterMessage = mergeOrderContext(afterPurchase, {
    productName: null,
    totalAmountYen: null,
    evidenceSource: "ORDER_MESSAGE",
    addInquiryIds: [INQUIRY],
    addSourceGmailIds: ["gmail-2"],
  });
  assertEqual(afterMessage.productName, PRODUCT, "ケースF 後続メッセージで商品名を失わない");
  assertEqual(afterMessage.totalAmountYen, 29800, "ケースF 後続メッセージで金額を失わない");
  assertEqual(afterMessage.evidenceSource, "PURCHASE_NOTIFICATION", "出所は強い根拠(購入通知)を残す");
  assertEqual(afterMessage.inquiryIds, [INQUIRY], "§53 注文へ問い合わせスレッドを足せる");

  // ケースH: 後日、在庫が解決できたらContextを更新できる。
  const afterResolve = mergeOrderContext(afterMessage, {
    inventoryId: "inv-1",
    displayInventoryId: "B005614",
    inventoryName: `EDI登録済【9/3午前中】${PRODUCT}`,
    inventoryStatus: "RESOLVED",
    resolvedAt: "2026-09-04T00:00:00.000Z",
  });
  assertEqual(afterResolve.displayInventoryId, "B005614", "ケースH 後日の在庫解決でContextを更新できる");

  // 一度確定した在庫を、後の未解決な結果で戻さない。
  const afterUnresolved = mergeOrderContext(afterResolve, { inventoryStatus: "NOT_FOUND", inventoryId: null });
  assertEqual(afterUnresolved.displayInventoryId, "B005614", "ケースH 確定済みの在庫を未解決の結果で消さない");
  assertEqual(afterUnresolved.inventoryStatus, "RESOLVED", "ケースH 確定済みの状態を戻さない");
}

/** §53 同じ注文に別スレッドが立っても、注文側は両方を持てる。 */
function testCaseC_SharedOrderDistinctThreads() {
  const r = mergeOrderContext(
    mergeOrderContext(baseRecord(), { productName: PRODUCT, addInquiryIds: ["inq-A"] }),
    { addInquiryIds: ["inq-B"] },
  );
  assertEqual(r.inquiryIds, ["inq-A", "inq-B"], "ケースC 同じ注文に複数の問い合わせスレッドを持てる");
  assertEqual(r.orderId, ORDER_ID, "ケースC 注文は1つのまま");
}

/* ══════════════════════════════════════════════════════════════════
 * §50 出品タイトルの照合 — 「販売中に無い」在庫を当てる
 * ══════════════════════════════════════════════════════════════════ */

function matchable(id: string, sku: string, name: string): MatchableInventory {
  return {
    id,
    quantity: 0,
    displayInventoryId: sku,
    sku,
    name,
    externalProductId: null,
    barcode: null,
    sourceInventoryId: null,
    listings: [],
  };
}

/**
 * 実データ(2026-09-03)そのまま。B005614 が注文の商品で、B005186 は
 * 語順と語が違う別個体。ここを取り違えると、別商品の情報で返信してしまう。
 */
const INV_ORDERED = matchable("inv-1", "B005614", `EDI登録済【9/3午前中】${PRODUCT}`);
const INV_OTHER = matchable(
  "inv-2",
  "B005186",
  "【7/19午前】BoConcept Lugo / 北欧 デンマーク 美品 ボーコンセプト ルーゴ コーヒーテーブル ローテーブル デザイナーズ家具 Morten Georgsen",
);

function signals() {
  return {
    normalizedUrls: [],
    baseItemIds: [],
    skus: [],
    inventoryIds: [],
    modelNumbers: [],
    brandNames: [],
    nameFragments: [],
    officialTitles: [PRODUCT],
  };
}

function testOfficialTitleContainment() {
  const ordered = scoreInventory(INV_ORDERED, signals());
  const other = scoreInventory(INV_OTHER, signals());

  assertTrue(
    ordered.confidence >= PRODUCT_MATCH_AUTO_CONFIRM,
    `§50 出品タイトルを丸ごと含む在庫は確定できる(実測 ${ordered.confidence})`,
  );
  assertTrue(
    other.confidence < PRODUCT_MATCH_AUTO_CONFIRM,
    `§50 語順の違う別個体は確定させない(実測 ${other.confidence})`,
  );
  assertTrue(
    ordered.confidence - other.confidence >= 0.05,
    "§50 注文の商品と別個体の間に十分な差がある(候補が割れない)",
  );
  assertTrue(
    ordered.reasons.some((r) => r.startsWith("出品タイトルと")),
    "§50 出品タイトル一致であることが理由に残る(広い範囲から採る条件)",
  );
  // 社内注記が前に付いているだけ、という関係であることを明示的に固定する。
  assertTrue(
    normalizeProductTitle(INV_ORDERED.name).includes(normalizeProductTitle(PRODUCT)),
    "§50 在庫名は出品タイトルを丸ごと含む(前後の社内注記だけが違う)",
  );
}

/** 短いタイトルで包含判定が誤爆しないこと。 */
function testShortTitleDoesNotOverMatch() {
  const short = { ...signals(), officialTitles: ["チェア"] };
  const scored = scoreInventory(matchable("inv-9", "B0", "北欧 チェア ダイニング 椅子"), short);
  assertTrue(scored.confidence < PRODUCT_MATCH_AUTO_CONFIRM, "§50 短い出品タイトルの包含では確定させない");
}

/* ══════════════════════════════════════════════════════════════════
 * ケースA/B — 会話Contextの引き継ぎ(§55)
 * ══════════════════════════════════════════════════════════════════ */

function testCaseAB_ContextCarry() {
  // ケースA: 1通目で商品名+注文番号が分かった。
  const first = mergeConversationContext(emptyConversationContext(), {
    channel: "MERCARI_SHOPS",
    identifiedProduct: { channelProductName: PRODUCT, inventoryId: "inv-1", inventoryStatus: "RESOLVED" },
    order: { orderId: ORDER_ID, itemAmountYen: 29800, shippingFeeYen: 0, totalAmountYen: 29800 },
  });
  assertEqual(first.order.orderId, ORDER_ID, "ケースA 注文番号を会話Contextへ保持する");

  // ケースB: 2通目は「11日でお願いします」だけ。分からなかった項目は
  // undefined で渡され、既存が消えないこと。
  const second = mergeConversationContext(first, {
    identifiedProduct: { channelProductName: undefined, inventoryId: undefined },
    order: { requestedDeliveryDate: "2026-09-11" },
  });
  assertEqual(second.identifiedProduct.channelProductName, PRODUCT, "ケースB 短文で商品名を失わない");
  assertEqual(second.order.orderId, ORDER_ID, "ケースB 短文で注文番号を失わない");
  assertEqual(second.order.totalAmountYen, 29800, "ケースB 短文で注文金額を失わない");
  assertEqual(second.order.requestedDeliveryDate, "2026-09-11", "ケースB 希望配送日を足せる");

  // 保存形式を通しても失われないこと(古い保存形式との互換も含む)。
  const roundTrip = parseConversationContext(serializeConversationContext(second));
  assertEqual(roundTrip.identifiedProduct.channelProductName, PRODUCT, "ケースB 保存→復元で商品名が残る");
  assertEqual(roundTrip.order.totalAmountYen, 29800, "ケースB 保存→復元で注文金額が残る");

  // 新しい項目を持たない古い保存形式でも壊れない。
  const legacy = parseConversationContext(JSON.stringify({ version: 2, order: { orderId: ORDER_ID } }));
  assertEqual(legacy.order.totalAmountYen, null, "既存の保存形式を読んでも壊れない(新項目はnull)");
  assertEqual(legacy.identifiedProduct.channelProductName, null, "既存の保存形式に無い項目はnull");

  // §54 既知情報として「対象商品」に出る = 顧客へ聞き返さない材料になる。
  const facts = knownFacts(second);
  assertTrue(
    facts.some((f) => f.label === "対象商品" && f.value === PRODUCT),
    "§54 在庫を引けなくても出品タイトルは既知情報として扱う",
  );
  assertTrue(facts.some((f) => f.label === "注文番号" && f.value === ORDER_ID), "§55 注文番号も既知情報に出る");
}

/* ══════════════════════════════════════════════════════════════════
 * ケースD — 顧客に商品URL/商品名を聞かない(§54)
 * ══════════════════════════════════════════════════════════════════ */

function testCaseD_NeverAskCustomer() {
  const decision = decideUrlRequest({
    basis: "NONE",
    status: "NOT_FOUND",
    candidateCount: 0,
    requiresProduct: true,
    // 注文がある場合、pipeline はこれを false にする。
    customerCanProvideUrl: false,
  });
  assertEqual(decision.requestUrl, false, "ケースD 注文番号があるなら顧客へURLを尋ねない");

  // 通知は【要確認】になり、理由が内部の課題として書かれること。
  const summary = buildSummaryMessage({
    channel: "MERCARI_SHOPS",
    customerName: null,
    messageText: "9月11日の午前中でお願いします。",
    intents: ["DELIVERY"],
    evidence: null,
    draftText: null,
    needsHumanReview: true,
    reviewReasons: [
      `注文番号(${ORDER_ID})は把握していますが、対応するBELLO在庫を特定できませんでした。在庫データ側で確認してください(お客様への確認は不要です)。`,
    ],
    logId: null,
    failureReason: null,
    inquiryKind: "ORDER_MESSAGE",
    orderNumber: ORDER_ID,
    orderProduct: null,
  });
  assertTrue(summary.includes("要確認"), "ケースD 内部で特定できない場合は【要確認】へ回す");
  assertTrue(summary.includes(ORDER_ID), "ケースD 注文番号は通知に出す");
  assertTrue(!summary.includes("商品のURLをお送り"), "ケースD 顧客へURLを求める文面を出さない");
}

/* ══════════════════════════════════════════════════════════════════
 * §58 社内LINE通知に商品情報を出す
 * ══════════════════════════════════════════════════════════════════ */

function testNotificationShowsRestoredProduct() {
  const summary = buildSummaryMessage({
    channel: "MERCARI_SHOPS",
    customerName: null,
    messageText: "9月11日の午前中でお願いします。",
    intents: ["DELIVERY"],
    evidence: {
      product: null,
      productStatus: "NOT_FOUND",
      productCandidates: [],
      inventoryFieldsUsed: [],
      knowledgeDocuments: [],
      shipping: null,
      externalResearchAttempted: false,
      externalFacts: [],
      unresolvedFacts: [],
      baseProducts: [],
      identifiedProduct: null,
      channelProduct: {
        productName: PRODUCT,
        orderId: ORDER_ID,
        itemAmountYen: 29800,
        shippingFeeYen: 0,
        couponDiscountYen: 0,
        totalAmountYen: 29800,
      },
    },
    draftText: "承知いたしました。",
    needsHumanReview: false,
    reviewReasons: [],
    logId: null,
    failureReason: null,
    inquiryKind: "ORDER_MESSAGE",
    orderNumber: ORDER_ID,
    productContextNotes: [`対象商品：注文番号${ORDER_ID}の購入通知から商品名を復元しました。`],
  });
  assertTrue(!summary.includes("特定できませんでした"), "§58 商品名が分かっているのに「特定できませんでした」と書かない");
  assertTrue(summary.includes(PRODUCT), "§58 復元した商品名を通知へ出す");
  assertTrue(summary.includes(`注文番号：${ORDER_ID}`), "§58 注文番号を通知へ出す");
  assertTrue(summary.includes("商品代金：29,800円"), "§55 注文金額を通知へ出す");
  assertTrue(summary.includes("購入通知から商品名を復元"), "§50 どう復元したかを通知へ出す");
  assertTrue(summary.includes("【次のメッセージで返信提案します】"), "§58 2通目がある旨は従来どおり");
}

/** 商品名も分からないときは、従来どおり「特定できませんでした」。推測しない。 */
function testNotificationStillHonestWhenUnknown() {
  const summary = buildSummaryMessage({
    channel: "MERCARI_SHOPS",
    customerName: null,
    messageText: "9月11日の午前中でお願いします。",
    intents: ["DELIVERY"],
    evidence: null,
    draftText: null,
    needsHumanReview: true,
    reviewReasons: ["注文番号は把握していますが、商品Contextを復元できませんでした。"],
    logId: null,
    failureReason: null,
    inquiryKind: "ORDER_MESSAGE",
    orderNumber: ORDER_ID,
  });
  assertTrue(summary.includes("特定できませんでした"), "商品名すら分からない場合は正直に書く");
}

/** 取引メッセージから注文番号だけが取れるケース(§50 の入口)。 */
function testOrderMessageWithoutProductName() {
  const p = parseMercariNotificationMail(mail(ORDER_MESSAGE_TEXT_WITHOUT_PRODUCT));
  assertEqual(p.kind, "ORDER_MESSAGE", "§50 商品名が無くても取引メッセージと判定できる");
  assertEqual(p.productName, null, "§50 商品名は取れない(推測で埋めない)");
  assertEqual(p.order.orderNumber, ORDER_ID, "§50 注文番号は取れる");
  assertEqual(p.inquiryId, INQUIRY, "§53 問い合わせスレッドIDも取れる");
  assertEqual(p.messageText, "9月11日の午前中でお願いします。", "§50 顧客本文は従来どおり取れる");
}

function main() {
  console.log("── §62/§69 メール種別の分離 ─────────────────────────");
  testPurchaseNotificationParsing();
  testOrderIdCanonicalization();
  testUnknownSystemMailIsNotInquiry();
  testPurchaseMarkerNeedsBothPhrases();
  testOrderMessageWithoutProductName();

  console.log("\n── ケースC/F/G/H 注文Contextのマージ ───────────────");
  testCaseG_Idempotent();
  testCaseFH_DoesNotWipeKnownProduct();
  testCaseC_SharedOrderDistinctThreads();

  console.log("\n── §50 出品タイトルの照合 ───────────────────────────");
  testOfficialTitleContainment();
  testShortTitleDoesNotOverMatch();

  console.log("\n── ケースA/B 会話Contextの引き継ぎ ─────────────────");
  testCaseAB_ContextCarry();

  console.log("\n── ケースD/§58 社内通知 ─────────────────────────────");
  testCaseD_NeverAskCustomer();
  testNotificationShowsRestoredProduct();
  testNotificationStillHonestWhenUnknown();

  console.log(`\n合格 ${passes} / 失敗 ${failures}`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
