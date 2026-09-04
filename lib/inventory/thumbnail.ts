import "server-only";
import { cookies } from "next/headers";
import sharp from "sharp";
import { copy, getUrl, uploadData } from "aws-amplify/storage/server";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";
import { fetchWithTimeout } from "@/lib/http/fetchWithTimeout";

/**
 * この経路の外部呼び出し。応答が返らないまま固まらないよう上限を持つ
 * （2026-09-04 健全化 PHASE 8 — lib/http/fetchWithTimeout.ts）。
 * どこが時間切れになったのかがログで分かるよう、名前を付けて渡す。
 */
const fetchExternal = (input: string | URL | Request, init?: RequestInit) =>
  fetchWithTimeout(input, init, { label: "画像の取得元" });


/**
 * BELLO統合改修 master指示書 Phase B(画像パフォーマンス優先度1-3:
 * 一覧サムネイルアーキテクチャ、オリジナル/サムネイル分離、同期時の
 * サムネイル生成)。
 *
 * The list table's image column has always rendered the SAME full-
 * resolution original as the detail page's hero image, just squeezed
 * into a 90×60 box via CSS (InventoryThumbnail.tsx / SIZE_CLASSES.list)
 * — every row's client browser downloads a full ZAICO/user photo (often
 * several hundred KB–a few MB) to display 90 pixels wide of it. This
 * file is the fix: a genuinely small (≤320px on the long edge, JPEG
 * ~70%) derivative object, generated ONCE at the moment an original is
 * created (ZAICO sync's downloadAndImportInventoryImage, or a manual
 * upload's resolveImages in app/actions/inventory.ts) and stored
 * alongside it under `inventory/thumbnails/` (same bucket/prefix
 * wildcard as every other inventory object — see amplify/storage/
 * resource.ts's `inventory/*` access rule, deliberately not touched by
 * this addition).
 *
 * Never throws: every caller treats a failed/skipped thumbnail as
 * "acceptable, not fatal" — imageTypes.ts's effectiveListThumbnailKey
 * falls back to the original whenever `thumbnailKey` is null, so a
 * resize failure only ever costs the size win, never breaks the image
 * itself or blocks saving/syncing the Inventory record it belongs to
 * (same error-isolation philosophy as downloadAndImportInventoryImage's
 * own image-content-type/size checks).
 */

/** Long-edge cap in pixels — comfortably larger than the list view's 90×60 CSS box even at a high-DPI (2x/3x) display, small enough that the whole point (tiny payload) still holds. Exported for scripts/verify-zaico-sync.ts's resize test to assert against directly rather than duplicating the number. */
export const THUMBNAIL_MAX_DIMENSION = 320;
const THUMBNAIL_JPEG_QUALITY = 72;

/** Keys under `inventory/` are UUID-random and never overwritten in place (a new upload always gets a fresh key — see newInventoryImageKey) — so every object this app ever serves is genuinely immutable, and caching it "forever" client-side is always safe, never a staleness risk. Applied to every new upload/copy (originals and thumbnails alike) — master指示書 Phase B優先度9. */
export const INVENTORY_IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";

function thumbnailKeyFor(): string {
  // Namespaced under inventory/thumbnails/ rather than mixed in with
  // originals — purely organizational (nothing in this app enumerates
  // `inventory/*` by listing the bucket; every reference is by exact
  // stored key), but keeps a human skimming the bucket in the S3 console
  // able to tell the two apart at a glance.
  return `inventory/thumbnails/${crypto.randomUUID()}.jpg`;
}

/**
 * The pure image-processing step (sharp only — no Amplify/S3 access at
 * all), split out so scripts/verify-zaico-sync.ts can unit-test the
 * actual resize behavior (dimensions, format, "never upscale") directly,
 * without needing a live Storage backend. Throws on genuinely
 * undecodable input — the caller (generateThumbnailFromBytes) is what
 * turns that into this module's usual "null, never throw" contract.
 */
export async function resizeToThumbnailJpeg(sourceBuffer: Buffer): Promise<Buffer> {
  return sharp(sourceBuffer)
    .rotate() // apply EXIF orientation before resizing — otherwise a portrait phone photo can end up sideways once EXIF metadata is dropped
    .resize({
      width: THUMBNAIL_MAX_DIMENSION,
      height: THUMBNAIL_MAX_DIMENSION,
      fit: "inside", // preserve aspect ratio, never crop — cropping is InventoryThumbnail's job (object-cover/-contain), not the stored thumbnail's
      withoutEnlargement: true, // a source already smaller than the cap is kept as-is, never upscaled
    })
    .jpeg({ quality: THUMBNAIL_JPEG_QUALITY })
    .toBuffer();
}

