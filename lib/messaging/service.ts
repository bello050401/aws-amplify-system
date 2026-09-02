import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { listAllPages } from "@/lib/amplify/listAll";
import { MESSAGE_PAGE_SIZE } from "./messagePaging";
import { deriveConversationStatus, deriveNeedsReply, buildMessagePreview, sortConversations } from "./conversationStatus";
import { sendLinePush } from "./line/adapter";
import { sendEmailReply } from "./email/sesAdapter";
import { buildReplySubject } from "./email/mime";
import type { ConversationRecord, ConversationWorkflowStatus, MessageRecord, MessageChannel, MessageSenderType } from "./types";

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
  isUnread?: boolean | null;
  lastReadAt?: string | null;
  lastReadBy?: string | null;
  workflowStatus?: ConversationWorkflowStatus | null;
  completedAt?: string | null;
  completedBy?: string | null;
  customerNameSource?: string | null;
  customerNameFetchedAt?: string | null;
  deletedAt?: string | null;
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
    // 既存行(このフィールドが無い時期に作られたもの)は、未読件数から
    // 推定する —— 過去データを壊さずに新しい仕組みへ載せるため。
    isUnread: row.isUnread ?? (row.unreadCount ?? 0) > 0,
    lastReadAt: row.lastReadAt ?? null,
    lastReadBy: row.lastReadBy ?? null,
    workflowStatus: row.workflowStatus ?? "NEW",
    completedAt: row.completedAt ?? null,
    completedBy: row.completedBy ?? null,
    customerNameSource: row.customerNameSource ?? null,
    customerNameFetchedAt: row.customerNameFetchedAt ?? null,
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
  contentKind?: MessageRecord["contentKind"] | null;
  attachmentStorageKey?: string | null;
  attachmentContentType?: string | null;
  attachmentSizeBytes?: number | null;
  attachmentStatus?: MessageRecord["attachmentStatus"] | null;
  attachmentError?: string | null;
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
    contentKind: row.contentKind ?? "TEXT",
    attachmentStorageKey: row.attachmentStorageKey ?? null,
    attachmentContentType: row.attachmentContentType ?? null,
    attachmentSizeBytes: row.attachmentSizeBytes ?? null,
    attachmentStatus: row.attachmentStatus ?? "NONE",
    attachmentError: row.attachmentError ?? null,
    externalSentAt: row.externalSentAt ?? null,
    deliveryStatus: row.deliveryStatus,
    aiGenerated: row.aiGenerated ?? false,
    createdAt: row.createdAt,
  };
}

/**
 * 会話一覧。**Messageは1件も読まない**(開いたときだけ取得する)。
 *
 * ── scope(2026-09-02 指示書§14) ──────────────────────────────
 *
 * 「対応済み」は参照頻度が低い一方、時間とともに際限なく増える。
 * 通常の一覧(未返信/返信済み/すべて)で毎回それを引くと、業務が
 * 進むほど画面が重くなる。scopeで**サーバー側の取得段階から**外す。
 *
 *   ACTIVE    … 対応済みを除く(未返信/返信済み/すべて/大原確認/市川確認)
 *   COMPLETED … 対応済みだけ
 *
 * 「すべて」= 現在対応中の全会話(対応済みを含まない)。対応済みは
 * archive として別タブで見る、という運用に合わせている。
 *
 * ── 全ページ辿る理由 ──────────────────────────────────────────
 *
 * DynamoDBのLimitはフィルタ適用前の読み取り件数の上限なので、
 * filter付きlistを1ページだけ読むと条件に合う会話を静かに取りこぼす
 * (lib/amplify/listAll.ts に実測値)。
 */
export type ConversationScope = "ACTIVE" | "COMPLETED";

export async function listConversations(scope: ConversationScope = "ACTIVE"): Promise<ConversationRecord[]> {
  const filter =
    scope === "COMPLETED"
      ? { workflowStatus: { eq: "COMPLETED" } }
      : { not: { workflowStatus: { eq: "COMPLETED" } } };

  const rows = await listAllPages<Parameters<typeof toConversationRecord>[0] & { deletedAt?: string | null }>(
    async (nextToken) => {
      const res = await serverDataClient.models.Conversation.list({
        filter,
        limit: 200,
        nextToken,
        ...inventoryAuthMode,
      });
      return {
        data: res.data as unknown as (Parameters<typeof toConversationRecord>[0] & { deletedAt?: string | null })[],
        nextToken: res.nextToken,
        errors: res.errors,
      };
    },
    { label: "会話一覧" },
  );

  // 論理削除済みは一覧・詳細・AI参照のいずれからも外す。行自体は
  // 監査のために残っている(amplify/data/resource.ts の deletedAt 参照)。
  const records = rows.filter((row) => !row.deletedAt).map(toConversationRecord);
  if (scope === "COMPLETED") {
    // 対応済みは「いつ片付いたか」で並べるのが業務上自然。
    // completedAt が無い既存行は最終メッセージ日時で代用する。
    return records.sort((a, b) => {
      const at = new Date(a.completedAt ?? a.lastMessageAt ?? 0).getTime();
      const bt = new Date(b.completedAt ?? b.lastMessageAt ?? 0).getTime();
      return bt - at;
    });
  }
  return sortConversations(records);
}

