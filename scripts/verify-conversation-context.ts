/**
 * 2026-09-03 追加指示 §17-§40 の検証。外部サービスへは一切接続しない。
 *
 *   npm run verify:conversation-context
 *
 * ここで固定したいこと:
 *
 *  1. 複数メッセージにまたがる問い合わせで、確定した情報が消えない(§17-§21)
 *  2. 直前の確認事項への回答として短い返事を解釈する(§22)
 *  3. すでに分かっていることを顧客へ聞き直さない(§23)
 *  4. BASE商品と在庫で特定の段階を分ける(§24)
 *  5. 同一会話へ同時に届いても、片方の更新が消えない(§25)
 *  6. 実際に起きたケース(BASE URL + 3万円 → 埼玉です)が最後まで通る(§26)
 *  7. 名前だけでは会話を結合しない(§19)
 *  8. 在庫にサイズが無くてもBASEの商品説明から補って送料まで出せる(§29-§40)
 */
import {
  addPendingQuestions,
  clearPendingQuestions,
  detectAskedQuestions,
  emptyConversationContext,
  hasCarriedContext,
  isPending,
  knownFacts,
  mergeConversationContext,
  parseConversationContext,
  serializeConversationContext,
  switchesProduct,
  type ConversationContext,
} from "@/lib/inquiry/conversationContext";
import { resolveDayOnlyDate, resolvePendingAnswers } from "@/lib/inquiry/pendingAnswer";
import { decideConversationLink, normalizeDisplayName, type ConversationCandidate } from "@/lib/messaging/conversationLink";
import {
  descriptionToPlainText,
  extractAttributesFromText,
  extractDimensionsFromText,
} from "@/lib/inquiry/productDetailExtraction";
import { extractNegotiation } from "@/lib/inquiry/negotiation";
import { extractBaseItemId, extractUrls, isBaseUrl } from "@/lib/inquiry/references";
import { extractShippingDestination } from "@/lib/inquiry/shippingIntent";
import { decideUrlRequest, identificationBasis } from "@/lib/inquiry/productIdentification";
import { calculateShippingRankFromDimensions } from "@/lib/shipping/rank";
import { buildSummaryMessage, buildReplyMessage } from "@/lib/messaging/lineNotify/format";
import {
  saveConversationContextWith,
  loadConversationContextWith,
  type ContextStoreDeps,
} from "@/lib/inquiry/contextStore";

let failures = 0;
let passes = 0;

function check(ok: boolean, label: string, detail = "") {
  if (ok) {
    passes++;
    console.log(`✓ ${label}`);
  } else {
    failures++;
    console.error(`✗ FAIL ${label}${detail ? `\n    ${detail}` : ""}`);
  }
}

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(a === e, label, `expected ${e}\n    actual   ${a}`);
}

/* ══════════════════════════════════════════════════════════════════
 * §26 実ケース: BASE URL + 値下げ希望 → 配送先確認 → 「埼玉です」
 * ══════════════════════════════════════════════════════════════════ */

const BASE_URL = "https://bellointeri.base.shop/items/156144635";
const STEP1 = `${BASE_URL}\n3万円まで下げられますか？`;
const STEP2 = "埼玉です";
const ASK_DESTINATION = "お届け先の都道府県を教えていただけますでしょうか。確認でき次第、ご案内させていただきます。";

