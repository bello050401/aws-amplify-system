/**
 * 社内LINE通知の文面・再試行・要確認判定を固定する検証。
 * ネットワークにもAWSにも繋がない(純粋関数だけを対象にする)。
 *
 * ── なぜここを厚くするか ────────────────────────────────────────
 *
 * 通知の不具合は本番でしか見つからないものが多い。とくに:
 *
 *   金額を推測して埋める     … 担当者が誤った価格で値下げを判断する
 *   【要確認】が出ない       … 人が決めるべき値引きをそのまま送る
 *   重複判定が緩い           … 同じ問い合わせのLINEが鳴り続ける
 *   再試行が止まらない       … 同上
 *
 * どれも「送ってみないと分からない」状態にしてはいけないので、
 * AWSにもLINEにも触らない形へ切り出して全分岐を固定する。
 *
 * Run with: npm run verify:line-notify
 */
import {
  buildNotificationMessages,
  buildReplyMessage,
  buildSummaryMessage,
  LINE_TEXT_LIMIT,
  type NotificationInput,
} from "@/lib/messaging/lineNotify/format";
import {
  buildDedupeKey,
  canSend,
  decideAfterFailure,
  MAX_DELIVERY_ATTEMPTS,
} from "@/lib/messaging/lineNotify/deliveryPolicy";
import { decideReview } from "@/lib/messaging/lineNotify/reviewPolicy";
import type { ReplyEvidence } from "@/lib/inquiry/types";

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
const assertTrue = (c: boolean, label: string) => assertEqual(c, true, label);

/* ══════════════════════════════════════════════════════════════════
 * テスト用の素材
 * ══════════════════════════════════════════════════════════════════ */

function emptyEvidence(): ReplyEvidence {
  return {
    product: null,
    productStatus: "NOT_REFERENCED",
    productCandidates: [],
    inventoryFieldsUsed: [],
    knowledgeDocuments: [],
    shipping: null,
    externalResearchAttempted: false,
    externalFacts: [],
    unresolvedFacts: [],
  };
}

function evidenceWithProduct(): ReplyEvidence {
  return {
    ...emptyEvidence(),
    productStatus: "RESOLVED",
    identifiedProduct: {
      inventoryId: "inv-1",
      displayInventoryId: "BL-0001",
      sku: "BL-0001",
      name: "COR Arthe サイドテーブル",
      imageKey: null,
      salePriceYen: 98000,
      salePriceSource: "salePrice",
      purchasePriceYen: 32000,
      saleStartedAt: "2026-08-15",
      statusName: null,
      quantity: 1,
      baseItemId: "156144635",
      baseItemUrl: "https://bellointeri.base.shop/items/156144635",
      basis: "BASE_ITEM_ID",
      unlinkedBaseProductCount: 0,
    },
    shipping: {
      destinationPrefecture: "埼玉県",
      rank: "C",
      feeYen: 8600,
      note: null,
      missingCustomerInfo: [],
    },
  };
}

function baseInput(over: Partial<NotificationInput> = {}): NotificationInput {
  return {
    channel: "MERCARI_SHOPS",
    customerName: "山田様",
    messageText: "埼玉県なのですが、お値下げ可能でしょうか。",
    intents: ["NEGOTIATION"],
    evidence: evidenceWithProduct(),
    draftText: "お問い合わせありがとうございます。",
    needsHumanReview: false,
    reviewReasons: [],
    logId: null,
    failureReason: null,
    ...over,
  };
}

/* ══════════════════════════════════════════════════════════════════
 * 1通目 — §7-1 のテンプレートどおりか
 * ══════════════════════════════════════════════════════════════════ */
function testSummaryTemplate() {
  const s = buildSummaryMessage(baseInput());

  assertTrue(s.startsWith("【メルカリShops】"), "1通目: チャネル名が先頭に出る");
  assertTrue(s.includes("■ お問い合わせ内容"), "1通目: お問い合わせ内容の見出し");
  assertTrue(s.includes("お名前：山田様"), "1通目: 顧客名");
  assertTrue(s.includes("埼玉県なのですが、お値下げ可能でしょうか。"), "1通目: 問い合わせ原文をそのまま載せる");
  assertTrue(s.includes("■ 対象商品"), "1通目: 対象商品の見出し");
  assertTrue(s.includes("商品名：COR Arthe サイドテーブル"), "1通目: 商品名");
  assertTrue(s.includes("URL：https://bellointeri.base.shop/items/156144635"), "1通目: 商品URL");
  assertTrue(s.includes("販売価格：98,000円"), "1通目: 販売価格は3桁区切り＋円");
  assertTrue(s.includes("仕入れ価格：32,000円"), "1通目: 仕入れ価格");
  assertTrue(s.includes("販売開始日：2026年8月15日"), "1通目: 販売開始日は和暦表記でなく年月日");
  assertTrue(s.includes("在庫期間："), "1通目: 在庫期間");
  assertTrue(s.includes("配送先：埼玉県"), "1通目: 配送先");
  assertTrue(s.includes("想定送料：8,600円"), "1通目: 想定送料");
  assertTrue(s.includes("■ 問い合わせ判定"), "1通目: 問い合わせ判定の見出し");
  assertTrue(s.includes("価格交渉"), "1通目: 判定結果は既存のINQUIRY_INTENT_LABELを使う");

  // チャネル名は指示書§7-1の表記に合わせる。
  assertTrue(buildSummaryMessage(baseInput({ channel: "LINE" })).startsWith("【公式LINE】"), "1通目: LINEは【公式LINE】");
  assertTrue(buildSummaryMessage(baseInput({ channel: "BASE" })).startsWith("【BASE】"), "1通目: BASEは【BASE】");
}

