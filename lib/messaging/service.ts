import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { deriveConversationStatus, deriveNeedsReply, buildMessagePreview, sortConversations } from "./conversationStatus";
import { sendLinePush } from "./line/adapter";
import { sendEmailReply } from "./email/sesAdapter";
import { buildReplySubject } from "./email/mime";
import type { ConversationRecord, MessageRecord, MessageChannel, MessageSenderType } from "./types";

/**
 * BELLO統合業務OS指示書(2026-08-30) §38-50: Message coreの唯一の
 * 読み書き窓口(lib/listing/service.tsと同じ「1ファイルへ書き込みを
 * 集約する」設計方針)。
 *
 * 【現状の実装範囲、正直に】(P6 = Priority 6での追加分)
 *   - LINE: app/api/line/webhook/route.tsが署名検証済みのWebhookを
 *     recordIncomingMessageへ渡す形で受信を実装済み。送信も
 *     lib/messaging/line/adapter.tsのsendLinePush経由で実際にLINE
 *     APIを呼ぶ(§46確認モーダル通過後のみ)。ただし実際のLINE公式
 *     アカウントのChannel Secret/Access Token設定・Webhook URL登録は
 *     ADMINが行う必要がある(BLOCKED_BY_USER — このアプリがまだ
 *     ライブ公開URLを持たないため、LINE Developers ConsoleへのWebhook
 *     URL登録もユーザー側の作業)。
 *   - Email: lib/messaging/email/sesAdapter.tsがAWS SES
 *     (SendEmailV2)経由で実際に送信を試みる。受信(SES Receiving→S3→
 *     取り込み)は検証済みの送信ドメイン(DNS設定含む、ユーザーの
 *     ビジネス判断が必要)が無いと構築できないため未実装
 *     (BLOCKED_BY_USER — 使用するドメイン自体が本アプリの設定項目
 *     ではなくユーザーの意思決定)。
 *   - Mercari問い合わせAPI/Yahoo!オークションストア: 引き続き未実装
 *     (lib/messaging/mercari/inquiryAdapter.ts参照 —
 *     BLOCKED_BY_EXTERNAL_SERVICE、公式仕様が確認できないため)。
 *   - TESTチャネルの会話は引き続き実際に「送信成功」として扱う
 *     (BELLO内で完結する安全なシミュレーション)。
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
 * §51/§87: 実チャネル(現状LINE)からの受信メッセージを取り込む共通の
 * 入口。同じchannel+externalCustomerIdの会話が既にあれば追記、無ければ
 * 新規Conversationを作る(§39 findOrCreate)。
 *
 * 冪等性(§51「redelivery-safe idempotency」): LINEはWebhookの
 * at-least-once配送を保証する(同じイベントが複数回届きうる)。
 * externalMessageId(LINEのmessage.id)で既存Messageを検索し、既にあれば
 * 何もせず終了する — 同じメッセージが二重に会話へ現れることを防ぐ。
 */
export async function recordIncomingMessage(params: {
  channel: MessageChannel;
  externalCustomerId: string;
  externalMessageId: string;
  body: string;
  externalSentAt: string;
  customerDisplayName?: string | null;
}): Promise<{ conversationId: string; messageId: string } | { deduped: true }> {
  const { data: existingMessages } = await serverDataClient.models.Message.list({
    filter: { externalMessageId: { eq: params.externalMessageId } },
    ...inventoryAuthMode,
  });
  if (existingMessages.length > 0) return { deduped: true };

  const { data: existingConversations } = await serverDataClient.models.Conversation.list({
    filter: { and: [{ channel: { eq: params.channel } }, { externalCustomerId: { eq: params.externalCustomerId } }] },
    ...inventoryAuthMode,
  });
  let conversation = existingConversations[0] ?? null;

  const preview = buildMessagePreview(params.body);
  if (!conversation) {
    const { data: created, errors } = await serverDataClient.models.Conversation.create(
      {
        channel: params.channel,
        externalCustomerId: params.externalCustomerId,
        customerDisplayName: params.customerDisplayName ?? null,
        status: "WAITING_FOR_REPLY",
        unreadCount: 1,
        needsReply: true,
        priority: "NORMAL",
        lastMessagePreview: preview,
        lastMessageAt: params.externalSentAt,
        lastIncomingAt: params.externalSentAt,
      },
      inventoryAuthMode,
    );
    if (errors || !created) throw new Error(`会話の作成に失敗しました: ${JSON.stringify(errors)}`);
    conversation = created;
  } else {
    const needsReply = deriveNeedsReply(params.externalSentAt, conversation.lastOutgoingAt ?? null);
    const status = deriveConversationStatus(needsReply, true, conversation.status);
    await serverDataClient.models.Conversation.update(
      {
        id: conversation.id,
        status,
        needsReply,
        unreadCount: (conversation.unreadCount ?? 0) + 1,
        lastMessagePreview: preview,
        lastMessageAt: params.externalSentAt,
        lastIncomingAt: params.externalSentAt,
      },
      inventoryAuthMode,
    );
  }

  const { data: message, errors: msgErrors } = await serverDataClient.models.Message.create(
    {
      conversationId: conversation.id,
      externalMessageId: params.externalMessageId,
      direction: "INBOUND",
      senderType: "CUSTOMER",
      body: params.body,
      contentType: "text",
      externalSentAt: params.externalSentAt,
      deliveryStatus: "RECEIVED",
    },
    inventoryAuthMode,
  );
  if (msgErrors || !message) throw new Error(`メッセージの保存に失敗しました: ${JSON.stringify(msgErrors)}`);

  return { conversationId: conversation.id, messageId: message.id };
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

  const draft = await serverDataClient.models.Message.get({ id: messageId }, inventoryAuthMode);
  const body = draft.data?.body ?? "";

  if (conversation.channel === "LINE") {
    if (!conversation.externalCustomerId) throw new Error("この会話にはLINEの送信先(userId)が記録されていません。");
    await sendLinePush(conversation.externalCustomerId, body); // §46確認モーダル通過後の実送信 — 失敗時はここでthrowされ、DRAFTのまま残る(SENTへ書き換えない)
  } else if (conversation.channel === "EMAIL") {
    if (!conversation.externalCustomerId) throw new Error("この会話には送信先のメールアドレスが記録されていません。");
    const priorMessages = await listMessages(conversationId);
    const latestIncoming = [...priorMessages].reverse().find((m) => m.direction === "INBOUND");
    await sendEmailReply({
      to: conversation.externalCustomerId,
      subject: buildReplySubject(conversation.subject),
      body,
      inReplyToExternalMessageId: latestIncoming?.externalMessageId ?? null,
    });
  } else if (conversation.channel !== "TEST") {
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