/**
 * 「対応済みにする」/「対応済みを解除する」(指示書§11/§12)。
 *
 * archive的な業務状態であって削除ではない。Message も画像も一切消さない。
 * 解除できるようにしてあるのは、誤操作と顧客からの再問い合わせのため。
 */
export async function setConversationCompleted(conversationId: string, completed: boolean, who: string | null): Promise<void> {
  const { errors } = await serverDataClient.models.Conversation.update(
    {
      id: conversationId,
      // 解除は「確認指定なし」へ戻す。大原確認/市川確認を復元しないのは、
      // 対応済みにした時点でその確認は終わっているという運用のため。
      workflowStatus: completed ? "COMPLETED" : "NEW",
      completedAt: completed ? new Date().toISOString() : null,
      completedBy: completed ? (who ?? undefined) : null,
      updatedBy: who ?? undefined,
    },
    inventoryAuthMode,
  );
  if (errors) throw new Error(`対応済みの変更に失敗しました: ${JSON.stringify(errors)}`);
}

/**
 * 人が会話を開いたので既読にする。
 *
 * 【なぜ専用の関数なのか】未読を落としてよいのは「人が画面で開いた」
 * ときだけで、AI生成・Webhook・バックグラウンド処理が会話を読み込んだ
 * だけでは落としてはいけない(§5)。読み取り関数の副作用にすると、
 * どこから呼ばれても既読になってしまい、この区別が保てない。
 * 呼び出し元は会話詳細を開くUIの1箇所だけにする。
 */
export async function markConversationRead(conversationId: string, who: string | null): Promise<void> {
  const now = new Date().toISOString();
  const { errors } = await serverDataClient.models.Conversation.update(
    { id: conversationId, isUnread: false, unreadCount: 0, lastReadAt: now, lastReadBy: who ?? undefined, updatedBy: who ?? undefined },
    inventoryAuthMode,
  );
  if (errors) throw new Error(`既読にできませんでした: ${JSON.stringify(errors)}`);
}

/** 業務ステータスの変更(手動)。既読/未読には触れない —— 別の軸だから。 */
export async function setConversationWorkflowStatus(
  conversationId: string,
  status: ConversationWorkflowStatus,
  who: string | null,
): Promise<void> {
  const { errors } = await serverDataClient.models.Conversation.update(
    { id: conversationId, workflowStatus: status, updatedBy: who ?? undefined },
    inventoryAuthMode,
  );
  if (errors) throw new Error(`ステータスを変更できませんでした: ${JSON.stringify(errors)}`);
}

/**
 * 会話の削除(論理削除)。
 *
 * 物理削除にしないのは、AI返信ログ・監査情報から参照され得るため
 * (§3「履歴・監査上残す必要があるデータを不用意に消さない」)。
 * 消すのはBELLOの管理画面上の見え方だけで、LINE等の外部サービス側の
 * メッセージには一切触れない。
 */
export async function softDeleteConversation(conversationId: string, who: string | null): Promise<void> {
  const now = new Date().toISOString();
  const { errors } = await serverDataClient.models.Conversation.update(
    { id: conversationId, deletedAt: now, deletedBy: who ?? undefined, updatedBy: who ?? undefined },
    inventoryAuthMode,
  );
  if (errors) throw new Error(`会話を削除できませんでした: ${JSON.stringify(errors)}`);
}

export async function getConversation(id: string): Promise<ConversationRecord | null> {
  const { data } = await serverDataClient.models.Conversation.get({ id }, inventoryAuthMode);
  return data ? toConversationRecord(data) : null;
}

/**
 * 第五ラウンド§6(P0-B) GSI/Scan監査: 以前は`.list({filter})`——
 * Messageテーブル全体(全会話ぶん、蓄積し続け上限がない)に対する
 * DynamoDB Scanだった。会話を開くたびに毎回発生する高頻度呼び出しで、
 * かつテーブル自体はInventoryHistoryと同じ「追記専用で無制限に増える」
 * 性質を持つため優先度が高い。schemaの`secondaryIndexes(index(
 * "conversationId"))`(synth出力で実測確認済みqueryField名
 * `listMessageByConversationId`)を使った真のQueryに切り替える。
 */
