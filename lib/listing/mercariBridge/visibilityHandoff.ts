import { createHash } from "node:crypto";
import type { InventoryDetail } from "@/lib/inventory/queries";
import type { ChannelListingRecord, ListingDraftRecord } from "@/lib/listing/types";

const SHOP_ID = "evkhihBFFNn5hukMS9s36H";
const PRIVATE_TEST_INVENTORY = "dd273c1e-9b2a-4013-acc6-c445a481fab8";
const PROTECTED_PUBLIC_ID = "2JWp7EJx6aqKfn6dTXc5Q9";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const SKU = /^[A-Za-z0-9_-]{1,40}$/;

export type VisibilityPcJob = {
  schemaVersion: 1;
  action: "STOP" | "RELIST";
  target: { shopId: string; inventoryId: string; remoteId: string; title: string;
    skuCode: string; priceYen: number; quantity: number; visibilityPolicy: "PUBLIC_ALLOWED" };
  listing: { status: "ACTIVE"; externalListingId: string };
  fingerprint: string;
};

/** A no-send, repeatable handoff. The PC must re-read Shops before any claim or save. */
export function buildVisibilityPcJob(inventory: InventoryDetail,
  draft: ListingDraftRecord, listing: ChannelListingRecord,
  action: "STOP" | "RELIST" = "STOP"): VisibilityPcJob | null {
  const title = listing?.overrideTitle ?? draft?.title;
  const priceYen = listing?.overridePrice ?? draft?.price;
  if (!["STOP", "RELIST"].includes(action) ||
      typeof inventory?.id !== "string" || !UUID.test(inventory.id) ||
      inventory.id.toLowerCase() === PRIVATE_TEST_INVENTORY ||
      typeof inventory.sku !== "string" || !SKU.test(inventory.sku) ||
      !Number.isSafeInteger(inventory.quantity) || inventory.quantity < 0 ||
      draft?.inventoryId !== inventory.id || draft?.id !== listing?.listingDraftId ||
      listing?.inventoryId !== inventory.id || listing?.channel !== "MERCARI_SHOPS" ||
      listing.status !== "ACTIVE" || typeof listing.externalListingId !== "string" ||
      !ID.test(listing.externalListingId) ||
      listing.externalListingId === PROTECTED_PUBLIC_ID ||
      typeof title !== "string" || title !== title.trim() || !title ||
      title.length > 130 || /[\x00-\x1f\x7f]/.test(title) ||
      typeof priceYen !== "number" || !Number.isSafeInteger(priceYen) ||
      priceYen < 300 || priceYen > 9_999_999)
    return null;
  const body = { schemaVersion: 1 as const, action,
    target: { shopId: SHOP_ID, inventoryId: inventory.id,
      remoteId: listing.externalListingId, title,
      skuCode: inventory.sku, priceYen, quantity: inventory.quantity,
      visibilityPolicy: "PUBLIC_ALLOWED" as const },
    listing: { status: "ACTIVE" as const, externalListingId: listing.externalListingId } };
  return { ...body, fingerprint: createHash("sha256")
    .update(JSON.stringify(body)).digest("hex") };
}
