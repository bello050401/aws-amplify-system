import type { ChannelListingRecord } from "@/lib/listing/types";
import { BASE_LISTING_ERROR_LABEL } from "./errors";

/** An explicit HTTP rejection proves items/add did not create a product. */
export function canRetryRejectedBaseCreate(listing: ChannelListingRecord | null): boolean {
  return listing?.status === "ERROR" && !listing.externalListingId && [
    BASE_LISTING_ERROR_LABEL.REMOTE_VALIDATION_ERROR,
    BASE_LISTING_ERROR_LABEL.PERMISSION_DENIED,
    BASE_LISTING_ERROR_LABEL.AUTH_FAILED,
  ].includes(listing.lastError ?? "");
}
