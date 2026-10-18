import categories from "./commonCategories.json";
import type { ListingDraftRecord } from "./types";
export const COMMON_EC_CATEGORIES = categories;
export const COMMON_EC_CHANNELS = [
  "MERCARI_SHOPS",
  "YAHOO",
  "BASE",
  "INDEPENDENT",
] as const;
export type CommonEcChannel = (typeof COMMON_EC_CHANNELS)[number];
export type CommonChannelPrices = Record<CommonEcChannel, number | null>;
export const COMMON_EC_LABELS: Record<CommonEcChannel, string> = {
  MERCARI_SHOPS: "メルカリShops（送料込み）",
  YAHOO: "ヤフオク（送料別）",
  BASE: "BASE（送料込み）",
  INDEPENDENT: "自社サイト（送料別）",
};
export function commonCategory(id: string | null | undefined) {
  return categories.find((c) => c.id === id) ?? null;
}
export function normalizeChannelPrices(
  value: unknown,
): CommonChannelPrices | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value))
    throw Error("販売先ごとの価格を確認してください。");
  const v = value as Record<string, unknown>;
  const entries = COMMON_EC_CHANNELS.map((c) => {
    const n = v[c];
    if (
      n !== null &&
      (!Number.isSafeInteger(n) || Number(n) < 1 || Number(n) > 999999999)
    )
      throw Error(
        `${COMMON_EC_LABELS[c]}の価格は1円以上の整数で入力してください。`,
      );
    return [c, n] as const;
  });
  return Object.fromEntries(entries) as CommonChannelPrices;
}
export function suggestedChannelPrices(
  goodsPrice: number | null,
  shipping: number | null,
): CommonChannelPrices {
  const goods =
    goodsPrice != null && Number.isSafeInteger(goodsPrice) && goodsPrice > 0
      ? goodsPrice
      : null;
  const included =
    goods !== null &&
    shipping !== null &&
    Number.isSafeInteger(shipping) &&
    shipping >= 0
      ? goods + shipping
      : null;
  return {
    MERCARI_SHOPS: included,
    YAHOO: goods,
    BASE: included === null ? null : Math.round((included * 95) / 100),
    INDEPENDENT: goods,
  };
}
/** A deliberately empty channel price remains incomplete; never silently publish at the goods-only price. */
export function commonChannelPrice(
  draft: Pick<ListingDraftRecord, "price" | "channelPrices">,
  channel: CommonEcChannel,
  legacyOverride?: number | null,
): number | null {
  return draft.channelPrices
    ? (draft.channelPrices[channel] ?? null)
    : (legacyOverride ?? draft.price ?? null);
}
