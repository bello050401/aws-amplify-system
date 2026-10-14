/** Labels and IDs observed together in the supplied 2026-10-09 HAR.
 * Shared by mapping, write validation and readback so a selected condition
 * cannot silently become the default condition at a later stage.
 */
const CONDITIONS = {
  NEW: "CONDITION_BRAND_NEW",
  LIKE_NEW: "CONDITION_ALMOST_NEW",
  NO_NOTABLE_DAMAGE: "CONDITION_CLEAN",
  SLIGHT_DAMAGE: "CONDITION_LITTLE_DIRTY",
  DAMAGE: "CONDITION_DIRTY",
  BAD: "CONDITION_BAD",
} as const;
export type ShopsCondition = (typeof CONDITIONS)[keyof typeof CONDITIONS];
export function shopsConditionFor(value: unknown): ShopsCondition | null {
  return typeof value === "string" && Object.hasOwn(CONDITIONS, value) ?
    CONDITIONS[value as keyof typeof CONDITIONS] : null;
}

/** null is malformed, [] is an explicit choice of no brand. */
export function shopsBrandIdsFor(pack: { brandId?: unknown; brandName?: unknown }): string[] | null {
  if (pack.brandId === null && pack.brandName === null) return [];
  return typeof pack.brandId === "string" && /^[A-Za-z0-9]{1,64}$/.test(pack.brandId) &&
    typeof pack.brandName === "string" && pack.brandName.trim().length > 0 ? [pack.brandId] : null;
}
