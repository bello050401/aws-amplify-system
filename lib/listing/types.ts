/**
 * BELLO統合改修 master指示書 Phase D — EC Listing / Mercari Shops連携の
 * 共有型。amplify/data/resource.tsのListingChannel/ListingCondition/
 * ListingStatus enumの値と1対1(lib/inventory/zaicoBackgroundSync.tsの
 * ZaicoSyncJobStatus型が同モデルのenum値をプレーンなunion型として複製
 * しているのと同じパターン — Amplify Dataのenumは`a.model()`と違って
 * 独立したランタイム型を生成しないため、呼び出し側でこうして複製する
 * 必要がある)。
 */

import type { ShippingRank } from "../shipping/rank";

export type ListingChannel = "MERCARI_SHOPS" | "BASE";

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
/**
 * 配送方法(2026-09-04 EC出品改修 追加指示 §1)。
 *
 * 担当者が選ぶ。**サイズやAIから自動で切り替えない。**
 * 選択に応じて商品説明の「◎発送について」の中身が変わる:
 *
 *   KAZAI  → 既存の家財便ランク判定(lib/shipping/rank.ts)
 *   SAGAWA → 3辺合計+20cmのサイズ判定(lib/shipping/sagawaSize.ts)
 */
export type ListingShippingMethod = "KAZAI" | "SAGAWA";

/**
 * 既定は「らくらく家財便」。商品を開いた時点でこれが選ばれており、
 * 必要な商品だけ担当者が佐川急便へ変える運用(§1)。
 *
 * 既存の下書きは shippingMethod を持たない(null)。マイグレーションを
 * せずに済むよう、**未設定はこの値として読む**。
 */
export const DEFAULT_LISTING_SHIPPING_METHOD: ListingShippingMethod = "KAZAI";

/** 画面に出す選択肢。順序もこのまま(既定を先頭に置く)。 */
export const LISTING_SHIPPING_METHODS: { code: ListingShippingMethod; label: string }[] = [
  { code: "KAZAI", label: "らくらく家財便" },
  { code: "SAGAWA", label: "佐川急便" },
];

export function parseListingShippingMethod(value: string | null | undefined): ListingShippingMethod {
  return value === "SAGAWA" ? "SAGAWA" : DEFAULT_LISTING_SHIPPING_METHOD;
}

export interface ListingDraftRecord {
  id: string;
  inventoryId: string;
  title: string;
  description: string | null;
  price: number | null;
  condition: ListingConditionCode | null;
  /** 配送方法。既存の下書きでも必ず値が入る(未設定はKAZAIとして読む)。 */
  shippingMethod: ListingShippingMethod;
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
  // BELLO統合業務OS指示書(2026-08-30) §67-68: 家財おまかせ便の送料見積り
  // (lib/shipping/service.tsが実際に使う)。
  shippingRank: ShippingRank | null;
  shippingDestinationPrefecture: string | null;
  calculatedShippingFee: number | null;
  confirmedShippingFee: number | null;
  shippingFeeUpdatedAt: string | null;
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
