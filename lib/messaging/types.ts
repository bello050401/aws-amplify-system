/**
 * BELLO統合業務OS指示書(2026-08-30) §38-50: Message core共有型。
 * amplify/data/resource.tsのMessageChannel/ConversationStatus/
 * ConversationPriority/MessageDirection/MessageSenderType/
 * MessageDeliveryStatus enumの値と1対1(既存のlib/listing/types.tsと
 * 同じ「Amplify Dataのenumは独立したランタイム型を生成しないため複製
 * する」パターン)。
 */

export type MessageChannel = "MERCARI_SHOPS" | "YAHOO_AUCTION" | "LINE" | "EMAIL" | "TEST";

export type ConversationStatus = "OPEN" | "WAITING_FOR_REPLY" | "REPLIED" | "RESOLVED" | "ARCHIVED";

export type ConversationPriority = "NORMAL" | "HIGH";

export type MessageDirection = "INBOUND" | "OUTBOUND";

export type MessageSenderType = "CUSTOMER" | "STAFF" | "AI";

export type MessageDeliveryStatus = "RECEIVED" | "DRAFT" | "SENDING" | "SENT" | "FAILED";

/** 業務上の確認状況。既読/未読(技術的状態)と混同しないよう別の型にする。 */
export type ConversationWorkflowStatus = "NEW" | "REPLIED" | "OHARA_REVIEW" | "ICHIKAWA_REVIEW";

/** 一覧の絞り込み。「すべて」はフィルタ無し。 */
export type ConversationFilter = "ALL" | "UNREAD" | "REPLIED" | "OHARA_REVIEW" | "ICHIKAWA_REVIEW";

export const WORKFLOW_STATUS_LABEL: Record<ConversationWorkflowStatus, string> = {
  NEW: "未対応",
  REPLIED: "返信済み",
  OHARA_REVIEW: "大原確認",
  ICHIKAWA_REVIEW: "市川確認",
};

export interface ConversationRecord {
  id: string;
  channel: MessageChannel;
  externalConversationId: string | null;
  externalCustomerId: string | null;
  customerDisplayName: string | null;
  relatedInventoryId: string | null;
  relatedListingId: string | null;
  relatedOrderId: string | null;
  subject: string | null;
  status: ConversationStatus;
  unreadCount: number;
  /**
   * 未読フラグ。件数(unreadCount)ではなくこちらが正本。
   * 「人が画面で開いた」操作だけが false にする。
   */
  isUnread: boolean;
  lastReadAt: string | null;
  lastReadBy: string | null;
  /** 業務ステータス。未読/既読とは別軸(NEW/REPLIED/OHARA_REVIEW/ICHIKAWA_REVIEW)。 */
  workflowStatus: ConversationWorkflowStatus;
  /** 顧客名の出所。取得を試みたが取れなかったのか、まだ試していないのかを区別する。 */
  customerNameSource: string | null;
  customerNameFetchedAt: string | null;
  needsReply: boolean;
  priority: ConversationPriority;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  lastIncomingAt: string | null;
  lastOutgoingAt: string | null;
  assignedUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MessageContentKind = "TEXT" | "IMAGE" | "STICKER" | "FILE" | "OTHER";
export type MessageAttachmentStatus = "NONE" | "PENDING" | "STORED" | "FAILED";

export interface MessageRecord {
  id: string;
  conversationId: string;
  externalMessageId: string | null;
  direction: MessageDirection;
  senderType: MessageSenderType;
  body: string;
  contentType: string | null;
  /** メッセージ種別。画像を「本文が空のテキスト」として扱わないために持つ。 */
  contentKind: MessageContentKind;
  /** BELLO側S3に保存した添付のキー。表示側は署名付きURLへ変換して使う。 */
  attachmentStorageKey: string | null;
  attachmentContentType: string | null;
  attachmentSizeBytes: number | null;
  /** 添付を保存できたか。失敗しても会話は残す。 */
  attachmentStatus: MessageAttachmentStatus;
  attachmentError: string | null;
  externalSentAt: string | null;
  deliveryStatus: MessageDeliveryStatus;
  aiGenerated: boolean;
  createdAt: string;
}