/**
 * 会話の全メッセージ。**送信・AI生成など「全件が要る」処理からだけ**呼ぶ。
 * 画面表示には listRecentMessages を使う(下)。
 */
export async function listMessages(conversationId: string): Promise<MessageRecord[]> {
  const rows = await listAllPages<Parameters<typeof toMessageRecord>[0]>(
    async (nextToken) => {
      const res = await serverDataClient.models.Message.listMessageByConversationId(
        { conversationId },
        { limit: 200, nextToken, ...inventoryAuthMode },
      );
      return { data: res.data as unknown as Parameters<typeof toMessageRecord>[0][], nextToken: res.nextToken, errors: res.errors };
    },
    { label: "メッセージ" },
  );
  return rows.map(toMessageRecord).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

/**
 * 会話を開いたときに読む分だけ(2026-09-02 指示書§16)。
 *
 * 会話が何年も続けばMessageは際限なく増える。最初から全件読むと、
 * 古い会話ほど開くのが遅くなる。新しい側から `limit` 件だけ読み、
 * 「過去のメッセージを読み込む」で続きを取る。
 *
 * GSIには createdAt のソートキーが無いため、DynamoDB側で「新しい順に
 * N件」を直接は取れない。会話単位のQueryで全ページ辿ってから末尾を
 * 切り出す —— **1会話ぶん**のQueryなので、一覧を開くたびに全会話の
 * 全Messageを読んでいた形とは桁が違う。件数が実用上の問題になるほど
 * 増えたら、そのときにGSIへソートキーを足す(いま足すと既存の
 * listMessageByConversationId の呼び出し名が変わり、影響範囲が広い)。
 */
export interface MessagePage {
  messages: MessageRecord[];
  /** これより古いメッセージがまだあるか。 */
  hasOlder: boolean;
  /** この会話のメッセージ総数(「残り○件」の表示用)。 */
  totalCount: number;
}


export async function listRecentMessages(conversationId: string, limit: number = MESSAGE_PAGE_SIZE): Promise<MessagePage> {
  const all = await listMessages(conversationId);
  const take = Math.max(1, limit);
  return {
    messages: all.slice(Math.max(0, all.length - take)),
    hasOlder: all.length > take,
    totalCount: all.length,
  };
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
  // 第五ラウンド§6(P0-B): externalMessageId用GSIを新規追加
  // (amplify/data/resource.ts参照)——Webhook受信のたびに走る
  // idempotency判定を、Messageテーブル全体へのScanから真のQueryへ。
  const { data: existingMessages } = await serverDataClient.models.Message.listMessageByExternalMessageId(
    { externalMessageId: params.externalMessageId },
    { ...inventoryAuthMode },
  );
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
    // 対応済みの会話へ新しい問い合わせが来たら、対応済みを解除して
    // 通常業務へ戻す(指示書§12/§26)。会話も画像も消さない ——
    // 状態だけを戻すので、過去のやり取りはそのまま残る。
    const reopened = conversation.workflowStatus === "COMPLETED";
    await serverDataClient.models.Conversation.update(
      {
        id: conversation.id,
        status,
        needsReply,
        unreadCount: (conversation.unreadCount ?? 0) + 1,
        isUnread: true,
        lastMessagePreview: preview,
        lastMessageAt: params.externalSentAt,
        lastIncomingAt: params.externalSentAt,
        ...(reopened ? { workflowStatus: "NEW" as const, completedAt: null, completedBy: null } : {}),
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

/**
 * 会話を「対応済み」へ手動で移す。
 *
 * 2026-09-02: UI上の「解決済み」は廃止し「対応済み」に統一した
 * (指示書§7)。既存の Conversation.status="RESOLVED" は**消さない**
 * —— 過去にこの状態にした会話の履歴を壊さないため。新しい正本は
 * workflowStatus="COMPLETED" で、こちらを両方立てて互換を保つ。
 *
 * needsReply を false にはしない。返信状態は「最新の受信より後に
 * 返信したか」という事実で、対応済みかどうかとは別の軸だから
 * (指示書§9/§24)。対応済みは一覧のスコープで除外される。
 */
export async function resolveConversation(conversationId: string, who: string | null): Promise<void> {
  await serverDataClient.models.Conversation.update(
    {
      id: conversationId,
      status: "RESOLVED",
      workflowStatus: "COMPLETED",
      completedAt: new Date().toISOString(),
      completedBy: who ?? undefined,
      updatedBy: who ?? undefined,
    },
    inventoryAuthMode,
  );
}
