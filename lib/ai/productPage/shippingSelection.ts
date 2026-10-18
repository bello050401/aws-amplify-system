import { normalizeShippingPackages } from "@/lib/shipping/packages";
import type { ShippingRank } from "@/lib/shipping/rank";

/** Only the first package can inherit the product dimensions. Extra packages need their own rank. */
export function descriptionPackageSelection(
  value: unknown,
  estimatedRank: ShippingRank | null,
) {
  const ranks = normalizeShippingPackages(value).map(
    (p, i) => p.rank ?? (i === 0 ? estimatedRank : null),
  );
  const unresolved = ranks.flatMap((rank, i) =>
    !rank || rank === "OVERSIZE" ? [`${i + 1}口目`] : [],
  );
  return {
    ranks,
    reason: unresolved.length
      ? `${unresolved.join("・")}の配送サイズを確認してください。`
      : null,
  };
}
