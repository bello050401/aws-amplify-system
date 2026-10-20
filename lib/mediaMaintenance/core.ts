/** Immutable upload keys only. Never collect unknown buckets or business documents. */
export function isManagedInventoryImage(key: string): boolean {
  return /^inventory\/(?:thumbnails\/|medium\/|processed\/)?[0-9a-f-]{36}\.(?:jpg|jpeg|png|webp|gif|avif|heic|heif)$/i.test(
    key,
  );
}

/** Include keys nested in AWSJSON and embedded in signed image URLs/HTML. */
export function collectReferencedKeys(
  value: unknown,
  result = new Set<string>(),
): Set<string> {
  if (typeof value === "string") {
    let text = value;
    try {
      text = decodeURIComponent(text);
    } catch {
      /* malformed escape: retain the original */
    }
    for (const match of text.matchAll(
      /inventory\/(?:thumbnails\/|medium\/|processed\/)?[0-9a-f-]{36}\.(?:jpeg|jpg|png|webp|gif|avif|heic|heif)/gi,
    ))
      result.add(match[0]);
    if (/^\s*[\[{]/.test(value)) {
      try {
        collectReferencedKeys(JSON.parse(value), result);
      } catch {
        /* plain text */
      }
    }
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value))
      collectReferencedKeys(child, result);
  }
  return result;
}

export const ORPHAN_GRACE_MS = 7 * 86400000;
export interface StoredImage {
  key: string;
  etag: string;
  modifiedAt: string;
  size: number;
}
export interface OrphanObservation {
  id: string;
  etag: string;
  firstSeenAt: string;
}
export function orphanAction(
  object: StoredImage,
  referenceKeys: Set<string>,
  previous: OrphanObservation | undefined,
  now: number,
): "KEEP" | "OBSERVE" | "DELETE" {
  if (
    !isManagedInventoryImage(object.key) ||
    !object.etag ||
    !Number.isFinite(Date.parse(object.modifiedAt))
  )
    return "KEEP";
  if (
    referenceKeys.has(object.key) ||
    Date.parse(object.modifiedAt) >= now - ORPHAN_GRACE_MS
  )
    return "KEEP";
  if (
    !previous ||
    previous.etag !== object.etag ||
    !Number.isFinite(Date.parse(previous.firstSeenAt))
  )
    return "OBSERVE";
  return Date.parse(previous.firstSeenAt) < now - ORPHAN_GRACE_MS
    ? "DELETE"
    : "OBSERVE";
}

// A failure reading ANY reference table aborts the entire sweep. A missing table
// is never an empty table. Completed work stays in S3 until two successful reads,
// at least seven days apart, both find it unused.
export const MEDIA_REFERENCE_MODELS = [
  "Inventory",
  "ListingDraft",
  "ChannelListing",
  "ImageProcessingVersion",
  "ProcessingJob",
  "PhotoProfile",
  "GeneratedProductPage",
  "BelloStyleProfile",
  "YahooAuctionPreparation",
  "MercariBridgeHttpDraftJob",
  "OutboundItem",
  "BaseProductArchive",
  "BaseItemCache",
  "Feature",
  "FeatureItem",
  "KnowledgeDocument",
  "KnowledgeDocumentRevision",
  "MercariBridgeHttpSendAttempt",
] as const;

/** Processing rows stop owning media when their inventory/image is deleted. */
export function liveMediaReferenceRows(
  tables: Record<string, Record<string, unknown>[]>,
): unknown[] {
  const liveImages = new Map(
    (tables.Inventory || []).map((row) => [
      String(row.id),
      collectReferencedKeys(row.images),
    ]),
  );
  return Object.entries(tables).flatMap(([model, rows]) =>
    model === "ProcessingJob" || model === "ImageProcessingVersion"
      ? rows.filter((row) =>
          liveImages
            .get(String(row.inventoryId))
            ?.has(String(row.imageStorageKey)),
        )
      : rows,
  );
}