function testStep1(): ConversationContext {
  console.log("\n── STEP 1: 商品URL + 値下げ希望 ──");

  const baseIds = extractUrls(STEP1)
    .filter(isBaseUrl)
    .map((u) => extractBaseItemId(u))
    .filter((v): v is string => v != null);
  eq(baseIds, ["156144635"], "STEP1: BASE URLから商品IDを取り出せる");

  const negotiation = extractNegotiation(STEP1);
  check(negotiation.isNegotiation, "STEP1: 値下げ交渉として判定される");
  eq(negotiation.requestedTotalPriceYen, 30000, "STEP1: 希望価格 30,000円を読み取れる");

  const destination = extractShippingDestination(STEP1);
  eq(destination.prefecture, null, "STEP1: 配送先はまだ分からない");

  // 1通目で分かったことを文脈へ入れる。
  let context = mergeConversationContext(emptyConversationContext(), {
    channel: "LINE",
    intents: ["NEGOTIATION"],
    identifiedProduct: {
      baseItemId: "156144635",
      baseItemUrl: BASE_URL,
      baseProductName: "BoConcept Elba Lounge Chair",
      baseListedPriceYen: 54800,
      baseStatus: "RESOLVED",
      inventoryId: null,
      inventoryCandidateIds: ["inv-a", "inv-b"],
      inventoryStatus: "AMBIGUOUS",
      basis: "BASE_ITEM_ID",
      salePriceYen: 54800,
    },
    negotiation: {
      active: true,
      requestedTotalPriceYen: 30000,
      requestedUnitPriceYen: 30000,
      quantity: null,
      currentUnitPriceYen: 54800,
    },
  });

  // 配送先を尋ねた事実を、返信案の**文面から**読み取って積む。
  const asked = detectAskedQuestions(ASK_DESTINATION, "2026-09-03T01:00:00.000Z");
  eq(
    asked.map((a) => a.field),
    ["DESTINATION_PREFECTURE"],
    "STEP1: 返信案の文面から「配送先を尋ねた」ことを読み取れる",
  );
  context = addPendingQuestions(context, asked);
  check(isPending(context, "DESTINATION_PREFECTURE"), "STEP1: 配送先が確認待ちになる");

  // §24 BASE商品はRESOLVED、在庫はAMBIGUOUS。段階を分けて持てている。
  eq(context.identifiedProduct.baseStatus, "RESOLVED", "STEP1(§24): BASE商品はRESOLVED");
  eq(context.identifiedProduct.inventoryStatus, "AMBIGUOUS", "STEP1(§24): 在庫はAMBIGUOUS");
  eq(context.identifiedProduct.baseItemUrl, BASE_URL, "STEP1(§24): 在庫が絞れなくてもBASE URLは保持される");

  return context;
}

