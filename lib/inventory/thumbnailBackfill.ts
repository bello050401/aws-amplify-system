import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { normalizeImageRecord, type InventoryImageRecord } from "./imageTypes";
import { generateInventoryThumbnail } from "./thumbnail";

/**
 * BELLO統合改修 master指示書 Phase B優先度4(既存画像のバックグラウンド
 * バックフィル) — every image created from here on gets its thumbnail at
 * upload/sync time (see thumbnail.ts), but every image that existed
 * before this Phase shipped still has `thumbnailKey: null` and falls
 * back to serving its full-resolution original in the list view (see
 * imageTypes.ts's effectiveListThumbnailKey) until it's either re-saved
 * (resolveImages self-heals it, see app/actions/inventory.ts) or this
 * backfill processes it directly.
 *
 * Deliberately NOT a persisted job/lock like lib/inventory/
 * zaicoBackgroundSync.ts's ZaicoSyncJob — that machinery exists there to
 * solve resume-after-interruption for a run that can span the ENTIRE
 * ZAICO catalog (potentially 1000+ items) and must never duplicate a
 * created record if re-run. This backfill has neither property: it's
 * idempotent by construction (an image with a thumbnail already is
 * simply skipped, cheaply, on every re-scan — never re-generated, never
 * duplicated) and its total input size is bounded by however many
 * Inventory images this account actually has, the same "a few hundred
 * records" scale the rest of this app is already sized around. A plain
 * cursor (DynamoDB nextToken) passed back to the client between bounded
 * calls is sufficient — building a second persisted-job architecture
 * here would be exactly the "過剰設計" (over-engineering) the master
 * instructions elsewhere explicitly warn against.
 */

/** How many Inventory records one `advance` call scans — bounded so a single Server Action call can never approach the ~3 minute request timeout even in the worst case (every image on every one of these records missing its thumbnail). */
const RECORDS_PER_ADVANCE = 20;

export interface ThumbnailBackfillProgress {
  /** Inventory records scanned this call (not necessarily all needing work — most images already have a thumbnail after the first few passes). */
  scanned: number;
  /** Images that had no thumbnailKey yet and were attempted this call. */
  attempted: number;
  /** Of those, how many actually got a thumbnail generated (the rest failed — logged in generateInventoryThumbnail, never fatal here either). */
  generated: number;
  /** Pass to the next advanceThumbnailBackfill call to continue; null means the scan reached the end. */
  nextToken: string | null;
  /** true once nextToken is null — nothing left to scan. */
  done: boolean;
}

export async function advanceThumbnailBackfill(nextToken: string | null): Promise<ThumbnailBackfillProgress> {
  const { data, nextToken: nt } = await serverDataClient.models.Inventory.list({
    filter: { deletedAt: { attributeExists: false } },
    nextToken: nextToken ?? undefined,
    limit: RECORDS_PER_ADVANCE,
    ...inventoryAuthMode,
  });

  let attempted = 0;
  let generated = 0;

  for (const item of data) {
    const images: InventoryImageRecord[] = (item.images ?? [])
      .filter((img): img is NonNullable<typeof img> => Boolean(img))
      .map(normalizeImageRecord);
    if (images.every((img) => img.thumbnailKey)) continue; // the common case after the first few passes — nothing to do, no write

    let changed = false;
    const updatedImages = await Promise.all(
      images.map(async (img) => {
        if (img.thumbnailKey) return img;
        attempted++;
        const thumbnailKey = await generateInventoryThumbnail(img.storageKey);
        if (thumbnailKey) {
          generated++;
          changed = true;
        }
        return { ...img, thumbnailKey };
      }),
    );

    if (changed) {
      // Only the images field is touched — no history log entry (this is
      // system-driven optimization work, not a user-visible content
      // change, and logging one row per record here would just be noise
      // in every item's history — matching how ZAICO's own "unchanged"
      // path already writes nothing rather than logging a no-op).
      await serverDataClient.models.Inventory.update({ id: item.id, images: updatedImages }, inventoryAuthMode);
    }
  }

  return {
    scanned: data.length,
    attempted,
    generated,
    nextToken: nt ?? null,
    done: !nt,
  };
}
