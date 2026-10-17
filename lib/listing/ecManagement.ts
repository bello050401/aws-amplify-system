export const EC_CHANNELS = ["MERCARI_SHOPS", "YAHOO", "BASE"] as const;
export type EcChannel = (typeof EC_CHANNELS)[number];
export const EC_CHANNEL_LABEL: Record<EcChannel, string> = {
  MERCARI_SHOPS: "メルカリShops",
  YAHOO: "ヤフオク!",
  BASE: "BASE",
};
export type EcState = "UNLISTED" | "DRAFT" | "ACTIVE" | "STOPPED" | "ENDED" | "PENDING" | "ERROR" | "UNKNOWN";
export const EC_STATE_LABEL: Record<EcState, string> = {
  UNLISTED: "未出品",
  DRAFT: "下書き",
  ACTIVE: "出品中",
  STOPPED: "停止中",
  ENDED: "終了",
  PENDING: "処理中",
  ERROR: "要確認",
  UNKNOWN: "未確認",
};
export type EcChannelState = {
  state: EcState;
  externalId: string | null;
  url: string | null;
  checkedAt: string | null;
};
export type EcCatalog = {
  channels: Partial<Record<EcChannel, Record<string, EcChannelState>>>;
  archivedIds: string[];
  errors: string[];
};
export type EcOperation = "PUBLISH" | "STOP" | "UPDATE" | "ARCHIVE" | "RESTORE";
export const EC_OPERATION_LABEL: Record<EcOperation, string> = {
  PUBLISH: "出品",
  STOP: "出品停止",
  UPDATE: "更新",
  ARCHIVE: "削除",
  RESTORE: "復元",
};
export type EcReview = {
  inventoryId: string;
  title: string;
  channel: EcChannel;
  operation: EcOperation;
  status: "READY" | "WAIT" | "BLOCKED" | "DONE";
  message: string;
  token?: string;
  price?: number | null;
  quantity?: number;
  imageCount?: number;
  details?: string[];
  nextAt?: number;
  requiresTerms?: boolean;
};
export function ecStateFor(
  catalog: EcCatalog | null,
  channel: EcChannel,
  inventoryId: string,
  hasDraft: boolean,
): EcChannelState {
  const records = catalog?.channels[channel];
  if (!records) return { state: "UNKNOWN", externalId: null, url: null, checkedAt: null };
  return (
    records[inventoryId] ?? {
      state: hasDraft ? "DRAFT" : "UNLISTED",
      externalId: null,
      url: null,
      checkedAt: null,
    }
  );
}
/** Selection is always explicit. Changing the visible scope must not act on hidden rows. */
export function retainVisibleSelection(selected: Set<string>, visibleIds: string[]): Set<string> {
  const visible = new Set(visibleIds);
  return new Set([...selected].filter((id) => visible.has(id)));
}