function testStep2(step1: ConversationContext) {
  console.log("\n── STEP 2: 「埼玉です」だけが届く ──");

  // ── 会話の紐付け(§19/§26) ────────────────────────────────
  // 公式LINEは source.userId が一致するので、これだけで同じ会話に入る。
  const decision = decideConversationLink(
    {
      channel: "LINE",
      externalCustomerId: "Uabc123",
      externalConversationId: null,
      customerDisplayName: "大原",
      receivedAt: "2026-09-03T01:05:00.000Z",
      baseItemIds: [],
    },
    [candidate({ id: "conv-1", externalCustomerId: "Uabc123" })],
  );
  eq(decision.conversationId, "conv-1", "STEP2: STEP1と同じ会話に入る");

  // ── 確認事項への回答として読む(§22) ─────────────────────
  const answers = resolvePendingAnswers({ context: step1, messageText: STEP2 });
  eq(
    answers.map((a) => `${a.field}=${a.value}`),
    ["DESTINATION_PREFECTURE=埼玉県"],
    "STEP2(§22): 「埼玉です」を配送先の回答として解釈する",
  );

  // ── 文脈へマージ(§21) ────────────────────────────────────
  let context = clearPendingQuestions(step1, answers.map((a) => a.field));
  context = mergeConversationContext(context, {
    // 今回分かったのは配送先だけ。他は undefined = 触らない。
    shipping: { prefecture: "埼玉県", estimatedShippingCostYen: 8600, rank: "C" },
  });

  eq(context.identifiedProduct.baseItemId, "156144635", "STEP2: 商品を失わない");
  eq(context.identifiedProduct.baseItemUrl, BASE_URL, "STEP2: BASE URLを失わない");
  eq(context.identifiedProduct.baseProductName, "BoConcept Elba Lounge Chair", "STEP2: 商品名を失わない");
  eq(context.negotiation.requestedTotalPriceYen, 30000, "STEP2: 希望価格 30,000円を失わない");
  eq(context.negotiation.active, true, "STEP2: 値下げ交渉であることを失わない");
  eq(context.intents, ["NEGOTIATION"], "STEP2: 問い合わせ種別を失わない");
  eq(context.shipping.prefecture, "埼玉県", "STEP2: 配送先だけが埼玉県へ更新される");
  eq(context.pendingQuestions.length, 0, "STEP2: 配送先の確認待ちが解消する");

  // ── 顧客へ聞き直さない(§23) ──────────────────────────────
  //
  // 今回の本文にはURLが無い。以前は「商品URLをお送りください」になっていた。
  // 会話文脈にBASE商品IDがあるので、もう尋ねない。
  const basis = identificationBasis({
    status: "AMBIGUOUS",
    references: { baseItemIds: [], skus: [], inventoryIds: [], modelNumbers: [] },
    fromOperatorOrConversation: false,
    candidateCount: 2,
  });
  const urlRequest = decideUrlRequest({
    basis,
    status: "AMBIGUOUS",
    candidateCount: 2,
    requiresProduct: true,
    customerCanProvideUrl: true,
    customerAlreadySentUrl: context.identifiedProduct.baseItemId != null,
  });
  check(!urlRequest.requestUrl, "STEP2(§23): 商品URLを再質問しない", urlRequest.reason);

  // ── 送料を計算できる状態になっている ─────────────────────
  eq(context.shipping.estimatedShippingCostYen, 8600, "STEP2: 埼玉県への送料が入る");

  // ── BASEを引けなくても、顧客が送ったURLは残る(実機で見つけた抜け) ──
  //
  // BASE APIのトークンが無効で商品を取得できないと baseProducts が空になり、
  // 会話文脈にURLが1つも残らなかった。その結果2通目で「商品のURLをお送り
  // いただけますでしょうか」——顧客は1通目で送っている。
  // BASEを引けたかと、顧客がURLを送ったかは別の事実として持つ。
  const baseUnavailable = mergeConversationContext(emptyConversationContext(), {
    identifiedProduct: {
      baseItemId: "156144635",
      baseItemUrl: BASE_URL,
      baseStatus: "NOT_FOUND",
      baseProductName: null,
    },
  });
  eq(baseUnavailable.identifiedProduct.baseItemId, "156144635", "BASEを引けなくても商品IDは残る");
  eq(baseUnavailable.identifiedProduct.baseStatus, "NOT_FOUND", "「URLはあるが商品を取得できない」を区別できる");
  const stillNoAsk = decideUrlRequest({
    basis: "NONE",
    status: "NOT_FOUND",
    candidateCount: 0,
    requiresProduct: true,
    customerCanProvideUrl: true,
    customerAlreadySentUrl: baseUnavailable.identifiedProduct.baseItemId != null,
  });
  check(!stillNoAsk.requestUrl, "BASEを引けなくても商品URLを聞き直さない", stillNoAsk.reason);

  // ── 引き継いだ情報が通知に出る(§27) ──────────────────────
  const facts = knownFacts(context);
  const labels = facts.map((f) => f.label);
  check(labels.includes("対象商品"), "STEP2(§27): 引き継いだ情報に対象商品が出る");
  check(labels.includes("希望価格"), "STEP2(§27): 引き継いだ情報に希望価格が出る");
  check(labels.includes("配送先"), "STEP2(§27): 引き継いだ情報に配送先が出る");
  check(hasCarriedContext(context), "STEP2: 引き継いだ情報があると判定される");

  return context;
}

/* ══════════════════════════════════════════════════════════════════
 * §21 マージ規則
 * ══════════════════════════════════════════════════════════════════ */

