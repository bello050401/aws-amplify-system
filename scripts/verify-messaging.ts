/**
 * BELLO統合業務OS指示書(2026-08-30) §38-50: Message coreの純粋ロジック
 * (lib/messaging/conversationStatus.ts)のstandalone verification —
 * scripts/verify-zaico-sync.ts/verify-listing.tsと同じ方針(no test
 * framework installed in this repo)。
 *
 * Run with: npm run verify:messaging
 * (server-onlyなAWS接続コードには触れないため、
 * scripts/with-server-only-stub.cjs経由でなくても動くが、他のverify
 * scriptと呼び出し方を揃えるため同じ経路にしてある。)
 */
import { deriveNeedsReply, deriveConversationStatus, buildMessagePreview, sortConversations } from "@/lib/messaging/conversationStatus";
import { recordIncomingWebhookMessageWith, type WebhookStoreDeps } from "@/lib/messaging/webhookStore";
import type { ConversationRecord } from "@/lib/messaging/types";
import {
  CONVERSATION_FILTERS,
  CONVERSATION_FILTER_LABEL,
  DEFAULT_CONVERSATION_FILTER,
  SELECTABLE_WORKFLOW_STATUSES,
  WORKFLOW_STATUS_LABEL,
} from "@/lib/messaging/types";

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

