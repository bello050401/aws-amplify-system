import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { deriveConversationStatus, deriveNeedsReply, buildMessagePreview, sortConversations } from "./conversationStatus";
import type { ConversationRecord, MessageRecord, MessageChannel, MessageSenderType } from "./types";

/**
 * BELLO統合業務OS指示書(2026-08-30) §38-50: Message coreの唯一の
 * 読み書き窓口(lib/listing/service.tsと同じ「1ファイルへ書き込みを
 * 集約する」設計方針)。
 *
 * 【現状の実装範囲、正直に】実チャネル(Mercari問い合わせAPI/LINE
 * Webhook/Email)からの受信も、実チャネルへの送信も未実装
 * (§39/§51以降=Priority 6の範囲、各外部サービスの実API調査が別途
 * 必要)。ここにあるのは:
 *   - Conversation/Messageの読み取り・一覧ソート(§121)
 *   - ADMIN限定のテスト会話作成(createTestConversation) — 実チャネル
 *     を介さずローカルで会話・メッセージのライフサイクル全体
 *     (受信→下書き→送信前確認→送信→REPLIED反映)を動作確認できる。
 *   - 返信下書きの保存(draftReply) — AI生成でも人力でも同じ経路。
 *   - 送信(sendReply) — TESTチャネルの会話だけは実際に「送信成功」
 *     として扱う(BELLO内で完結する安全なシミュレーションのため)。
 *     実チャネル(MERCARI_SHOPS/YAHOO_AUCTION/LINE/EMAIL)の会話へは
 *     明示的にエラーを投げ、「このチャネルへの送信は未実装」と正直に
 *     伝える — 実装していない送信を成功したことにしない(§157)。
 */

function toConversationRecord(row: {
  id: string;
  channel: MessageChannel;
  externalConversationId?: string | null;
  externalCustomerId?: string | null;
  customerDisplayName?: string | null;
  relatedInventoryId?: string | null;
  relatedListingId?: string | null;
  relatedOrderId?: string | null;
  subject?: string | null;
  status: ConversationRecord["status"];
  unreadCount?: number | null;
  needsReply?: boolean | null;
  priority?: ConversationRecord["priority"] | null;
  lastMessagePreview?: string | null;
  lastMessageAt?: string | null;
  lastIncomingAt?: string | null;
  lastOutgoingAt?: string | null;
  assignedUserId?: string | null;
  createdAt: string;
  updatedAt: string;
}): ConversationRecord {
  return {
    id: row.id,
    channel: row.channel,
    externalConversationId: row.externalConversationId ?? null,
    externalCustomerId: row.externalCustomerId ?? null,
    customerDisplayName: row.customerDisplayName ?? null,
    relatedInventoryId: row.relatedInventoryId ?? null,
    relatedListingId: row.relatedListingId ?? null,
    relatedOrderId: row.relatedOrderId ?? null,
    subject: row.subject ?? null,
    status: row.status,
    unreadCount: row.unreadCount ?? 0,
    needsReply: row.needsReply ?? false,
    priority: row.priority ?? "NORMAL",
    lastMessagePreview: row.lastMessagePreview ?? null,
    lastMessageAt: row.lastMessageAt ?? null,
    lastIncomingAt: row.lastIncomingAt ?? null,
    lastOutgoingAt: row.lastOutgoingAt ?? null,
    assignedUserId: row.assignedUserId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toMessageRecord(row: {
  id: string;
  conversationId: string;
  externalMessageId?: string | null;
  direction: MessageRecord["direction"];
  senderType: MessageSenderType;
  body: string;
  contentType?: string | null;
  externalSentAt?: string | null;
  deliveryStatus: MessageRecord["deliveryStatus"];
  aiGenerated?: boolean | null;
  createdAt: string;
}): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    externalMessageId: row.externalMessageId ?? null,
    direction: row.direction,
    senderType: row.senderType,
    body: row.body,
    contentType: row.contentType ?? null,
    externalSentAt: row.externalSentAt ?? null,
    deliveryStatus: row.deliveryStatus,
    aiGenerated: row.aiGenerated ?? false,
    createdAt: row.createdAt,
  };
}

/** §80: 一覧はConversationだけを全件取得する(Messageは開いたときだけ取得 — 「conversation listで全文messageを全部取得しない」)。 */
export async function listConversations(): Promise<ConversationRecord[]> {
  const { data, errors } = await serverDataClient.models.Conversation.list({ ...inventoryAuthMode });
  if (errors) throw new Error(`会話一覧の取得に失敗しました: ${JSON.stringify(errors)}`);
  return sortConversations(data.map(toConversationRecord));
}

export async function getConversation(id: string): Promise<ConversationRecord | null> {
  const { data } = await serverDataClient.models.Conversation.get({ id }, inventoryAuthMode);
  return data ? toConversationRecord(data) : null;
}

