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

/**
 * Mercari Shops CSV(lib/listing/mercari/csv/)向けのカテゴリー/ブランド
 * 対応付け。ChannelListing.categoryMappingはDB上ただのJSON文字列
 * (stringifyListingJson)なのでスキーマ変更なしに任意フィールドを足せる
 * ——ブランドは指示書§4で「任意」のため、mercariBrandId系は無くても
 * (旧データ・未選択)動く。マスタ側の実体は
 * lib/listing/mercari/csv/masters.tsのCategoryMasterEntry/BrandMasterEntry。
 */
export interface MercariCategoryMapping {
  mercariCategoryId: string;
  /** 表示用(選択時のフルパス)。CSVには出さない。 */
  mercariCategoryName?: string;
  mercariBrandId?: string;
  /** 表示用(選択時のブランド名)。CSVには出さない。 */
  mercariBrandName?: string;
  /**
   * 発送までの日数(1=1〜2/2=2〜3/3=4〜7/4=90日以内/5=8〜14)。
   * ここで人が商品ごとに選んだ実値をそのまま保持する。未設定
   * (undefined)の場合、CSV生成側(lib/listing/mercari/csv/assembleRow.ts
   * のDEFAULT_MERCARI_SHIPPING_DAYS)がユーザー明示の既定値(3=4〜7日)を
   * 補う(task_d2082e63dfcee9e1bf)——ここに保存済みの実値がある場合は
   * その既定値で上書きされない。
   */
  mercariShippingDays?: 1 | 2 | 3 | 4 | 5;
  /**
   * 配送料の負担(1=送料込/2=送料別)。ここで人が商品ごとに選んだ実値を
   * そのまま保持する。未設定(undefined)の場合、CSV生成側
   * (lib/listing/mercari/csv/assembleRow.tsのDEFAULT_MERCARI_SHIPPING_PAYER)
   * がユーザー明示の既定値(1=送料込み)を補う(task_d2082e63dfcee9e1bf、
   * 624307eでShippingPayerCode自体を削除した経緯とは別の、送料込/送料別
   * のUI選択値の話)——ここに保存済みの実値がある場合はその既定値で
   * 上書きされない。
   */
  mercariShippingPayer?: 1 | 2;
  /**
   * 送料ID(task_ca862bd2a1f6fbf60d、2026-09-15追加)。配送料の負担が
   * 「送料別」(2)の場合、validateMercariCsvRow(lib/listing/mercari/csv/
   * validate.ts)がCSV生成時に必須とする値。送料IDにはMercari提供の
   * マスタが存在しない(data/mercari-masters/には含まれない)ため、
   * Mercari Shops管理画面の「送料設定」で出品者が作成したIDを人が
   * MercariCategoryMappingSection.tsxの自由入力欄からそのまま転記する
   * ——BELLO側では送料額自体を算出・変更しない。途中(未入力)保存を
   * 許可するため任意フィールドとし、必須チェックはCSV生成時
   * (validateMercariCsvRow)側の責務のままにする。送料込(1)へ切り替えて
   * もこの値自体は消さない(lib/listing/mercari/csv/assembleRow.tsが
   * shippingPayerに応じて出力有無を切り替えるため、値を保持していても
   * 送料込のCSVへ漏れ出さない)。
   */
  mercariShippingFeeId?: string;
}

/** ChannelListing(Channel Listing + Channel Override + External Listing Status)のUI/Server Action向け公開シェイプ。 */
export interface ChannelListingRecord {
  id: string;
  listingDraftId: string;
  inventoryId: string;
  channel: ListingChannel;
  categoryMapping: MercariCategoryMapping | null;
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