/**
 * Resizes already-in-memory image bytes and uploads the result as a new
 * `inventory/thumbnails/*` object. Split out from generateInventoryThumbnail
 * below so the ZAICO sync path (which already has the original's bytes in
 * memory right after downloading them from ZAICO — see
 * imageServerOps.ts's downloadAndImportInventoryImage) can generate its
 * thumbnail directly, without paying for a redundant re-download of the
 * object it just uploaded. Returns the new key, or null on any failure
 * (bad/corrupt image data, sharp couldn't decode it, the upload itself
 * failed) — logged, never re-thrown; see this file's header comment for
 * why that's the right contract here.
 */
export async function generateThumbnailFromBytes(sourceBuffer: Buffer): Promise<string | null> {
  try {
    const thumbnailBuffer = await resizeToThumbnailJpeg(sourceBuffer);

    const thumbnailPath = thumbnailKeyFor();
    await runWithAmplifyServerContext({
      nextServerContext: { cookies },
      operation: (contextSpec) =>
        uploadData(contextSpec, {
          path: thumbnailPath,
          data: thumbnailBuffer,
          options: { contentType: "image/jpeg", cacheControl: INVENTORY_IMAGE_CACHE_CONTROL },
        }).result,
    });
    return thumbnailPath;
  } catch (err) {
    console.error(`[generateThumbnailFromBytes] failed:`, err);
    return null;
  }
}

/**
 * The manual-upload path's entry point (app/actions/inventory.ts's
 * resolveImages) — the original was already uploaded straight from the
 * browser (ImageEditor.tsx), so the server doesn't have its bytes in
 * memory the way the ZAICO sync path does. There is no server-side
 * "download object bytes" API in the installed @aws-amplify/storage
 * version's server surface (only getProperties/getUrl/list/remove/copy/
 * uploadData) — so this gets a short-lived presigned GET URL for the
 * object this same server just confirmed exists (`sourcePath` always
 * comes from a just-completed upload or ZAICO import) and fetches it the
 * same way downloadAndImportInventoryImage fetches a ZAICO URL. Returns
 * null (never throws) on any failure, same contract as
 * generateThumbnailFromBytes.
 */
export async function generateInventoryThumbnail(sourcePath: string): Promise<string | null> {
  try {
    const { url } = await runWithAmplifyServerContext({
      nextServerContext: { cookies },
      operation: (contextSpec) => getUrl(contextSpec, { path: sourcePath }),
    });
    const res = await fetchExternal(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching own object "${sourcePath}"`);
    const sourceBuffer = Buffer.from(await res.arrayBuffer());
    return await generateThumbnailFromBytes(sourceBuffer);
  } catch (err) {
    console.error(`[generateInventoryThumbnail] failed for "${sourcePath}":`, err);
    return null;
  }
}

/**
 * Used only when duplicating an Inventory record (ImageEditor.tsx's
 * "copy" slot kind, resolved in app/actions/inventory.ts's resolveImages)
 * — the original is S3-copied to a new key (copyInventoryImage), and if
 * the source image already had a thumbnail, this copies THAT too rather
 * than paying for a full re-download+resize of an image we already have
 * a perfectly good small copy of (master指示書 Phase B優先度5: 変更が
 * なければサムネイル再生成をスキップ — a duplicate's photo is by
 * definition unchanged from its source). Returns null (never throws) on
 * failure, same contract as generateInventoryThumbnail — the caller
 * falls back to generating a fresh one from the newly-copied original.
 */
export async function copyInventoryThumbnail(sourceThumbnailPath: string): Promise<string | null> {
  const destinationPath = thumbnailKeyFor();
  try {
    await runWithAmplifyServerContext({
      nextServerContext: { cookies },
      operation: (contextSpec) => copy(contextSpec, { source: { path: sourceThumbnailPath }, destination: { path: destinationPath } }),
    });
    return destinationPath;
  } catch (err) {
    console.error(`[copyInventoryThumbnail] copy failed: "${sourceThumbnailPath}" -> "${destinationPath}"`, err);
    return null;
  }
}