export async function listMessages(conversationId: string): Promise<MessageRecord[]> {
  const { data, errors } = await serverDataClient.models.Message.list({
    filter: { conversationId: { eq: conversationId } },
    ...inventoryAuthMode,
  });
  if (errors) throw new Error(`メッセージの取得に失敗しました: ${JSON.stringify(errors)}`);
  return data.map(toMessageRecord).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

/**
 * §166 Message Definition of Doneの動作確認用 — ADMIN限定
 * (app/actions/messaging.tsで権限強制)。実チャネルを一切介さず、
 * Conversation1件+INBOUND Message1件をその場で作る。
 */
export async function createTestConversation(input: { customerDisplayName: string; body: string }, who: string | null): Promise<ConversationRecord> {
  if (!input.body.trim()) throw new Error("メッセージ本文を入力してください。");
  const now = new Date().toISOString();

  const { data: conversation, errors: convErrors } = await serverDataClient.models.Conversation.create(
    {
      channel: "TEST",
      customerDisplayName: input.customerDisplayName.trim() || "テスト顧客",
      status: "WAITING_FOR_REPLY",
      unreadCount: 1,
      needsReply: true,
      priority: "NORMAL",
      lastMessagePreview: buildMessagePreview(input.body),
      lastMessageAt: now,
      lastIncomingAt: now,
      createdBy: who ?? undefined,
      updatedBy: who ?? undefined,
    },
    inventoryAuthMode,
  );
  if (convErrors || !conversation) throw new Error(`テスト会話の作成に失敗しました: ${JSON.stringify(convErrors)}`);

  const { errors: msgErrors } = await serverDataClient.models.Message.create(
    {
      conversationId: conversation.id,
      direction: "INBOUND",
      senderType: "CUSTOMER",
      body: input.body.trim(),
      contentType: "text",
      deliveryStatus: "RECEIVED",
      createdBy: who ?? undefined,
    },
    inventoryAuthMode,
  );
  if (msgErrors) throw new Error(`テストメッセージの作成に失敗しました: ${JSON.stringify(msgErrors)}`);

  return toConversationRecord(conversation);
}

/**
 * §44/§45: AI下書きでも人力でも同じ経路で保存する — deliveryStatus
 * DRAFTのまま、まだ送信しない。既存のDRAFTメッセージがあれば上書き
 * せず追加する(§135 Draft History相当 — 再生成のたびに前の下書きを
 * 消さない、という要件の最小実装。編集履歴のUIまでは今回用意していな
 * いが、データとしては残る)。
 */
export async function draftReply(conversationId: string, body: string, aiGenerated: boolean, who: string | null): Promise<MessageRecord> {
  if (!body.trim()) throw new Error("返信内容を入力してください。");
  const { data, errors } = await serverDataClient.models.Message.create(
    {
      conversationId,
      direction: "OUTBOUND",
      senderType: aiGenerated ? "AI" : "STAFF",
      body: body.trim(),
      contentType: "text",
      deliveryStatus: "DRAFT",
      aiGenerated,
      createdBy: who ?? undefined,
    },
    inventoryAuthMode,
  );
  if (errors || !data) throw new Error(`下書きの保存に失敗しました: ${JSON.stringify(errors)}`);
  return toMessageRecord(data);
}

/**
 * §46: 送信前確認モーダルはUI側の責務 — この関数は「確認後、実際に
 * 送信する」の実処理のみを担う。
 *
 * §157: 実装していないチャネルへの送信を成功したことにしない —
 * TESTチャネル以外は明示的にエラーを投げる。TESTチャネルはBELLO内で
 * 完結する安全なシミュレーションなので、実際にSENTへ遷移させ、
 * Conversation.lastOutgoingAt/statusも正しく更新する(§42の
 * 「返信済み」判定ロジックをTESTチャネルで最初から最後まで実地検証
 * できるようにするため)。
 */
export async function sendReply(conversationId: string, messageId: string, who: string | null): Promise<MessageRecord> {
  const conversation = await getConversation(conversationId);
  if (!conversation) throw new Error("対象の会話が見つかりません。");

  if (conversation.channel !== "TEST") {
    throw new Error(
      `${conversation.channel}チャネルへの送信は現時点で未実装です（外部API/Webhook連携の実装が必要 — 完了報告のBLOCKED_BY_EXTERNAL_SERVICE参照）。`,
    );
  }

  const { data: message, errors } = await serverDataClient.models.Message.update(
    { id: messageId, deliveryStatus: "SENT", externalSentAt: new Date().toISOString() },
    inventoryAuthMode,
  );
  if (errors || !message) throw new Error(`送信の記録に失敗しました: ${JSON.stringify(errors)}`);

  const nowIso = new Date().toISOString();
  const needsReply = deriveNeedsReply(conversation.lastIncomingAt, nowIso);
  const status = deriveConversationStatus(needsReply, conversation.lastIncomingAt !== null, conversation.status);
  await serverDataClient.models.Conversation.update(
    {
      id: conversationId,
      status,
      needsReply,
      lastOutgoingAt: nowIso,
      lastMessageAt: nowIso,
      lastMessagePreview: buildMessagePreview(message.body),
      updatedBy: who ?? undefined,
    },
    inventoryAuthMode,
  );

  return toMessageRecord(message);
}

/** §42: 会話を「解決済み」へ手動で移す(needsReplyの自動判定の対象外にする)。 */
export async function resolveConversation(conversationId: string, who: string | null): Promise<void> {
  await serverDataClient.models.Conversation.update(
    { id: conversationId, status: "RESOLVED", needsReply: false, updatedBy: who ?? undefined },
    inventoryAuthMode,
  );
}