function testDeriveNeedsReply() {
  assertTrue(!deriveNeedsReply(null, null), "deriveNeedsReply: no incoming ever -> not needing reply");
  assertTrue(deriveNeedsReply("2026-01-01T00:00:00.000Z", null), "deriveNeedsReply: incoming exists, never replied -> needs reply");
  assertTrue(
    !deriveNeedsReply("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"),
    "deriveNeedsReply: a reply sent after the latest incoming -> REPLIED (not needing reply)",
  );
  assertTrue(
    deriveNeedsReply("2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
    "deriveNeedsReply: a new incoming after the last reply -> needs reply again (§42's exact scenario)",
  );
}

function testDeriveConversationStatus() {
  assertEqual(deriveConversationStatus(false, false, "OPEN"), "OPEN", "deriveConversationStatus: no incoming yet stays OPEN");
  assertEqual(deriveConversationStatus(true, true, "OPEN"), "WAITING_FOR_REPLY", "deriveConversationStatus: needs reply -> WAITING_FOR_REPLY");
  assertEqual(deriveConversationStatus(false, true, "WAITING_FOR_REPLY"), "REPLIED", "deriveConversationStatus: replied -> REPLIED");
  assertEqual(
    deriveConversationStatus(true, true, "RESOLVED"),
    "RESOLVED",
    "deriveConversationStatus: a manually-RESOLVED conversation is never overridden by the timeline calculation",
  );
  assertEqual(deriveConversationStatus(true, true, "ARCHIVED"), "ARCHIVED", "deriveConversationStatus: ARCHIVED is likewise never overridden");
}

function testBuildMessagePreview() {
  assertEqual(buildMessagePreview("こんにちは"), "こんにちは", "buildMessagePreview: a short message is returned as-is");
  assertEqual(buildMessagePreview("行1\n行2\n行3"), "行1 行2 行3", "buildMessagePreview: newlines collapse to spaces for a single-line list row");
  const long = "あ".repeat(100);
  assertEqual(buildMessagePreview(long, 60), `${"あ".repeat(60)}…`, "buildMessagePreview: truncates long bodies with an ellipsis");
}

function testSortConversations() {
  const rows: Pick<ConversationRecord, "needsReply" | "lastMessageAt" | "id">[] = [
    { id: "replied-recent", needsReply: false, lastMessageAt: "2026-01-05T00:00:00.000Z" },
    { id: "needs-reply-old", needsReply: true, lastMessageAt: "2026-01-01T00:00:00.000Z" },
    { id: "needs-reply-new", needsReply: true, lastMessageAt: "2026-01-03T00:00:00.000Z" },
    { id: "replied-old", needsReply: false, lastMessageAt: "2026-01-02T00:00:00.000Z" },
  ];
  const sorted = sortConversations(rows).map((r) => r.id);
  assertEqual(
    sorted,
    ["needs-reply-new", "needs-reply-old", "replied-recent", "replied-old"],
    "sortConversations: needsReply group always comes first (§121 「返信済みが未返信を埋もれさせない」), each group by lastMessageAt desc",
  );

  const tie: Pick<ConversationRecord, "needsReply" | "lastMessageAt" | "id">[] = [
    { id: "b", needsReply: true, lastMessageAt: "2026-01-01T00:00:00.000Z" },
    { id: "a", needsReply: true, lastMessageAt: "2026-01-01T00:00:00.000Z" },
  ];
  assertEqual(sortConversations(tie).map((r) => r.id), ["a", "b"], "sortConversations: an exact tie breaks stably by id");
}


// ─────────────────────────────────────────────────────────────────────
// Webhook受信の保存経路(lib/messaging/webhookStore.ts)。
//
// LINE webhookは未認証POSTで、Cookieもユーザーセッションも無い。そのため
// AppSync経由の recordIncomingMessage は必ず失敗し、受信メッセージが一件も
// 保存されていなかった。その修正としてDynamoDB直書きの経路を足したので、
// 「新規会話を作る/既存会話へ足す/再送を弾く」という分岐を実AWS無しで固定する。
//
// deps.sendへ渡された実際のコマンドを検査する。「例外が出ないこと」だけを
// 確かめても、違うテーブルや違う式を送っていることには気づけない。

interface SentCommand {
  name: string;
  input: Record<string, any>;
}

/** DynamoDBの代わりに、送られたコマンドを記録して定型応答を返す。 */
function fakeDynamo(responses: { existingMessage?: boolean; conversation?: Record<string, unknown> | null }) {
  const sent: SentCommand[] = [];
  let idCounter = 0;
  const deps: WebhookStoreDeps = {
    conversationTable: "Conversation-test",
    messageTable: "Message-test",
    newId: () => `id-${++idCounter}`,
    now: () => "2026-08-31T12:00:00.000Z",
    send: async (command: any) => {
      const name = command?.constructor?.name ?? "Unknown";
      sent.push({ name, input: command.input });
      if (name === "QueryCommand") return { Items: responses.existingMessage ? [{ id: "already" }] : [] };
      if (name === "ScanCommand") return { Items: responses.conversation ? [responses.conversation] : [] };
      return {};
    },
  };
  return { deps, sent };
}

const incoming = {
  channel: "LINE" as const,
  externalCustomerId: "Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  externalMessageId: "line-msg-1",
  body: "ソファの在庫はありますか",
  externalSentAt: "2026-08-31T11:59:00.000Z",
};

async function testWebhookStoreCreatesConversation() {
  const { deps, sent } = fakeDynamo({ conversation: null });
  const result = await recordIncomingWebhookMessageWith(deps, incoming);

  assertEqual(result, { conversationId: "id-1", messageId: "id-2" }, "webhookStore: 新規顧客なら会話とメッセージを1件ずつ作る");
  assertEqual(
    sent.map((c) => c.name),
    ["QueryCommand", "ScanCommand", "PutCommand", "PutCommand"],
    "webhookStore: 重複判定→会話検索→会話作成→メッセージ作成の順で送る",
  );

  const dedupeQuery = sent[0].input;
  assertEqual(dedupeQuery.TableName, "Message-test", "webhookStore: 重複判定はMessageテーブルへ問い合わせる");
  assertEqual(dedupeQuery.IndexName, "messagesByExternalMessageId", "webhookStore: 重複判定はexternalMessageIdのGSIを使う(全件Scanにしない)");

  const conversation = sent[2].input.Item;
  assertEqual(sent[2].input.TableName, "Conversation-test", "webhookStore: 会話はConversationテーブルへ入れる");
  assertEqual(conversation.channel, "LINE", "webhookStore: 会話のchannelは受信チャネル");
  assertEqual(conversation.externalCustomerId, incoming.externalCustomerId, "webhookStore: 会話に送信者のLINE userIdを保存する");
  assertEqual(conversation.status, "WAITING_FOR_REPLY", "webhookStore: 新規受信は未返信(WAITING_FOR_REPLY)で始まる");
  assertEqual(conversation.needsReply, true, "webhookStore: 新規受信はneedsReply=true(一覧で先頭に出るための値)");
  assertEqual(conversation.unreadCount, 1, "webhookStore: 新規会話の未読は1件");
  assertEqual(conversation.lastMessagePreview, incoming.body, "webhookStore: プレビューは本文から作る");
  assertEqual(conversation.lastIncomingAt, incoming.externalSentAt, "webhookStore: lastIncomingAtはLINE側の送信時刻(受信を処理した時刻ではない)");

  const message = sent[3].input.Item;
  assertEqual(sent[3].input.TableName, "Message-test", "webhookStore: メッセージはMessageテーブルへ入れる");
  assertEqual(message.conversationId, "id-1", "webhookStore: メッセージは今作った会話に紐づく");
  assertEqual(message.direction, "INBOUND", "webhookStore: 受信メッセージはINBOUND");
  assertEqual(message.senderType, "CUSTOMER", "webhookStore: 送信者は顧客");
  assertEqual(message.deliveryStatus, "RECEIVED", "webhookStore: 受信済みとして保存する");
  assertEqual(message.externalMessageId, incoming.externalMessageId, "webhookStore: 再送の重複判定キーを必ず保存する(無いと次回の判定が効かない)");
  assertEqual(message.aiGenerated, false, "webhookStore: 顧客の発言をAI生成として記録しない");
}

async function testWebhookStoreAppendsToExistingConversation() {
  const { deps, sent } = fakeDynamo({
    conversation: { id: "conv-existing", status: "REPLIED", unreadCount: 2, lastOutgoingAt: "2026-08-31T10:00:00.000Z" },
  });
  const result = await recordIncomingWebhookMessageWith(deps, incoming);

  assertEqual(result, { conversationId: "conv-existing", messageId: "id-1" }, "webhookStore: 既存会話があれば新しい会話を作らず、その会話へ足す");
  assertEqual(
    sent.map((c) => c.name),
    ["QueryCommand", "ScanCommand", "UpdateCommand", "PutCommand"],
    "webhookStore: 既存会話はPutで上書きせずUpdateする(担当者・優先度など他の項目を消さないため)",
  );

  const update = sent[2].input;
  assertEqual(update.Key, { id: "conv-existing" }, "webhookStore: 更新対象は見つかった会話");
  assertEqual(update.ExpressionAttributeNames, { "#s": "status" }, "webhookStore: statusはDynamoDBの予約語なので必ず別名にする");
  assertEqual(update.ExpressionAttributeValues[":u"], 3, "webhookStore: 未読件数は既存値+1(2→3)");
  assertEqual(update.ExpressionAttributeValues[":n"], true, "webhookStore: 前回返信より後の受信なので、再びneedsReply=trueへ戻る");
  assertEqual(update.ExpressionAttributeValues[":s"], "WAITING_FOR_REPLY", "webhookStore: REPLIEDだった会話が新着でWAITING_FOR_REPLYへ戻る");
  assertTrue(!update.UpdateExpression.includes("createdAt"), "webhookStore: 既存会話のcreatedAtは書き換えない");
}

async function testWebhookStoreKeepsManuallyResolvedStatus() {
  const { deps, sent } = fakeDynamo({
    conversation: { id: "conv-resolved", status: "RESOLVED", unreadCount: 0, lastOutgoingAt: null },
  });
  await recordIncomingWebhookMessageWith(deps, incoming);
  assertEqual(
    sent[2].input.ExpressionAttributeValues[":s"],
    "RESOLVED",
    "webhookStore: 人が解決済みにした会話を受信だけで差し戻さない(deriveConversationStatusの取り決めをこの経路でも守る)",
  );
}

async function testWebhookStoreDedupesResentMessage() {
  const { deps, sent } = fakeDynamo({ existingMessage: true, conversation: null });
  const result = await recordIncomingWebhookMessageWith(deps, incoming);

  assertEqual(result, { deduped: true }, "webhookStore: 取り込み済みのexternalMessageIdは重複として返す");
  assertEqual(
    sent.map((c) => c.name),
    ["QueryCommand"],
    "webhookStore: 重複と分かったら以降は一切書き込まない(LINEの再送で二重登録しない)",
  );
}

/**
 * 2026-09-02 指示書§2/§31: 上部フィルタの並びを固定する。
 *
 *   未返信 ｜ 返信済み ｜ すべて ｜ 大原確認 ｜ 市川確認 ｜ 対応済み
 *
 * 並びは lib/messaging/types.ts の CONVERSATION_FILTERS が正本で、UIは
 * その配列をそのままmapする。ここが通っている限り、画面のタブ順は変わらない。
 */
function testConversationFilterOrder() {
  assertEqual(
    CONVERSATION_FILTERS.map((f) => CONVERSATION_FILTER_LABEL[f]),
    // 商品確認待ちは業務ステータス側のタブ群の先頭。返信状態(未返信/
    // 返信済み)とは別の軸なので、そちらへ混ぜない。
    ["未返信", "返信済み", "すべて", "商品確認待ち", "大原確認", "市川確認", "対応済み"],
    "フィルタの並びが指定どおり",
  );
  assertEqual(CONVERSATION_FILTER_LABEL[CONVERSATION_FILTERS[0]], "未返信", "先頭は未返信");
  assertEqual(CONVERSATION_FILTER_LABEL[CONVERSATION_FILTERS[CONVERSATION_FILTERS.length - 1]], "対応済み", "末尾は対応済み");
  assertEqual(DEFAULT_CONVERSATION_FILTER, "UNREPLIED", "初期表示は未返信(すべてではない)");

  // 廃止したフィルタが残っていないこと。
  const labels = CONVERSATION_FILTERS.map((f) => CONVERSATION_FILTER_LABEL[f]);
  assertTrue(!labels.includes("未読"), "「未読」フィルタは存在しない");
  assertTrue(!labels.includes("要返信"), "「要返信」フィルタは存在しない");
  assertTrue(!labels.includes("解決済み"), "「解決済み」フィルタは存在しない");
}

/**
 * §24/§25: 返信状態と業務ステータスは別の軸。
 */
function testReplyStateAndWorkflowAreSeparate() {
  // 人が操作できる業務ステータスに「返信済み」は含まない。
  assertEqual(
    SELECTABLE_WORKFLOW_STATUSES.map((s) => WORKFLOW_STATUS_LABEL[s]),
    ["商品確認待ち", "大原確認", "市川確認", "対応済み"],
    "業務ステータスとして選べるものに「返信済み」は含めない",
  );
  // 既存データの NEW / REPLIED はどちらも「確認指定なし」として読む。
  assertEqual(WORKFLOW_STATUS_LABEL.NEW, "確認指定なし", "旧NEWは確認指定なしとして表示");
  assertEqual(WORKFLOW_STATUS_LABEL.REPLIED, "確認指定なし", "旧REPLIEDも確認指定なしとして表示(返信状態は別軸)");

  // 「大原確認」中でも未返信という事実は保持される。
  // needsReply は最新の受信と最新の送信の時刻だけで決まり、
  // workflowStatus を一切見ない。
  assertTrue(deriveNeedsReply("2026-09-02T09:15:00Z", "2026-09-02T09:10:00Z"), "顧客の再受信後は未返信");
  assertTrue(!deriveNeedsReply("2026-09-02T09:15:00Z", "2026-09-02T09:20:00Z"), "返信後は返信済み");
  assertTrue(deriveNeedsReply("2026-09-02T09:00:00Z", null), "一度も返信していなければ未返信");
}

/**
 * §5/§25: 開いただけ・AI案を作っただけ・下書きを保存しただけでは
 * 「返信済み」にならない。
 *
 * deriveNeedsReply が見るのは lastOutgoingAt だけで、これは**送信が
 * 成功したときにしか更新されない**。開く/AI生成/下書き保存はどれも
 * lastOutgoingAt を触らないので、この関数の入力が変わらない。
 */
function testOnlyRealSendClearsUnreplied() {
  const lastIncoming = "2026-09-02T09:00:00Z";
  assertTrue(deriveNeedsReply(lastIncoming, null), "受信のみ → 未返信");
  // 開く/AI生成/下書き保存は lastOutgoingAt を更新しない = 入力が同じ
  assertTrue(deriveNeedsReply(lastIncoming, null), "会話を開いても未返信のまま");
  assertTrue(deriveNeedsReply(lastIncoming, null), "AI返信案を作っても未返信のまま");
  assertTrue(deriveNeedsReply(lastIncoming, null), "下書きを保存しても未返信のまま");
  // 実送信で lastOutgoingAt が入って初めて返信済みへ
  assertTrue(!deriveNeedsReply(lastIncoming, "2026-09-02T09:30:00Z"), "実送信が成功して初めて返信済み");
  // 再受信で未返信へ戻る
  assertTrue(deriveNeedsReply("2026-09-02T10:00:00Z", "2026-09-02T09:30:00Z"), "再受信で未返信へ戻る");
}

async function main() {
  testConversationFilterOrder();
  testReplyStateAndWorkflowAreSeparate();
  testOnlyRealSendClearsUnreplied();
  testDeriveNeedsReply();
  testDeriveConversationStatus();
  testBuildMessagePreview();
  testSortConversations();
  await testWebhookStoreCreatesConversation();
  await testWebhookStoreAppendsToExistingConversation();
  await testWebhookStoreKeepsManuallyResolvedStatus();
  await testWebhookStoreDedupesResentMessage();

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
