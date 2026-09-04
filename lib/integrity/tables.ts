/**
 * 監視対象のモデルと、その環境変数名（2026-09-04 最終フェーズ Phase B）。
 *
 * **1箇所に置く。** これを2箇所に書くと、
 *   amplify/backend.ts が渡す環境変数名
 *   amplify/functions/integrity-monitor/handler.ts が読む環境変数名
 * がずれた日に、そのモデルの走査だけが「取得できませんでした」になる。
 * 静かに検査対象から抜け落ちるので、気づくのは事故が起きたあとになる。
 */
export const INTEGRITY_TABLE_ENV = {
  Inventory: "INVENTORY_TABLE_NAME",
  InventoryHistory: "INVENTORY_HISTORY_TABLE_NAME",
  ListingDraft: "LISTING_DRAFT_TABLE_NAME",
  ChannelListing: "CHANNEL_LISTING_TABLE_NAME",
  ProcessingJob: "PROCESSING_JOB_TABLE_NAME",
  ImageProcessingVersion: "IMAGE_PROCESSING_VERSION_TABLE_NAME",
  ZaicoSourceLink: "ZAICO_SOURCE_LINK_TABLE_NAME",
  MercariOrderContext: "MERCARI_ORDER_CONTEXT_TABLE_NAME",
  Conversation: "CONVERSATION_TABLE_NAME",
  Message: "MESSAGE_TABLE_NAME",
  NotificationDelivery: "NOTIFICATION_DELIVERY_TABLE_NAME",
  ZaicoSyncJob: "ZAICO_SYNC_JOB_TABLE_NAME",
} as const;

export type IntegrityMonitoredModel = keyof typeof INTEGRITY_TABLE_ENV;

export const INTEGRITY_MONITORED_MODELS = Object.keys(INTEGRITY_TABLE_ENV) as IntegrityMonitoredModel[];
