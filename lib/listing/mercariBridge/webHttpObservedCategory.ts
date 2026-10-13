/** Shops returns one root-to-leaf category path per selection, not one object.
 * Observed in GetProductDraft (2026-10-09) and EditProductPage (2026-10-13).
 */
export function observedCategoryLeafIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const leaves: string[] = [];
  for (const group of value) {
    const path = group?.category;
    if (!Array.isArray(path) || path.length === 0 ||
        !path.every(category => category &&
          typeof category.id === "string" && category.id.length > 0))
      return null;
    const ids = path.map(category => category.id as string);
    if (new Set(ids).size !== ids.length) return null;
    leaves.push(ids[ids.length - 1]);
  }
  return new Set(leaves).size === leaves.length ? leaves : null;
}
