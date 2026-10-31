import type { ListingDraftRecord, ChannelListingRecord } from "./types";

export interface ListingOverviewRow {
  soldChannel?: "MERCARI_SHOPS" | "YAHOO" | "BASE" | null;
  channelPrices?: ListingDraftRecord["channelPrices"];
  inventoryCreatedAt?: string;
  categories?: string[];
  archived?: boolean;
  inventoryId: string;
  displayId: string;
  name: string;
  quantity: number;
  price: number | null;
  thumbnailKey: string | null;
  thumbnailIsPrimary?: boolean;
  inventoryUpdatedAt: string;
  hasDraft: boolean;
  /** 現時点でチャネルはMERCARI_SHOPSのみ(lib/listing/types.tsのListingChannel参照) — 将来チャネルが増えたらこの1フィールドを配列にする。 */
  channelListing: ChannelListingRecord | null;
}
