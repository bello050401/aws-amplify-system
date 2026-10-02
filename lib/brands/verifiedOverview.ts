/**
 * Short brand facts checked against the brand's own published information.
 * These describe the company only; they do not authenticate an inventory item.
 * Do not copy the broader third-party catalog prose into this list unchecked.
 */
const VERIFIED_OVERVIEWS = {
  Vitra: {
    text: "Vitraは1950年に創業し、スイスのバーゼル近郊に本拠を置く家具メーカーです。",
    sourceUrl: "https://www.vitra.com/en-lp/about-vitra/facts",
    verifiedOn: "2026-10-02",
  },
} as const;

export function verifiedBrandOverview(selectedBrand: string, inventoryName: string, aliases: string[] = []):
  { text: string; sourceUrl: string; verifiedOn: string } | null {
  const key = selectedBrand.trim();
  const overview = VERIFIED_OVERVIEWS[key as keyof typeof VERIFIED_OVERVIEWS];
  if (!overview) return null;
  // An operator-selected brand alone is not enough to imply that the item is
  // from that brand. Require the brand name in the inventory's own title too.
  const matches = [key, ...aliases].filter(Boolean).some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i").test(inventoryName);
  });
  return matches ? overview : null;
}