/* ══════════════════════════════════════════════════════════════════
 * 体裁 — §7-1 のテンプレートは空行の位置まで含めて指定されている
 *
 * 実データで通したとき、見出し直後に空行が2つ入り、お名前と本文の間の
 * 空行が消えていた。読めなくはないが、指定と違ううえ、名前と問い合わせ文が
 * 続けて並ぶと読みづらい。体裁も固定する。
 * ══════════════════════════════════════════════════════════════════ */
function testLayout() {
  const s = buildSummaryMessage(baseInput());
  const lines = s.split("\n");

  assertEqual(lines[0], "【メルカリShops】", "体裁: 1行目はチャネル見出し");
  assertEqual(lines[1], "", "体裁: 見出しの次は空行1つ");
  assertEqual(lines[2], "■ お問い合わせ内容", "体裁: 空行は1つだけ(2つ続けない)");
  assertEqual(lines[3], "お名前：山田様", "体裁: お名前が見出しの直後");
  assertEqual(lines[4], "", "体裁: お名前と本文の間に空行を残す(§7-1のテンプレート)");
  assertEqual(lines[5], "埼玉県なのですが、お値下げ可能でしょうか。", "体裁: 本文が続く");

  // 空行が3つ以上続く箇所が無いこと。
  assertTrue(!/\n{3,}/.test(s), "体裁: 空行が2つ以上続かない");

  // セクション同士は空行1つで区切る。
  assertTrue(s.includes("\n\n■ 対象商品"), "体裁: セクションの前は空行1つ");
}

/* ══════════════════════════════════════════════════════════════════
 * §7-2 推測して埋めない
 * ══════════════════════════════════════════════════════════════════ */
function testUnknownValues() {
  const s = buildSummaryMessage(
    baseInput({ customerName: null, evidence: emptyEvidence(), intents: [] }),
  );

  assertTrue(s.includes("お名前：不明"), "不明値: 顧客名が取れなければ「不明」");
  assertTrue(s.includes("特定できませんでした"), "不明値: 商品が決まらなければ「特定できませんでした」");
  assertTrue(s.includes("配送先：不明"), "不明値: 配送先が不明");
  assertTrue(s.includes("想定送料：不明"), "不明値: 送料が不明");

  // **商品が決まっていないのに価格欄を出さない。** 空の価格が並ぶと
  // 「取得に失敗した」のか「そもそも商品が決まっていない」のか読めない。
  assertTrue(!s.includes("販売価格"), "不明値: 商品未特定なら商品情報セクションごと出さない");
  assertTrue(!s.includes("仕入れ価格"), "不明値: 商品未特定なら仕入れ価格を出さない");

  // 0円と不明を混同しない。
  const zero = evidenceWithProduct();
  zero.identifiedProduct!.purchasePriceYen = 0;
  zero.identifiedProduct!.salePriceYen = null;
  const s2 = buildSummaryMessage(baseInput({ evidence: zero }));
  assertTrue(s2.includes("仕入れ価格：0円"), "不明値: 仕入0円は「0円」であって「不明」ではない");
  assertTrue(s2.includes("販売価格：不明"), "不明値: 販売価格が無ければ「不明」");

  // URLが商品と結び付かなければ、行ごと出さない(「URL：不明」を出さない)。
  const noUrl = evidenceWithProduct();
  noUrl.identifiedProduct!.baseItemUrl = null;
  const s3 = buildSummaryMessage(baseInput({ evidence: noUrl }));
  assertTrue(!s3.includes("URL："), "不明値: 商品URLが無ければURL行を出さない");
  assertTrue(s3.includes("商品名："), "不明値: URLが無くても商品名は出す");
}

/* ══════════════════════════════════════════════════════════════════
 * §33 【要確認】
 * ══════════════════════════════════════════════════════════════════ */
