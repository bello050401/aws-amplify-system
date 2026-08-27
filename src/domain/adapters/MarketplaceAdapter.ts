/**
 * マルチモール対応のためのアダプタインターフェース（指示書59, 60項）。
 * 将来 YahooAuctionStoreAdapter / BaseAdapter / OwnECAdapter を追加する際も
 * このインターフェースを実装する。Product テーブル自体は特定モール専用にしない。
 */

export type MarketplaceChannel = "MERCARI_SHOPS";

export interface CreateListingResult {
  externalProductId: string;
  externalStatus?: string | null;
}

export interface UpdateListingResult {
  externalProductId: string;
  externalStatus?: string | null;
}

export interface ExternalProduct {
  externalProductId: string;
  status?: string | null;
  raw: unknown;
}

export interface MarketplaceAdapter {
  readonly channel: MarketplaceChannel;
  createProduct(productId: string): Promise<CreateListingResult>;
  updateProduct(productId: string): Promise<UpdateListingResult>;
  getProduct(externalId: string): Promise<ExternalProduct>;
}