function testMergeRules() {
  console.log("\n── §21 マージ規則 ──");

  const before = mergeConversationContext(emptyConversationContext(), {
    identifiedProduct: { baseItemId: "111", baseProductName: "椅子" },
    negotiation: { active: true, requestedTotalPriceYen: 30000 },
  });

  // undefined は既存を保つ。
  const untouched = mergeConversationContext(before, { shipping: { prefecture: "埼玉県" } });
  eq(untouched.identifiedProduct.baseItemId, "111", "undefined を渡した項目は消えない");
  eq(untouched.negotiation.requestedTotalPriceYen, 30000, "触れていない項目は消えない");

  // null は明示的に消す(話題が変わったときだけ使う)。
  const cleared = mergeConversationContext(before, { identifiedProduct: { baseItemId: null } });
  eq(cleared.identifiedProduct.baseItemId, null, "null を渡したときだけ消える");

  // 種別は積み上がる。
  const a = mergeConversationContext(emptyConversationContext(), { intents: ["NEGOTIATION"] });
  const b = mergeConversationContext(a, { intents: ["SHIPPING"] });
  eq(b.intents, ["NEGOTIATION", "SHIPPING"], "問い合わせ種別は積み上がる");

  // 話題の切り替え。
  check(!switchesProduct(before, []), "URLが無い短い返答では商品を切り替えない");
  check(!switchesProduct(before, ["111"]), "同じ商品URLなら切り替えない");
  check(switchesProduct(before, ["222"]), "別の商品URLが来たら切り替える");

  // 保存形式の往復。
  const restored = parseConversationContext(serializeConversationContext(before));
  eq(restored.identifiedProduct.baseItemId, "111", "JSONへ保存して読み戻せる");
  const broken = parseConversationContext("{壊れている");
  eq(broken.identifiedProduct.baseItemId, null, "壊れたJSONでも例外にせず空の文脈になる");
  check(broken.reviewReasons.length === 1, "壊れていたことは黙って無視せず理由として残る");
}

/* ══════════════════════════════════════════════════════════════════
 * §22 確認事項への回答
 * ══════════════════════════════════════════════════════════════════ */

function testPendingAnswers() {
  console.log("\n── §22 確認事項への回答 ──");

  const asked = detectAskedQuestions("ご希望のお届け日はございますでしょうか。", "2026-09-03T00:00:00.000Z");
  eq(asked.map((a) => a.field), ["REQUESTED_DELIVERY_DATE"], "配送希望日を尋ねたことを読み取れる");

  const waiting = addPendingQuestions(emptyConversationContext(), asked);
  const now = new Date("2026-09-03T00:00:00.000Z");
  const answers = resolvePendingAnswers({ context: waiting, messageText: "11日でお願いします", now });
  eq(
    answers.map((a) => `${a.field}=${a.value}`),
    ["REQUESTED_DELIVERY_DATE=2026-09-11"],
    "「11日でお願いします」を希望配送日として読み取れる",
  );

  // 直近の未来の日として読む。
  eq(resolveDayOnlyDate(11, new Date("2026-09-20T00:00:00.000Z")), "2026-10-11", "過ぎた日付なら翌月として読む");

  // **確認待ちでなければ読まない。** ここが安全性の要。
  const notWaiting = resolvePendingAnswers({
    context: emptyConversationContext(),
    messageText: "11日でお願いします",
    now,
  });
  eq(notWaiting, [], "確認待ちでないときは、本文から配送希望日を勝手に読まない");

  const notWaitingDestination = resolvePendingAnswers({
    context: emptyConversationContext(),
    messageText: "埼玉です",
    now,
  });
  eq(notWaitingDestination, [], "確認待ちでないときは、配送先も勝手に読まない");
}

/* ══════════════════════════════════════════════════════════════════
 * §19 会話の紐付け
 * ══════════════════════════════════════════════════════════════════ */

function candidate(over: Partial<ConversationCandidate>): ConversationCandidate {
  return {
    id: "c1",
    channel: "LINE",
    externalCustomerId: null,
    externalConversationId: null,
    customerDisplayName: null,
    lastMessageAt: "2026-09-03T00:00:00.000Z",
    lastOutgoingAt: "2026-09-03T00:00:00.000Z",
    status: "WAITING_FOR_REPLY",
    relatedBaseItemId: null,
    hasPendingQuestion: false,
    deletedAt: null,
    ...over,
  };
}

