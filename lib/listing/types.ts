/**
 * BELLO統合改修 master指示書 Phase D — EC Listing / Mercari Shops連携の
 * 共有型。amplify/data/resource.tsのListingChannel/ListingCondition/
 * ListingStatus enumの値と1対1(lib/inventory/zaicoBackgroundSync.tsの
 * ZaicoSyncJobStatus型が同モデルのenum値をプレーンなunion型として複製
 * しているのと同じパターン — Amplify Dataのenumは`a.model()`と違って
 * 独立したランタイム型を生成しないため、呼び出し側でこうして複製する
 * 必要がある)。
 */

export type ListingChannel = "MERCARI_SHOPS";

export type ListingConditionCode = "NEW" | "LIKE_NEW" | "NO_NOTABLE_DAMAGE" | "SLIGHT_DAMAGE" | "DAMAGE" | "BAD";

/** BELLO統合業務OS指示書(2026-08-30) §14 — amplify/data/resource.tsのListingStatus enumと1対1。あちらのコメントに、実際に到達する状態と未実装のトリガーの区別を記載している。 */
export type ListingStatus =
  | "NOT_PREPARED"
  | "DRAFT"
  | "READY"
  | "QUEUED"
  | "PUBLISHING"
  | "ACTIVE"
  | "PAUSED"
  | "SOLD"
  | "ENDED"
  | "RELIST_PENDING"
  | "ERROR"
  | "ARCHIVED";

/**
 * BELLOには「送料を誰が負担するか」を表す既存フィールドが無いため、
 * Phase Dで新設した概念(amplify/data/resource.tsのschemaには持たせて
 * いない — ChannelListing.categoryMapping/overrideXxxと違い、これは
 * Mercariアダプタの入力を組み立てる際にUIから直接受け取るだけの値で、
 * BELLO側で永続化・再利用する理由が今のところ無いため)。
 */
export type ShippingPayerCode = "SELLER" | "BUYER";

/** 1件の出品用画像 — Inventory.imagesのstorageKeyをそのまま参照する(出品用に画像を再アップロードすることはない)。 */
export interface ListingImageRef {
  storageKey: string;
  sortOrder: number;
}

/** ListingDraft(Common Listing Draft)のUI/Server Action向け公開シェイプ。 */
export interface ListingDraftRecord {
  id: string;
  inventoryId: string;
  title: string;
  description: string | null;
  price: number | null;
  condition: ListingConditionCode | null;
  images: ListingImageRef[];
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** ChannelListing(Channel Listing + Channel Override + External Listing Status)のUI/Server Action向け公開シェイプ。 */
export interface ChannelListingRecord {
  id: string;
  listingDraftId: string;
  inventoryId: string;
  channel: ListingChannel;
  categoryMapping: { mercariCategoryId: string; mercariCategoryName?: string } | null;
  overrideTitle: string | null;
  overrideDescription: string | null;
  overridePrice: number | null;
  status: ListingStatus;
  externalListingId: string | null;
  listingUrl: string | null;
  /** §15: 初回成功時刻のみ、以降は上書きしない。 */
  firstListedAt: string | null;
  /** §15: 直近の成功(初回 or 再出品)のたびに更新。 */
  lastListedAt: string | null;
  /** §15: 再出品が成功した時刻のみ(初回では設定しない)。 */
  lastRelistedAt: string | null;
  endedAt: string | null;
  soldAt: string | null;
  lastError: string | null;
  // BELLO統合業務OS指示書(2026-08-30) §18: 商品別自動価格設定
  // (lib/listing/pricing.ts/lib/listing/pricingService.tsが実際に使う)。
  autoPricingEnabled: boolean;
  pricingRuleId: string | null;
  originalPrice: number | null;
  currentPrice: number | null;
  floorPrice: number | null;
  markdownCount: number;
  lastPriceChangeAt: string | null;
  nextPriceActionAt: string | null;
  automationHold: boolean;
  lastAutomationResult: string | null;
  createdAt: string;
  updatedAt: string;
}

/** overrideXxxが設定されていればそちらを、無ければListingDraftの値を使う — ChannelListingが「Channel Override」を表現する仕組みそのもの。 */
export function resolveEffectiveListingFields(
  draft: ListingDraftRecord,
  channelListing: ChannelListingRecord,
): { title: string; description: string; price: number } {
  return {
    title: channelListing.overrideTitle ?? draft.title,
    description: channelListing.overrideDescription ?? draft.description ?? "",
    price: channelListing.overridePrice ?? draft.price ?? 0,
  };
}
