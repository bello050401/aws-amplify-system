/**
 * BELLO統合業務OS指示書(2026-08-30) §38-50: Message core共有型。
 * amplify/data/resource.tsのMessageChannel/ConversationStatus/
 * ConversationPriority/MessageDirection/MessageSenderType/
 * MessageDeliveryStatus enumの値と1対1(既存のlib/listing/types.tsと
 * 同じ「Amplify Dataのenumは独立したランタイム型を生成しないため複製
 * する」パターン)。
 */

export type MessageChannel = "MERCARI_SHOPS" | "YAHOO_AUCTION" | "LINE" | "EMAIL" | "BASE" | "TEST";

/**
 * チャネルの表示名。**社内LINE通知の1通目の先頭にもこれを使う**
 * (2026-09-03 指示書 §7-1 が【公式LINE】【BASE】【メルカリShops】という
 * 表記を指定している)。画面と通知で別々の名前を持つと、通知を見た人が
 * 画面のどのチャネルの話か分からなくなるので、正本を1つにする。
 */
export const MESSAGE_CHANNEL_LABEL: Record<MessageChannel, string> = {
  LINE: "公式LINE",
  BASE: "BASE",
  MERCARI_SHOPS: "メルカリShops",
  YAHOO_AUCTION: "Yahoo!オークション",
  EMAIL: "メール",
  TEST: "テスト",
};

export type ConversationStatus = "OPEN" | "WAITING_FOR_REPLY" | "REPLIED" | "RESOLVED" | "ARCHIVED";

export type ConversationPriority = "NORMAL" | "HIGH";

export type MessageDirection = "INBOUND" | "OUTBOUND";

export type MessageSenderType = "CUSTOMER" | "STAFF" | "AI";

export type MessageDeliveryStatus = "RECEIVED" | "DRAFT" | "SENDING" | "SENT" | "FAILED";

/**
 * 業務上の確認状況。既読/未読(技術的状態)とも、返信したかどうか
 * (replyState)とも別の軸。
 *
 * 2026-09-02: COMPLETED(対応済み)を追加。NEW / REPLIED は既存データとの
 * 互換のために型としては残すが、**UIの業務ステータスとしては使わない**
 * ——「返信済み」は業務ステータスではなく返信状態だから(指示書§24)。
 * どちらも表示上は「確認指定なし」として扱う。
 */
export type ConversationWorkflowStatus =
  | "NEW"
  | "REPLIED"
  /** 商品URLを送ってもらう返信をして、お客様の返答を待っている。 */
  | "AWAITING_PRODUCT_URL"
  | "OHARA_REVIEW"
  | "ICHIKAWA_REVIEW"
  | "COMPLETED";

/**
 * 返信状態。業務ステータスと独立した軸(指示書§9/§24)。
 * 「大原確認」中でも「まだ返信していない」という事実は保持される。
 */
export type ConversationReplyState = "UNREPLIED" | "REPLIED";

export const REPLY_STATE_LABEL: Record<ConversationReplyState, string> = {
  UNREPLIED: "未返信",
  REPLIED: "返信済み",
};

/**
 * 一覧の絞り込み。**この順番がそのまま画面のタブの並び**(指示書§2)。
 * 配列の順序を変えないこと。E2E/DOMテストがこの順序を固定している。
 */
export const CONVERSATION_FILTERS = [
  "UNREPLIED",
  "REPLIED",
  "ALL",
  // 業務ステータスのタブ群(大原確認・市川確認・対応済み)の先頭へ置く。
  // 「商品確認待ち」は返信状態ではなく業務の段階なので、そちら側に
  // まとめるのが自然。
  //
  // この結果、大原確認から後ろのタブは1つずつ右へ動く。既存の並びを
  // 固定していたテストもあわせて更新した —— あの固定は「うっかり順序を
  // 変えない」ためのもので、意図的な追加まで止めるものではない。
  "AWAITING_PRODUCT_URL",
  "OHARA_REVIEW",
  "ICHIKAWA_REVIEW",
  "COMPLETED",
] as const;

export type ConversationFilter = (typeof CONVERSATION_FILTERS)[number];

export const CONVERSATION_FILTER_LABEL: Record<ConversationFilter, string> = {
  UNREPLIED: "未返信",
  REPLIED: "返信済み",
  ALL: "すべて",
  AWAITING_PRODUCT_URL: "商品確認待ち",
  OHARA_REVIEW: "大原確認",
  ICHIKAWA_REVIEW: "市川確認",
  COMPLETED: "対応済み",
};

/** 画面を開いた直後のフィルタ(指示書§3)。 */
export const DEFAULT_CONVERSATION_FILTER: ConversationFilter = "UNREPLIED";

/**
 * 業務ステータスとして人が操作できるもの。
 * 「返信済み」はここに含めない —— 返信状態は送信の事実から導く値であって、
 * 人がボタンで切り替えるものではない(指示書§25/§27)。
 */
export const SELECTABLE_WORKFLOW_STATUSES = [
  // 商品確認待ちは、URL依頼を送った時点でシステムが付ける。人が手で
  // 付け直せるようにもしておく —— 電話で聞いた等、システムの外で
  // 状況が変わることがある。
  "AWAITING_PRODUCT_URL",
  "OHARA_REVIEW",
  "ICHIKAWA_REVIEW",
  "COMPLETED",
] as const;

export const WORKFLOW_STATUS_LABEL: Record<ConversationWorkflowStatus, string> = {
  NEW: "確認指定なし",
  REPLIED: "確認指定なし",
  AWAITING_PRODUCT_URL: "商品確認待ち",
  OHARA_REVIEW: "大原確認",
  ICHIKAWA_REVIEW: "市川確認",
  COMPLETED: "対応済み",
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
  /** 業務ステータス。未読/既読とも返信状態とも別軸。 */
  workflowStatus: ConversationWorkflowStatus;
  /** 「対応済み」にした日時(対応済み一覧の並び順)。解除するとnull。 */
  completedAt: string | null;
  completedBy: string | null;
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
