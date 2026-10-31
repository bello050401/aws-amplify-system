import {
  EC_CHANNELS,
  ecStateFor,
  type EcCatalog,
  type EcChannel,
  type EcChannelState,
} from "./ecManagement";
import type { ListingOverviewRow } from "./service";
import type { ExternalProduct } from "./econveni/manualSyncModel";

export type RemoteOverviewProduct = {
  product: ExternalProduct;
  inventoryId: string | null;
  inventory: ListingOverviewRow | null;
  ambiguous?: boolean;
};
export type OverviewItem = {
  key: string;
  row: ListingOverviewRow | null;
  remote?: ExternalProduct;
  ambiguous?: boolean;
};
export type ListingStateFilter = "ALL" | "ACTIVE" | "INACTIVE" | "ATTENTION";
export const isSoldInventory = (row: ListingOverviewRow | null) =>
  !!row?.categories?.some((c) => /売り?切れ/.test(c));
export function overviewItems(
  rows: ListingOverviewRow[],
  catalog: EcCatalog | null,
  source: "ECONVENI" | "BELLO",
): OverviewItem[] {
  if (source === "BELLO")
    return rows.map((row) => ({ key: row.inventoryId, row }));
  const byId = new Map(rows.map((r) => [r.inventoryId, r]));
  return (catalog?.econveni?.products ?? []).map((p) => {
    const prior = p.inventory ? byId.get(p.inventory.inventoryId) : undefined;
    return {
      key: "econveni:" + p.product.productId,
      remote: p.product,
      ambiguous: p.ambiguous,
      row: p.inventory
        ? {
            ...prior,
            ...p.inventory,
            hasDraft: prior?.hasDraft ?? false,
            archived: prior?.archived,
            price: prior?.price ?? p.inventory.price,
            channelPrices: prior?.channelPrices,
            thumbnailKey: prior?.thumbnailKey ?? null,
            thumbnailIsPrimary: prior?.thumbnailIsPrimary,
          }
        : null,
    };
  });
}
export function overviewChannel(
  item: OverviewItem,
  catalog: EcCatalog | null,
  channel: EcChannel,
): EcChannelState {
  if (item.row)
    return ecStateFor(
      catalog,
      channel,
      item.row.inventoryId,
      item.row.hasDraft,
    );
  const s = item.remote?.channels[channel];
  return {
    state: !s
      ? "UNKNOWN"
      : s.state === "ACTIVE"
        ? "ACTIVE"
        : s.state === "EXCLUDED"
          ? "UNKNOWN"
          : s.listingId
            ? "STOPPED"
            : "UNLISTED",
    externalId: s?.listingId ?? null,
    url: s?.listingUrl ?? null,
    checkedAt: catalog?.econveni?.checkedAt ?? null,
    source: "ECONVENI",
  };
}
export function isProtectedSale(
  item: OverviewItem,
  catalog: EcCatalog | null,
  channel: EcChannel,
): boolean {
  if (!item.row) return false;
  const s = overviewChannel(item, catalog, channel);
  return (
    (!!s.externalId &&
      !!catalog?.soldListings?.[item.row.inventoryId]?.[channel]?.includes(
        s.externalId,
      )) ||
    (isSoldInventory(item.row) && item.row.soldChannel === channel)
  );
}
/** All-channel inactive means ALL channels, not any one inactive channel on an active product. */
export function matchesListingState(
  item: OverviewItem,
  catalog: EcCatalog | null,
  channel: EcChannel | "ALL",
  filter: ListingStateFilter,
): boolean {
  if (filter === "ALL") return true;
  const states = (channel === "ALL" ? EC_CHANNELS : [channel]).map((c) =>
    isProtectedSale(item, catalog, c)
      ? "ENDED"
      : overviewChannel(item, catalog, c).state,
  );
  if (filter === "ACTIVE") return states.includes("ACTIVE");
  if (filter === "ATTENTION")
    return states.some((s) => ["ERROR", "PENDING", "UNKNOWN"].includes(s));
  return states.every((s) =>
    ["UNLISTED", "STOPPED", "ENDED", "DRAFT"].includes(s),
  );
}
export const categoryMatches = (
  row: ListingOverviewRow | null,
  filter: string,
) =>
  filter === "ALL" ||
  (filter === "UNLINKED" && !row) ||
  !!row?.categories?.some(
    (c) => c === filter || (filter === "販売中" && c === "出品中"),
  );
