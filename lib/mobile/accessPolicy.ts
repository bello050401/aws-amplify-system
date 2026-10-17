export type MobileFeature = "ecListing" | "sales";
export type MobileFeatures = Record<MobileFeature, boolean>;

/** Only call with groups from a credential-validated server session. Deny wins, including for ADMIN. */
export function mobileFeaturesForGroups(groups: unknown): MobileFeatures {
  if (!Array.isArray(groups) || !groups.every(group => typeof group === "string") ||
      !groups.some(group => ["ADMIN", "EDITOR", "VIEWER"].includes(group))) {
    return { ecListing: false, sales: false };
  }
  return { ecListing: !groups.includes("MOBILE_HIDE_EC"), sales: !groups.includes("MOBILE_HIDE_SALES") };
}
