/**
 * Phase C.5 — normal vs. damage/condition photos, and an explicit "top
 * image" concept, layered onto the existing `Inventory.images` field
 * without changing its shape at the GraphQL level (see amplify/data/
 * resource.ts's InventoryImage customType comment for the full
 * reasoning). Not `server-only`: read by server pages/actions AND the
 * client-side ImageEditor.
 *
 * Every function here is the ONE place that turns a raw, possibly-legacy
 * image object into a normalized one — nothing else in the app should
 * inspect `.type`/`.isPrimary` directly.
 */
export type InventoryImageType = "NORMAL" | "DAMAGE";

export interface InventoryImageRecord {
  storageKey: string;
  sortOrder: number;
  type: InventoryImageType;
  isPrimary: boolean;
  /** "ZAICO" for a photo the sync imported; null for anything BELLO added itself. The one thing the ZAICO sync uses to find "its" image among possibly several NORMAL photos, so it only ever replaces that one — see lib/inventory/zaicoSync.ts. */
  sourceSystem: string | null;
  /** ZAICO's `item_image.url` at the time this object was imported — compared on the next sync to skip re-downloading an unchanged photo. Meaningless (and always null) for a non-ZAICO image. */
  sourceUrl: string | null;
}

/** Shape as it actually comes back from Amplify Data — `type`/`isPrimary`/`sourceSystem`/`sourceUrl` absent (null/undefined) on any row written before the field existed. */
export interface RawInventoryImage {
  storageKey: string;
  sortOrder: number;
  type?: string | null;
  isPrimary?: boolean | null;
  sourceSystem?: string | null;
  sourceUrl?: string | null;
}

/** Legacy image (no `type`) → NORMAL; anything else → whatever it says. This is the one and only migration rule this Phase relies on — no data is ever rewritten to add it. */
export function normalizeImageRecord(img: RawInventoryImage): InventoryImageRecord {
  return {
    storageKey: img.storageKey,
    sortOrder: img.sortOrder,
    type: img.type === "DAMAGE" ? "DAMAGE" : "NORMAL",
    isPrimary: img.isPrimary === true,
    sourceSystem: img.sourceSystem ?? null,
    sourceUrl: img.sourceUrl ?? null,
  };
}

export function splitImagesByType(images: InventoryImageRecord[]): { normal: InventoryImageRecord[]; damage: InventoryImageRecord[] } {
  return {
    normal: images.filter((i) => i.type === "NORMAL").sort((a, b) => a.sortOrder - b.sortOrder),
    damage: images.filter((i) => i.type === "DAMAGE").sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

/**
 * The single "which image represents this Inventory item" rule: an
 * explicit isPrimary among the NORMAL images wins; failing that, the
 * first NORMAL image by sortOrder — which is exactly the old "index 0 =
 * main image" behavior, so every record that predates Phase C.5 (no
 * isPrimary set on anything) keeps showing the same top image it always
 * did. A damage photo is never eligible, by construction (splitImagesByType
 * already excludes it before this ever looks at isPrimary).
 */
export function resolveTopImage(images: InventoryImageRecord[]): InventoryImageRecord | null {
  const { normal } = splitImagesByType(images);
  return normal.find((i) => i.isPrimary) ?? normal[0] ?? null;
}