function testHumanReviewHeader() {
  const s = buildSummaryMessage(
    baseInput({ needsHumanReview: true, reviewReasons: ["値下げ交渉です。最終的な値引き額はご判断ください。"] }),
  );
  assertTrue(s.startsWith("【メルカリShops / 要確認】"), "要確認: 先頭へ【要確認】を付ける");
  assertTrue(s.includes("■ 要確認の理由"), "要確認: 理由の見出しを出す");
  assertTrue(s.includes("・値下げ交渉です。"), "要確認: 理由を箇条書きで出す");

  const normal = buildSummaryMessage(baseInput());
  assertTrue(!normal.includes("要確認"), "要確認: 不要なときは付けない(印として機能させる)");
}

/* ══════════════════════════════════════════════════════════════════
 * §34 生成失敗でも通知する
 * ══════════════════════════════════════════════════════════════════ */
function testFailureNotification() {
  const msgs = buildNotificationMessages(
    baseInput({
      draftText: null,
      failureReason: "AIモデルの呼び出しがタイムアウトしました。",
      logId: "draft-123",
      needsHumanReview: true,
      reviewReasons: ["返信案の自動生成に失敗しました。"],
    }),
  );
  assertTrue(msgs.summary.includes("返信案の自動生成に失敗しました。"), "生成失敗: 失敗した事実を1通目に書く");
  assertTrue(msgs.summary.includes("管理画面ログID：draft-123"), "生成失敗: ログIDを載せて追跡できるようにする");
  assertTrue(msgs.summary.includes("お問い合わせ内容"), "生成失敗: 問い合わせ内容自体は捨てずに通知する");
  assertEqual(msgs.reply, null, "生成失敗: 2通目は送らない(空の返信提案を出さない)");
  assertEqual(msgs.priority, "PARSE_ERROR", "生成失敗: 優先度はPARSE_ERROR");
}

/* ══════════════════════════════════════════════════════════════════
 * §7-3 2通目
 * ══════════════════════════════════════════════════════════════════ */
function testReplyMessage() {
  const r = buildReplyMessage("お問い合わせありがとうございます。\n何卒よろしくお願いいたします。");
  assertTrue(r.startsWith("【返信提案】"), "2通目: 見出しが【返信提案】");
  assertTrue(r.includes("何卒よろしくお願いいたします。"), "2通目: 本文をそのまま載せる");

  // AIの解説を入れない。担当者がコピーのたびに解説行を削る運用は必ず事故る。
  for (const ng of ["以下のように", "返信するとよい", "AIが生成", "参考にしてください"]) {
    assertTrue(!r.includes(ng), `2通目: 解説文「${ng}」を入れない`);
  }

  const msgs = buildNotificationMessages(baseInput({ draftText: "   " }));
  assertEqual(msgs.reply, null, "2通目: 空白だけの返信案は送らない");
}

/* ══════════════════════════════════════════════════════════════════
 * LINEの5,000文字制限
 * ══════════════════════════════════════════════════════════════════ */
function testTruncation() {
  const huge = "あ".repeat(20000);
  const s = buildSummaryMessage(baseInput({ messageText: huge }));
  assertTrue(s.length <= LINE_TEXT_LIMIT, "文字数: 1通目が5,000文字を超えない(超えると送信ごと失敗する)");
  const r = buildReplyMessage(huge);
  assertTrue(r.length <= LINE_TEXT_LIMIT, "文字数: 2通目が5,000文字を超えない");
  // 長文でも判断材料が消えないこと(引用を先に切る設計)。
  assertTrue(s.includes("■ 対象商品"), "文字数: 長い問い合わせでも対象商品セクションが残る");
  assertTrue(s.includes("■ 問い合わせ判定"), "文字数: 長い問い合わせでも判定セクションが残る");
}

/* ══════════════════════════════════════════════════════════════════
 * §10/§8 重複防止と再試行
 * ══════════════════════════════════════════════════════════════════ */
