import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { unwrapList, unwrapWriteRequired } from "@/lib/amplify/listAll";
import type { MessageChannel } from "@/lib/messaging/types";
import type { DeliveryStatus } from "./deliveryPolicy";
import type { NotificationPriority } from "./format";

/**
 * 2026-09-03 指示書 §8: NotificationDelivery の読み書き。
 *
 * 通知は問い合わせ本体とは別トランザクションで扱う。送信に失敗しても
 * Conversation / Message / ReplyDraft は既に確定しているので、
 * **問い合わせが失われることはない**。ここが担うのは「その問い合わせを
 * 通知できたか」という一点だけ。
 */

export interface NotificationDeliveryRecord {
  id: string;
  dedupeKey: string;
  conversationId: string | null;
  sourceMessageId: string | null;
  replyDraftId: string | null;
  channel: MessageChannel | null;
  priority: NotificationPriority | null;
  status: DeliveryStatus;
  summaryText: string | null;
  replyText: string | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  sentAt: string | null;
  errorMessage: string | null;
  /** 解析側の状態(§7)。通知の status とは別軸。 */
  analysisStatus: string | null;
  /** メール由来の問い合わせ種別(§9)。 */
  inquiryKind: string | null;
  /** 取引メッセージの注文番号(§9)。 */
  orderNumber: string | null;
  /** この通知を置き換えた新しい通知のid(§10)。 */
  supersededBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DeliveryRow {
  id: string;
  dedupeKey: string;
  conversationId?: string | null;
  sourceMessageId?: string | null;
  replyDraftId?: string | null;
  channel?: MessageChannel | null;
  priority?: NotificationPriority | null;
  status: DeliveryStatus;
  summaryText?: string | null;
  replyText?: string | null;
  attemptCount?: number | null;
  lastAttemptAt?: string | null;
  sentAt?: string | null;
  errorMessage?: string | null;
  analysisStatus?: string | null;
  inquiryKind?: string | null;
  orderNumber?: string | null;
  supersededBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

function toRecord(row: DeliveryRow): NotificationDeliveryRecord {
  return {
    id: row.id,
    dedupeKey: row.dedupeKey,
    conversationId: row.conversationId ?? null,
    sourceMessageId: row.sourceMessageId ?? null,
    replyDraftId: row.replyDraftId ?? null,
    channel: row.channel ?? null,
    priority: row.priority ?? null,
    status: row.status,
    summaryText: row.summaryText ?? null,
    replyText: row.replyText ?? null,
    attemptCount: row.attemptCount ?? 0,
    lastAttemptAt: row.lastAttemptAt ?? null,
    sentAt: row.sentAt ?? null,
    errorMessage: row.errorMessage ?? null,
    analysisStatus: row.analysisStatus ?? null,
    inquiryKind: row.inquiryKind ?? null,
    orderNumber: row.orderNumber ?? null,
    supersededBy: row.supersededBy ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * dedupeKey で既存の通知を引く。**GSI経由**(secondaryIndexes の
 * dedupeKey)で引き、filter付きlistにしない —— この判定はWebhookを受ける
 * たびに走るので、テーブル全体のScanになると受信のたびに費用と時間が
 * 積み上がる。
 *
 * 取得に失敗したら例外にする。ここを「見つからなかった」に丸めると、
 * 既に送った通知をもう一度送ることになる(lib/amplify/listAll.ts の
 * unwrapList のコメントにある「重複を防ぐ判定」がまさにこれ)。
 */
export async function findDeliveryByDedupeKey(dedupeKey: string): Promise<NotificationDeliveryRecord | null> {
  const rows = unwrapList(
    await serverDataClient.models.NotificationDelivery.listNotificationDeliveryByDedupeKey(
      { dedupeKey },
      { ...inventoryAuthMode, limit: 2 },
    ),
    "通知履歴",
  ) as unknown as DeliveryRow[];
  if (rows.length === 0) return null;
  // 同じキーで2件できてしまった場合でも、古いほうを正として扱う
  // (新しいほうは競合で生まれた重複なので、そちらを基準に送ると二重送信になる)。
  const sorted = [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return toRecord(sorted[0]);
}

export async function createPendingDelivery(params: {
  dedupeKey: string;
  conversationId: string | null;
  sourceMessageId: string | null;
  replyDraftId: string | null;
  channel: MessageChannel;
  priority: NotificationPriority;
  summaryText: string;
  replyText: string | null;
  createdBy: string | null;
  analysisStatus?: string | null;
  inquiryKind?: string | null;
  orderNumber?: string | null;
}): Promise<NotificationDeliveryRecord> {
  const row = unwrapWriteRequired(
    await serverDataClient.models.NotificationDelivery.create(
      {
        dedupeKey: params.dedupeKey,
        conversationId: params.conversationId ?? undefined,
        sourceMessageId: params.sourceMessageId ?? undefined,
        replyDraftId: params.replyDraftId ?? undefined,
        channel: params.channel,
        priority: params.priority,
        status: "PENDING",
        summaryText: params.summaryText,
        replyText: params.replyText ?? undefined,
        attemptCount: 0,
        createdBy: params.createdBy ?? undefined,
        analysisStatus: params.analysisStatus ?? undefined,
        inquiryKind: params.inquiryKind ?? undefined,
        orderNumber: params.orderNumber ?? undefined,
      },
      inventoryAuthMode,
    ),
    "通知履歴の作成",
  ) as unknown as DeliveryRow;
  return toRecord(row);
}

async function patch(id: string, fields: Record<string, unknown>): Promise<NotificationDeliveryRecord> {
  const row = unwrapWriteRequired(
    await serverDataClient.models.NotificationDelivery.update({ id, ...fields }, inventoryAuthMode),
    "通知履歴の更新",
  ) as unknown as DeliveryRow;
  return toRecord(row);
}

/** 送信を始める直前。attemptCount をここで増やす(送信前に増やすので、途中で落ちても回数が残る)。 */
export async function markDeliveryProcessing(id: string, attemptCount: number): Promise<NotificationDeliveryRecord> {
  return patch(id, { status: "PROCESSING", attemptCount, lastAttemptAt: new Date().toISOString() });
}

export async function markDeliverySent(id: string): Promise<NotificationDeliveryRecord> {
  return patch(id, { status: "SENT", sentAt: new Date().toISOString(), errorMessage: null });
}

export async function markDeliveryFailed(id: string, status: DeliveryStatus, errorMessage: string): Promise<NotificationDeliveryRecord> {
  return patch(id, { status, errorMessage });
}

/**
 * 本文を差し替える。DEAD_LETTER から手動で再送するとき、最新の返信案で
 * 送り直せるようにする(古い文面をそのまま再送すると、その間に直した
 * 内容が反映されない)。
 */
export async function updateDeliveryContent(params: {
  id: string;
  summaryText: string;
  replyText: string | null;
  priority: NotificationPriority;
  replyDraftId: string | null;
}): Promise<NotificationDeliveryRecord> {
  return patch(params.id, {
    summaryText: params.summaryText,
    replyText: params.replyText ?? undefined,
    priority: params.priority,
    replyDraftId: params.replyDraftId ?? undefined,
  });
}

/**
 * 古い通知を「置き換え済み」にする(§10)。
 *
 * **消さない。** 本文抽出の不具合で作られた通知を再処理したとき、元の
 * レコードを残したまま置き換え先を指しておくことで、どの通知がどの再処理で
 * 差し替わったかを後から追える。
 */
export async function markDeliverySuperseded(id: string, supersededBy: string | null, reason: string): Promise<void> {
  await patch(id, { status: "SUPERSEDED", supersededBy: supersededBy ?? undefined, errorMessage: reason });
}

/** 状態を PENDING へ戻して再送可能にする(DEAD_LETTER からの手動再送用)。 */
export async function resetDeliveryForRetry(id: string): Promise<NotificationDeliveryRecord> {
  return patch(id, { status: "PENDING", attemptCount: 0, errorMessage: null });
}

/** AI処理ログ画面の一覧。新しい順。 */
export async function listRecentDeliveries(limit = 50): Promise<NotificationDeliveryRecord[]> {
  const rows = unwrapList(
    await serverDataClient.models.NotificationDelivery.list({ ...inventoryAuthMode, limit: Math.min(limit * 4, 400) }),
    "通知履歴",
  ) as unknown as DeliveryRow[];
  return rows
    .map(toRecord)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

/** 会話ごとの通知履歴(メッセージ詳細で「通知したか」を出すため)。 */
export async function listDeliveriesForConversation(conversationId: string): Promise<NotificationDeliveryRecord[]> {
  const rows = unwrapList(
    await serverDataClient.models.NotificationDelivery.listNotificationDeliveryByConversationId(
      { conversationId },
      { ...inventoryAuthMode, limit: 50 },
    ),
    "通知履歴",
  ) as unknown as DeliveryRow[];
  return rows.map(toRecord).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