function testConversationLinking() {
  console.log("\n── §19 会話の紐付け ──");

  eq(normalizeDisplayName("大原　様"), "大原", "表示名のゆれを揃える");
  eq(normalizeDisplayName("Ｙａｍａｄａ"), "yamada", "全角英字も揃える");

  // 顧客IDが最優先。
  const byCustomer = decideConversationLink(
    {
      channel: "LINE",
      externalCustomerId: "U1",
      externalConversationId: null,
      customerDisplayName: "大原",
      receivedAt: "2026-09-03T01:00:00.000Z",
      baseItemIds: [],
    },
    [candidate({ id: "same-name", customerDisplayName: "大原" }), candidate({ id: "by-id", externalCustomerId: "U1" })],
  );
  eq(byCustomer.conversationId, "by-id", "顧客IDが一致する会話を選ぶ(同姓同名より優先)");

  // 顧客IDがあるのに一致しないなら新規。名前で探しに行かない。
  const newCustomer = decideConversationLink(
    {
      channel: "LINE",
      externalCustomerId: "U9",
      externalConversationId: null,
      customerDisplayName: "大原",
      receivedAt: "2026-09-03T01:00:00.000Z",
      baseItemIds: [],
    },
    [candidate({ id: "same-name", customerDisplayName: "大原" })],
  );
  eq(newCustomer.conversationId, null, "顧客IDが違えば、同姓同名でも結合しない");

  // チャネル側の会話ID(メルカリShops)。
  const byThread = decideConversationLink(
    {
      channel: "MERCARI_SHOPS",
      externalCustomerId: null,
      externalConversationId: "inq-77",
      customerDisplayName: null,
      receivedAt: "2026-09-03T01:00:00.000Z",
      baseItemIds: [],
    },
    [candidate({ id: "mercari-1", channel: "MERCARI_SHOPS", externalConversationId: "inq-77" })],
  );
  eq(byThread.conversationId, "mercari-1", "メルカリShopsは問い合わせIDで結合する");

  // 名前だけでは結合しない。
  const nameOnly = decideConversationLink(
    {
      channel: "LINE",
      externalCustomerId: null,
      externalConversationId: null,
      customerDisplayName: "大原",
      receivedAt: "2026-09-03T01:00:00.000Z",
      baseItemIds: [],
    },
    [candidate({ id: "same-name", customerDisplayName: "大原", hasPendingQuestion: false })],
  );
  eq(nameOnly.conversationId, null, "名前が一致するだけでは結合しない");

  // 確認質問の直後に同じ名前から短い回答 → 最優先で結合。
  const answering = decideConversationLink(
    {
      channel: "LINE",
      externalCustomerId: null,
      externalConversationId: null,
      customerDisplayName: "大原",
      receivedAt: "2026-09-03T01:00:00.000Z",
      baseItemIds: [],
    },
    [candidate({ id: "waiting", customerDisplayName: "大原", hasPendingQuestion: true })],
  );
  eq(answering.conversationId, "waiting", "確認質問の直後の回答は既存会話へ紐付ける");
  eq(answering.basis, "DISPLAY_NAME_AND_PENDING_QUESTION", "紐付けの根拠を記録する");

  // 回答待ちが2件あれば決められない。
  const ambiguous = decideConversationLink(
    {
      channel: "LINE",
      externalCustomerId: null,
      externalConversationId: null,
      customerDisplayName: "大原",
      receivedAt: "2026-09-03T01:00:00.000Z",
      baseItemIds: [],
    },
    [
      candidate({ id: "w1", customerDisplayName: "大原", hasPendingQuestion: true }),
      candidate({ id: "w2", customerDisplayName: "大原", hasPendingQuestion: true }),
    ],
  );
  eq(ambiguous.conversationId, null, "同姓同名で回答待ちが2件あれば結合しない");

  // 古すぎる回答は結合しない。
  const stale = decideConversationLink(
    {
      channel: "LINE",
      externalCustomerId: null,
      externalConversationId: null,
      customerDisplayName: "大原",
      receivedAt: "2026-09-20T01:00:00.000Z",
      baseItemIds: [],
    },
    [candidate({ id: "old", customerDisplayName: "大原", hasPendingQuestion: true })],
  );
  eq(stale.conversationId, null, "確認から日が経ちすぎた返事は結合しない");

  // 商品文脈の継続。
  const sameProduct = decideConversationLink(
    {
      channel: "LINE",
      externalCustomerId: null,
      externalConversationId: null,
      customerDisplayName: "大原",
      receivedAt: "2026-09-03T01:00:00.000Z",
      baseItemIds: ["156144635"],
    },
    [candidate({ id: "prod", customerDisplayName: "大原", relatedBaseItemId: "156144635" })],
  );
  eq(sameProduct.conversationId, "prod", "同じ商品の話が続いていれば結合する");

  // 完了済みの会話へは入れない。
  const finished = decideConversationLink(
    {
      channel: "LINE",
      externalCustomerId: null,
      externalConversationId: null,
      customerDisplayName: "大原",
      receivedAt: "2026-09-03T01:00:00.000Z",
      baseItemIds: [],
    },
    [candidate({ id: "done", customerDisplayName: "大原", hasPendingQuestion: true, status: "RESOLVED" })],
  );
  eq(finished.conversationId, null, "終了済みの会話へは入れない");
}