function testDeliveryPolicy() {
  assertEqual(
    buildDedupeKey({ channel: "LINE", conversationId: "c1", sourceMessageId: "m1" }),
    "LINE:c1:m1",
    "重複キー: チャネル・会話・メッセージの3つで作る",
  );
  // 同じ会話の2通目は別の通知。会話単位にすると追加質問が通知されなくなる。
  assertTrue(
    buildDedupeKey({ channel: "LINE", conversationId: "c1", sourceMessageId: "m1" }) !==
      buildDedupeKey({ channel: "LINE", conversationId: "c1", sourceMessageId: "m2" }),
    "重複キー: 同じ会話でもメッセージが違えば別の通知",
  );

  assertTrue(canSend(null).shouldRetry, "送信可否: 新規は送る");
  assertTrue(!canSend({ status: "SENT", attemptCount: 1 }).shouldRetry, "送信可否: 送信済みは二度と送らない");
  assertTrue(!canSend({ status: "PROCESSING", attemptCount: 1 }).shouldRetry, "送信可否: 送信中は追い越さない");
  assertTrue(!canSend({ status: "DEAD_LETTER", attemptCount: 3 }).shouldRetry, "送信可否: 停止済みは自動で再送しない");
  assertTrue(canSend({ status: "FAILED", attemptCount: 1 }).shouldRetry, "送信可否: 失敗して回数が残っていれば再試行");
  assertTrue(
    !canSend({ status: "FAILED", attemptCount: MAX_DELIVERY_ATTEMPTS }).shouldRetry,
    "送信可否: 上限まで試したら再試行しない",
  );

  // 直らない失敗は回数を使い切らずに止める。
  const auth = decideAfterFailure({ attemptCount: 1, retryable: false, errorMessage: "認証に失敗" });
  assertEqual(auth.status, "DEAD_LETTER", "再試行: 認証エラーは1回目でも停止する");
  assertTrue(!auth.shouldRetry, "再試行: 認証エラーは再試行しない");

  const net1 = decideAfterFailure({ attemptCount: 1, retryable: true, errorMessage: "接続失敗" });
  assertEqual(net1.status, "FAILED", "再試行: 一時的な失敗は FAILED のまま");
  assertTrue(net1.shouldRetry, "再試行: 一時的な失敗は再試行する");

  const netMax = decideAfterFailure({ attemptCount: MAX_DELIVERY_ATTEMPTS, retryable: true, errorMessage: "接続失敗" });
  assertEqual(netMax.status, "DEAD_LETTER", "再試行: 上限に達したら停止する(鳴り続けさせない)");
  assertTrue(netMax.reason.includes(String(MAX_DELIVERY_ATTEMPTS)), "再試行: 何回試したかを理由に書く");
}

/* ══════════════════════════════════════════════════════════════════
 * §33/§16-2/§17 要確認の判定
 * ══════════════════════════════════════════════════════════════════ */
function testReviewPolicy() {
  const clean = decideReview({
    draftStatus: "READY",
    evidence: emptyEvidence(),
    deliveryWindowState: null,
    generationFailed: false,
  });
  assertTrue(!clean.needsHumanReview, "要確認判定: 問題が無ければ付けない");

  const negotiation = { ...emptyEvidence() };
  negotiation.negotiation = {
    detected: true,
    signals: [],
    quantity: null,
    requestedTotalPriceYen: null,
    requestedUnitPriceYen: null,
    carriedOverFromHistory: false,
    awaitingDestination: true,
  };
  const neg = decideReview({
    draftStatus: "READY",
    evidence: negotiation,
    deliveryWindowState: null,
    generationFailed: false,
  });
  assertTrue(neg.needsHumanReview, "要確認判定: 値下げ交渉は人が判断する");
  assertTrue(
    neg.reasons.some((r) => r.includes("配送先が不明")),
    "要確認判定: 配送先不明の値下げは、その事実を理由に書く(§44 値引き額を勝手に確定しない)",
  );

  const late = decideReview({
    draftStatus: "READY",
    evidence: emptyEvidence(),
    deliveryWindowState: "HUMAN_REVIEW_REQUIRED",
    generationFailed: false,
  });
  assertTrue(late.needsHumanReview, "要確認判定: 2週間超の配送希望日は人が判断する");

  const within = decideReview({
    draftStatus: "READY",
    evidence: emptyEvidence(),
    deliveryWindowState: "WITHIN_STANDARD_WINDOW",
    generationFailed: false,
  });
  assertTrue(!within.needsHumanReview, "要確認判定: 2週間以内なら付けない");

  const ambiguous = { ...emptyEvidence(), productStatus: "AMBIGUOUS" as const };
  assertTrue(
    decideReview({ draftStatus: "READY", evidence: ambiguous, deliveryWindowState: null, generationFailed: false })
      .needsHumanReview,
    "要確認判定: 商品候補が複数なら人が判断する",
  );

  const failed = decideReview({
    draftStatus: "FAILED",
    evidence: emptyEvidence(),
    deliveryWindowState: null,
    generationFailed: true,
  });
  assertTrue(failed.needsHumanReview, "要確認判定: 生成失敗は人が判断する");
  assertEqual(failed.reasons.length, 1, "要確認判定: 生成失敗の理由を二重に並べない");

  assertTrue(
    decideReview({
      draftStatus: "NEEDS_PRODUCT_CONFIRMATION",
      evidence: emptyEvidence(),
      deliveryWindowState: null,
      generationFailed: false,
    }).needsHumanReview,
    "要確認判定: 商品確認待ちは人が判断する",
  );
}

testSummaryTemplate();
testLayout();
testUnknownValues();
testHumanReviewHeader();
testFailureNotification();
testReplyMessage();
testTruncation();
testDeliveryPolicy();
testReviewPolicy();

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
