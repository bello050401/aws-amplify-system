export interface MobileFeatures { ecListing: boolean; sales: boolean }
export const RESTRICTED_FEATURES: Readonly<MobileFeatures> = Object.freeze({ ecListing: false, sales: false });
export type MobileTab = "home" | "inventory" | "ec" | "sales";

export function isMobileFeatures(value: unknown): value is MobileFeatures {
  if (!value || typeof value !== "object") return false;
  const features = value as Record<string, unknown>;
  return typeof features.ecListing === "boolean" && typeof features.sales === "boolean";
}
export function canOpenTab(tab: MobileTab, features: MobileFeatures): boolean {
  return tab === "home" || tab === "inventory" ||
    (tab === "ec" && features.ecListing === true) || (tab === "sales" && features.sales === true);
}
export function permittedTab(tab: MobileTab, features: MobileFeatures): MobileTab {
  return canOpenTab(tab, features) ? tab : "home";
}
