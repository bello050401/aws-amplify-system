import type {
  ListingDraftRecord,
  ListingImageRef,
  ListingShippingMethod,
} from "./types";
import { sameListingImageRefs } from "../photoRegistration/inventoryListingAdapter";
import {
  normalizeShippingPackages,
  type ShippingPackage,
} from "../shipping/packages";
import { COMMON_EC_CHANNELS, type CommonChannelPrices } from "./commonSettings";

export function commonDraftHasChanges(
  form: {
    title: string;
    description: string;
    price: string;
    quantity?: string;
    condition: string;
    shippingMethod: ListingShippingMethod;
    images: ListingImageRef[];
    shippingPackages: ShippingPackage[];
    commonCategoryId?: string | null;
    channelPrices?: CommonChannelPrices | null;
  },
  saved: ListingDraftRecord | null,
  defaults: { title: string; images: ListingImageRef[]; quantity?:number },
): boolean {
  return (
    (form.quantity !== undefined && Number(form.quantity) !== (saved?.quantity ?? defaults.quantity ?? 1)) ||
    form.title.trim() !== (saved?.title ?? defaults.title).trim() ||
    (form.commonCategoryId || null) !== (saved?.commonCategoryId || null) ||
    COMMON_EC_CHANNELS.some(
      (channel) =>
        (form.channelPrices?.[channel] ?? null) !==
        (saved?.channelPrices?.[channel] ?? null),
    ) ||
    (form.channelPrices == null) !== (saved?.channelPrices == null) ||
    form.description.trim() !== (saved?.description ?? "").trim() ||
    (form.price ? Number(form.price) : 0) !== (saved?.price ?? 0) ||
    form.condition !== (saved?.condition ?? "NO_NOTABLE_DAMAGE") ||
    form.shippingMethod !== (saved?.shippingMethod ?? "KAZAI") ||
    !sameListingImageRefs(
      form.images,
      saved ? saved.images : defaults.images,
    ) ||
    JSON.stringify(normalizeShippingPackages(form.shippingPackages)) !==
      JSON.stringify(normalizeShippingPackages(saved?.shippingPackages))
  );
}
