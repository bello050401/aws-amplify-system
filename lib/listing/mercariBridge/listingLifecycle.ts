import type { ChannelListingRecord } from "@/lib/listing/types";

export type ShopsOperation = {
  kind: "CREATE" | "STOP" | "RELIST";
  phase: "RESERVED" | "RUNNING" | "UNKNOWN";
};

export type ShopsLifecycle =
  | "NOT_LISTED" | "CREATING" | "LISTED" | "STOPPING"
  | "STOPPED" | "PRIVATE" | "UNKNOWN";

const REMOTE_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** An ID and a completed remote state are both required to show a successful listing. */
export function shopsLifecycle(
  listing: Pick<ChannelListingRecord, "status" | "externalListingId"> | null,
  operation: ShopsOperation | null = null,
): ShopsLifecycle {
  if (operation) {
    if (operation.phase === "UNKNOWN") return "UNKNOWN";
    return operation.kind === "STOP" ? "STOPPING" : "CREATING";
  }
  if (!listing) return "NOT_LISTED";
  const hasId = typeof listing.externalListingId === "string" &&
    REMOTE_ID.test(listing.externalListingId);
  if (listing.status === "ACTIVE") return hasId ? "LISTED" : "UNKNOWN";
  // Legacy PAUSED is also used by BELLO pricing rules; ENDED is a local record.
  // Neither proves the current Shops visibility or that relisting is possible.
  if (listing.status === "PAUSED" || listing.status === "ENDED") return "UNKNOWN";
  if (["QUEUED", "PUBLISHING", "RELIST_PENDING"].includes(listing.status))
    return "CREATING";
  if (["NOT_PREPARED", "DRAFT", "READY"].includes(listing.status) && !hasId)
    return "NOT_LISTED";
  return "UNKNOWN";
}

export type ShopsReadback =
  | { kind: "EXACT_ABSENCE" }
  | { kind: "EXACT_PRODUCT"; remoteId: string; visibility: "PUBLIC" | "PRIVATE" };

/** A saved BELLO status alone never authorizes a remote mutation. */
export function shopsActionForState(state: ShopsLifecycle,
  listing: Pick<ChannelListingRecord, "externalListingId"> | null,
  readback: ShopsReadback | null):
  "CREATE" | "STOP" | "RELIST" | null {
  if (state === "NOT_LISTED" && !listing && readback?.kind === "EXACT_ABSENCE")
    return "CREATE";
  if (readback?.kind !== "EXACT_PRODUCT" ||
      !listing?.externalListingId || !REMOTE_ID.test(listing.externalListingId) ||
      readback.remoteId !== listing.externalListingId) return null;
  if (state === "LISTED" && readback.visibility === "PUBLIC") return "STOP";
  if (state === "STOPPED" && readback.visibility === "PRIVATE") return "RELIST";
  return null;
}

export function shopsAdminUrl(shopId: string, remoteId: string | null): string | null {
  if (!REMOTE_ID.test(shopId) || !remoteId || !REMOTE_ID.test(remoteId)) return null;
  return `https://mercari-shops.com/seller/shops/${shopId}/products/${remoteId}/edit`;
}