/* ══════════════════════════════════════════════════════════════════
 * §25 同時到着(lost update)
 * ══════════════════════════════════════════════════════════════════ */

/** 条件付き更新をきちんと評価する、最小のDynamoDB代役。 */
function fakeTable() {
  const rows = new Map<string, { inquiryContext?: string; inquiryContextVersion?: number }>();
  let conditionalFailures = 0;
  const deps: ContextStoreDeps = {
    conversationTable: "Conversation-test",
    now: () => "2026-09-03T00:00:00.000Z",
    send: async (command: unknown) => {
      const c = command as { constructor: { name: string }; input: Record<string, unknown> };
      const key = (c.input.Key as { id: string }).id;
      if (c.constructor.name === "GetCommand") {
        const row = rows.get(key);
        return row ? { Item: { ...row } } : {};
      }
      // UpdateCommand
      const values = c.input.ExpressionAttributeValues as Record<string, unknown>;
      const row = rows.get(key);
      const expected = values[":e"] as number;
      const existing = row?.inquiryContextVersion;
      if (existing !== undefined && existing !== expected) {
        conditionalFailures++;
        const err = new Error("The conditional request failed");
        err.name = "ConditionalCheckFailedException";
        throw err;
      }
      rows.set(key, {
        inquiryContext: values[":c"] as string,
        inquiryContextVersion: values[":v"] as number,
      });
      return {};
    },
  };
  return { deps, rows, conditionalFailures: () => conditionalFailures };
}

async function testConcurrentUpdates() {
  console.log("\n── §25 同一会話への同時到着 ──");

  const table = fakeTable();

  // 1通目の処理: 配送先を書く。
  const first = await saveConversationContextWith(table.deps, "conv-1", (current) =>
    mergeConversationContext(current, { shipping: { prefecture: "埼玉県" } }),
  );
  eq(first.saved, true, "1つ目の更新は保存できる");
  eq(first.version, 1, "版数が1になる");

  // 「埼玉です」と「できれば今週欲しいです」を、**同じ版を読んだ状態から**
  // 同時に書き戻す。素直に書くと後勝ちで片方が消える。
  const stale = (await loadConversationContextWith(table.deps, "conv-1")).context;

  // 片方が先に書き込む(版を進める)。
  await saveConversationContextWith(table.deps, "conv-1", (current) =>
    mergeConversationContext(current, { negotiation: { active: true, requestedTotalPriceYen: 30000 } }),
  );

  // もう片方は古い版を持っている。mutate は current を受け取るので、
  // 競合したら読み直して同じ変更をやり直す。
  let seenVersions: number[] = [];
  const second = await saveConversationContextWith(table.deps, "conv-1", (current) => {
    seenVersions.push(current.version);
    return mergeConversationContext(current, {
      order: { requestedDeliveryDate: "2026-09-11" },
    });
  });
  eq(second.saved, true, "競合しても最終的に保存できる");

  const finalContext = (await loadConversationContextWith(table.deps, "conv-1")).context;
  eq(finalContext.shipping.prefecture, "埼玉県", "最初の更新(配送先)が残っている");
  eq(finalContext.negotiation.requestedTotalPriceYen, 30000, "2つ目の更新(希望価格)が残っている");
  eq(finalContext.order.requestedDeliveryDate, "2026-09-11", "3つ目の更新(希望配送日)が残っている");
  check(stale.version < finalContext.version, "版数が進んでいる");
  check(seenVersions.length >= 1, "mutate が最新の値を受け取っている");
}

/* ══════════════════════════════════════════════════════════════════
 * §29-§40 商品情報の補完と送料
 * ══════════════════════════════════════════════════════════════════ */

