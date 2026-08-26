import type { BaseItem } from "@/lib/base";
import type { TemplateType } from "./types";

/**
 * Deterministic (non-AI) guess at which template fits a selection, per
 * spec §9. Kept out of the AI prompt on purpose — which template applies
 * is a structural fact about the selection (do the titles share a model
 * name? do all items share a brand?), not something worth spending a
 * model call or risking a hallucinated judgment on. The admin can always
 * override the suggestion in the UI.
 */
export function suggestTemplateType(items: BaseItem[]): TemplateType {
  if (items.length === 0) return "FEATURE";

  const brands = new Set(items.map((i) => i.brand).filter(Boolean));
  const commonModelName = longestCommonTitlePrefix(items.map((i) => i.title));

  // Same model, different color/spec (e.g. "vitra Softshell Chair / Red" ×8)
  if (commonModelName.length >= 6) return "COLLECTION";

  // Different models, one brand (e.g. 10 vitra pieces)
  if (brands.size === 1) return "BRAND";

  return "FEATURE";
}

/**
 * What's left of an item's title after stripping the prefix it shares
 * with the rest of the selection — e.g. "vitra Softshell Chair / レッド"
 * minus "vitra Softshell Chair /" leaves "レッド". This is how
 * ColorVariation gets its labels without ever asking the AI to name a
 * color it wasn't given.
 */
export function deriveVariationLabel(title: string, commonPrefix: string): string {
  return title.slice(commonPrefix.length).replace(/^[\s/,\-・]+/, "").trim();
}

export function longestCommonTitlePrefix(titles: string[]): string {
  if (titles.length < 2) return titles[0] ?? "";
  const [first, ...rest] = titles;
  let prefix = first;
  for (const title of rest) {
    let i = 0;
    while (i < prefix.length && i < title.length && prefix[i] === title[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix.trim();
}

export function suggestSlug(title: string, items: BaseItem[]): string {
  const brand = items.find((i) => i.brand)?.brand;
  const base = `${brand ?? ""} ${title}`
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  return base || `feature-${Date.now()}`;
}
