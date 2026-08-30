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

export interface MessageRecord {
  id: string;
  conversationId: string;
  externalMessageId: string | null;
  direction: MessageDirection;
  senderType: MessageSenderType;
  body: string;
  contentType: string | null;
  externalSentAt: string | null;
  deliveryStatus: MessageDeliveryStatus;
  aiGenerated: boolean;
  createdAt: string;
}