function testDimensionExtraction() {
  console.log("\n── §39 商品説明からの寸法抽出 ──");

  const mm = extractDimensionsFromText("サイズ：W850 × D900 × H720 mm");
  eq(
    mm && [mm.widthCm, mm.depthCm, mm.heightCm, mm.confidence],
    ["85cm", "90cm", "72cm", "HIGH"],
    "W850 × D900 × H720 mm を読める",
  );

  const jp = extractDimensionsFromText("幅85cm 奥行90cm 高さ72cm");
  eq(
    jp && [jp.widthCm, jp.depthCm, jp.heightCm, jp.confidence],
    ["85cm", "90cm", "72cm", "HIGH"],
    "幅85cm 奥行90cm 高さ72cm を読める",
  );

  const zenkaku = extractDimensionsFromText("Ｗ８５０✕Ｄ９００✕Ｈ７２０ｍｍ");
  eq(
    zenkaku && [zenkaku.widthCm, zenkaku.depthCm, zenkaku.heightCm],
    ["85cm", "90cm", "72cm"],
    "全角・記号ゆれを吸収する",
  );

  const noUnit = extractDimensionsFromText("W850 D900 H720");
  eq(noUnit && noUnit.widthCm, "85cm", "単位が無くても、家具としてありえる方(mm)で読む");

  const cmNoUnit = extractDimensionsFromText("W85 D90 H72");
  eq(cmNoUnit && cmNoUnit.widthCm, "85cm", "小さい数値なら cm として読む");

  const bare = extractDimensionsFromText("85×90×72cm");
  eq(bare && bare.confidence, "LOW", "ラベルの無い3連は信頼度LOW(要確認)");

  // 座面高を高さとして拾わない。
  const seat = extractDimensionsFromText("W850 × D900 × H720 mm（SH420mm）");
  eq(seat && seat.heightCm, "72cm", "SH(座面高)を全高として読まない");

  const seatJp = extractDimensionsFromText("幅85cm 奥行90cm 座面高42cm 高さ72cm");
  eq(seatJp && seatJp.heightCm, "72cm", "座面高が先に書かれていても全高を採る");

  // 足りないものは読まない。
  eq(extractDimensionsFromText("幅85cmです"), null, "1辺だけでは寸法として採用しない");
  eq(extractDimensionsFromText("3人掛けソファ 2脚セット"), null, "寸法でない数値を寸法にしない");
  eq(extractDimensionsFromText(""), null, "空文字では何も読まない");

  // 桁がおかしいものは捨てる。
  eq(extractDimensionsFromText("W8500 D9000 H7200 cm"), null, "家具としてありえない値は採用しない");
}

function testAttributeExtraction() {
  console.log("\n── §31 属性の抽出 ──");

  const attrs = extractAttributesFromText(
    "素材：オーク無垢材\nカラー：ウォールナット\nブランド：BoConcept\n型番：Elba-2024\n重量：12kg",
  );
  eq(attrs.material, "オーク無垢材", "素材を読む");
  eq(attrs.color, "ウォールナット", "カラーを読む");
  eq(attrs.brand, "BoConcept", "ブランドを読む");
  eq(attrs.modelNumber, "Elba-2024", "型番を読む");
  eq(attrs.weight, "12kg", "重量を読む");

  const guessed = extractAttributesFromText("ブラウンの箱に入れてお届けします。オーク調の脚が特徴です。");
  eq(guessed.color, null, "ラベルが無ければ色を推測しない");
  eq(guessed.material, null, "ラベルが無ければ素材を推測しない");

  eq(descriptionToPlainText("<p>幅85cm</p><br/><div>奥行90cm</div>"), "幅85cm\n\n奥行90cm", "HTMLを平文にできる");
  const withTag = descriptionToPlainText('<img src="https://example.com/850.jpg"><p>W850 D900 H720 mm</p>');
  eq(extractDimensionsFromText(withTag)?.widthCm, "85cm", "タグ内のURLの数字を寸法として読まない");
}

