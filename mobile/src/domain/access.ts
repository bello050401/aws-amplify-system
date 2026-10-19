export interface MobileFeatures { ecListing: boolean; sales: boolean }
export const RESTRICTED_FEATURES: Readonly<MobileFeatures> = Object.freeze({ ecListing: false, sales: false });
export type MobileTab = "home" | "inventory" | "ec" | "outbound" | "sales";

export function isMobileFeatures(value: unknown): value is MobileFeatures {
  if (!value || typeof value !== "object") return false;
  const features = value as Record<string, unknown>;
  return typeof features.ecListing === "boolean" && typeof features.sales === "boolean";
}
export function canOpenTab(tab: MobileTab, features: MobileFeatures): boolean {
  return tab === "home" || tab === "inventory" || tab === "outbound" ||
    (tab === "ec" && features.ecListing === true) || (tab === "sales" && features.sales === true);
}
export function permittedTab<T extends MobileTab>(tab: T, features: MobileFeatures): T | 'home' {
  return canOpenTab(tab, features) ? tab : "home";
}
