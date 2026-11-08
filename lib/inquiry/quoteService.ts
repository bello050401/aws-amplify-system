import "server-only";
import { getListingDraftForInventory } from "@/lib/listing/service";
import { listShippingRates } from "@/lib/shipping/service";
import {
  calculateInquiryQuote,
  type InquiryQuote,
  type ChargePolicy,
} from "./quote";
/** Reads current product-owned packing data. Never mutates listing or inventory. */
export async function quoteInquiryShipping(p: {
  inventoryId: string | null;
  destination: string | null;
  declaredRank: string | null;
  quantity: number | null;
  unitPriceYen: number | null;
  priceCurrent: boolean;
  channel: string;
  exceptionalRegion: boolean;
  specialWorkUnconfirmed: boolean;
}): Promise<InquiryQuote> {
  const at = new Date().toISOString();
  let draft: Awaited<ReturnType<typeof getListingDraftForInventory>> = null;
  let rates: Awaited<ReturnType<typeof listShippingRates>> = [];
  let failed = false;
  try {
    [draft, rates] = await Promise.all([
      p.inventoryId ? getListingDraftForInventory(p.inventoryId) : null,
      listShippingRates(),
    ]);
  } catch {
    failed = true;
  }
  const packages = draft?.shippingPackages;
  const ranks = packages?.every((x) => x.rank)
    ? packages.map((x) => x.rank!)
    : p.declaredRank
      ? [p.declaredRank]
      : [];
  // An explicit package list describes one listing unit; multi-unit packing requires review.
  const packagesConfirmed = ranks.length > 0 && p.quantity === 1;
  const channel = p.channel === "LINE" && p.priceCurrent ? "BASE" : p.channel;
  const policy: ChargePolicy | null =
    p.priceCurrent &&
    ["BASE", "MERCARI_SHOPS", "YAHOO", "INDEPENDENT"].includes(channel)
      ? {
          id: "COMMON_EC_CHANNELS:" + channel,
          version: "commonSettings-2026-11-08.1",
          mode: ["BASE", "MERCARI_SHOPS"].includes(channel)
            ? "INCLUDED"
            : "SEPARATE",
          approved: true,
        }
      : null;
  return calculateInquiryQuote({
    at,
    asOfDate: new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10),
    origin: "埼玉県",
    destination: p.destination,
    service: draft?.shippingMethod ?? (p.declaredRank ? "KAZAI" : null),
    ranks,
    packagesConfirmed,
    quantity: p.quantity,
    unitPriceYen: p.unitPriceYen,
    policy,
    rates,
    lookupFailed: failed,
    exceptionalRegion: p.exceptionalRegion,
    specialWorkUnconfirmed: p.specialWorkUnconfirmed,
  });
}