function testShippingCompletion() {
  console.log("\n── §32/§38 在庫にサイズが無くてもBASEから補って送料まで出す ──");

  // 在庫にはサイズが無い。
  const inventoryDims = calculateShippingRankFromDimensions(null, null, null);
  eq(inventoryDims, null, "在庫の寸法だけでは配送ランクを出せない");

  // BASEの商品説明にはある。
  const baseDescription =
    "◎商品のご紹介\nBoConcept の Elba ラウンジチェアです。\n\n【サイズ】W850 × D900 × H720 mm（SH420mm）\n【素材】ファブリック";
  const extracted = extractDimensionsFromText(descriptionToPlainText(baseDescription));
  check(extracted != null, "BASEの商品説明から寸法を読める");

  const merged = calculateShippingRankFromDimensions(
    extracted!.widthCm,
    extracted!.depthCm,
    extracted!.heightCm,
  );
  check(merged != null, "補完した寸法で配送ランクを判定できる");
  eq(merged!.sumCm, 247, "3辺合計 85+90+72 = 247cm");
  check(typeof merged!.rank === "string" && merged!.rank.length > 0, `配送ランクが決まる(${merged!.rank})`);
  eq(extracted!.confidence, "HIGH", "ラベル付きなので信頼度HIGH(要確認にしない)");
}

/* ══════════════════════════════════════════════════════════════════
 * §27 社内LINE通知
 * ══════════════════════════════════════════════════════════════════ */

function testNotification() {
  console.log("\n── §27 社内LINE通知 ──");

  const summary = buildSummaryMessage({
    channel: "LINE",
    customerName: "大原",
    messageText: "埼玉です",
    intents: ["NEGOTIATION"],
    evidence: null,
    draftText: "ありがとうございます。埼玉県へのお届けでご案内いたします。",
    needsHumanReview: false,
    reviewReasons: [],
    logId: null,
    failureReason: null,
    carriedFacts: [
      { label: "対象商品", value: "BoConcept Elba Lounge Chair" },
      { label: "販売価格", value: "54,800円" },
      { label: "希望価格", value: "30,000円" },
      { label: "配送先", value: "埼玉県" },
    ],
    answeredQuestions: ["お届け先を確認中で、「埼玉」と回答がありました。"],
    productContextNotes: ["サイズ：BASE商品ページから補完(W850 / D900 / H720)。"],
    contextIssues: [],
  });

  check(summary.includes("■ 今回のお問い合わせ") || summary.includes("埼玉です"), "1通目に今回の本文が出る");
  check(summary.includes("■ 引き継いだ情報"), "1通目に「引き継いだ情報」が出る");
  check(summary.includes("BoConcept Elba Lounge Chair"), "引き継いだ対象商品が出る");
  check(summary.includes("希望価格：30,000円"), "引き継いだ希望価格が出る");
  check(summary.includes("配送先：埼玉県"), "引き継いだ配送先が出る");
  check(summary.includes("サイズ：BASE商品ページから補完"), "§33 サイズの出典が出る");
  check(summary.trimEnd().endsWith("【次のメッセージで返信提案します】"), "1通目の最後が所定の1行で終わる");

  const reply = buildReplyMessage("ありがとうございます。埼玉県へのお届けでご案内いたします。");
  check(!reply.includes("【返信提案】"), "2通目に【返信提案】の見出しを付けない");
  eq(reply, "ありがとうございます。埼玉県へのお届けでご案内いたします。", "2通目は顧客へ送る本文だけ");

  // 返信案が無ければ、来ない2通目を予告しない。
  const noDraft = buildSummaryMessage({
    channel: "LINE",
    customerName: null,
    messageText: "埼玉です",
    intents: [],
    evidence: null,
    draftText: null,
    needsHumanReview: true,
    reviewReasons: ["返信案を生成できませんでした。"],
    logId: null,
    failureReason: "AIの呼び出しに失敗しました。",
  });
  check(!noDraft.includes("【次のメッセージで返信提案します】"), "返信案が無いときは2通目を予告しない");
}

/* ══════════════════════════════════════════════════════════════════ */

async function main() {
  const step1 = testStep1();
  testStep2(step1);
  testMergeRules();
  testPendingAnswers();
  testConversationLinking();
  await testConcurrentUpdates();
  testDimensionExtraction();
  testAttributeExtraction();
  testShippingCompletion();
  testNotification();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
