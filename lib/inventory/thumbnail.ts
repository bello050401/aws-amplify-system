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

/**
 * 画像表示高速化・段階読込(P1) — 一覧サムネイル(320px)と原画像の間を
 * 埋める「中画像」の長辺上限。詳細ページのメイン画像(380px高だが物理
 * ピクセルでは高DPI×object-containで実質もっと要る)・EC参照画面が
 * 「原本を先読みしない」ためにまず表示する解像度。960は
 * 「380pxのCSS高さを3倍out DPIで表示しても十分」かつ「一覧の320pxより
 * 明確に大きい」を満たす、既存THUMBNAIL_MAX_DIMENSIONと同じ考え方の
 * キリのいい値(実画像PoCが無いためThumbnail同様の初期値、後日の実測で
 * 調整可)。JPEG品質はサムネイルより少し高め(78) — 拡大鏡ではなく
 * 「原本より先に見せる版」なので、サムネイルよりブロックノイズが
 * 目立ちやすい分だけ上げてある。
 */
export const MEDIUM_MAX_DIMENSION = 960;
const MEDIUM_JPEG_QUALITY = 78;

/** Keys under `inventory/` are UUID-random and never overwritten in place (a new upload always gets a fresh key — see newInventoryImageKey) — so every object this app ever serves is genuinely immutable, and caching it "forever" client-side is always safe, never a staleness risk. Applied to every new upload/copy (originals, thumbnails and medium derivatives alike) — master指示書 Phase B優先度9。 */
export const INVENTORY_IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Namespaced under `inventory/<prefix>/` rather than mixed in with originals — purely organizational (nothing in this app enumerates `inventory/*` by listing the bucket; every reference is by exact stored key), but keeps a human skimming the bucket in the S3 console able to tell originals/thumbnails/medium derivatives apart at a glance. */
function derivedImageKeyFor(prefix: "thumbnails" | "medium"): string {
  return `inventory/${prefix}/${crypto.randomUUID()}.jpg`;
}

/**
 * The pure image-processing step (sharp only — no Amplify/S3 access at
 * all), parametrized over the long-edge cap/quality so the thumbnail
 * (320px) and medium (960px) derivatives share the exact same resize
 * semantics (EXIF-safe, never-crop, never-upscale) rather than risking
 * the two drifting apart. Split out so scripts/verify-zaico-sync.ts can
 * unit-test the actual resize behavior directly, without needing a live
 * Storage backend. Throws on genuinely undecodable input — the callers
 * (generateThumbnailFromBytes/generateMediumFromBytes) turn that into
 * this module's usual "null, never throw" contract.
 */
async function resizeJpeg(sourceBuffer: Buffer, maxDimension: number, quality: number): Promise<Buffer> {
  return sharp(sourceBuffer)
    .rotate() // apply EXIF orientation before resizing — otherwise a portrait phone photo can end up sideways once EXIF metadata is dropped
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: "inside", // preserve aspect ratio, never crop — cropping is InventoryThumbnail's/the gallery's job (object-cover/-contain), not the stored derivative's
      withoutEnlargement: true, // a source already smaller than the cap is kept as-is, never upscaled
    })
    .jpeg({ quality })
    .toBuffer();
}

export async function resizeToThumbnailJpeg(sourceBuffer: Buffer): Promise<Buffer> {
  return resizeJpeg(sourceBuffer, THUMBNAIL_MAX_DIMENSION, THUMBNAIL_JPEG_QUALITY);
}

/** Exported for scripts/verify-zaico-sync.ts's resize test — same rationale as resizeToThumbnailJpeg. */
export async function resizeToMediumJpeg(sourceBuffer: Buffer): Promise<Buffer> {
  return resizeJpeg(sourceBuffer, MEDIUM_MAX_DIMENSION, MEDIUM_JPEG_QUALITY);
}

/** Shared upload step for both derivative kinds — resize, then upload under the right prefix with the same immutable cache-control every inventory object gets. Returns null (never throws) on any failure, the contract every caller below relies on. */
async function generateDerivedFromBytes(
  sourceBuffer: Buffer,
  resize: (buf: Buffer) => Promise<Buffer>,
  prefix: "thumbnails" | "medium",
  label: string,
): Promise<string | null> {
  try {
    const derivedBuffer = await resize(sourceBuffer);
    const derivedPath = derivedImageKeyFor(prefix);
    await runWithAmplifyServerContext({
      nextServerContext: { cookies },
      operation: (contextSpec) =>
        uploadData(contextSpec, {
          path: derivedPath,
          data: derivedBuffer,
          options: { contentType: "image/jpeg", cacheControl: INVENTORY_IMAGE_CACHE_CONTROL },
        }).result,
    });
    return derivedPath;
  } catch (err) {
    console.error(`[generateDerivedFromBytes:${label}] failed:`, err);
    return null;
  }
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
  return generateDerivedFromBytes(sourceBuffer, resizeToThumbnailJpeg, "thumbnails", "thumbnail");
}

/**
 * 画像表示高速化・段階読込(P1) — thumbnail版と対になる「中画像」版。
 * generateThumbnailFromBytesと全く同じ理由・同じ契約(null=失敗、
 * 例外を投げない)で、既にメモリ上にあるバイト列から生成する。
 */
export async function generateMediumFromBytes(sourceBuffer: Buffer): Promise<string | null> {
  return generateDerivedFromBytes(sourceBuffer, resizeToMediumJpeg, "medium", "medium");
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
 * 画像表示高速化・段階読込(P1) — generateInventoryThumbnailの中画像版。
 * 同じ理由(サーバー側にオリジナルのバイト列が無い手動アップロード経路
 * 用に、自分がアップロードしたばかりのオブジェクトを署名URL経由で
 * 読み直す)・同じ契約で動く。呼び出し元(app/actions/inventory.ts's
 * resolveImages)がサムネイルと並行してではなく順番に呼ぶことで、
 * 同じsourcePathに対して署名URL取得+fetchが2回走る(サムネイル用/
 * 中画像用)——1枚のアップロードにつき2回の追加往復は、サムネイルの
 * 導入時から許容されている「必須ではない」コストと同じ性質のもの
 * (失敗しても保存自体は止まらない)。
 */
export async function generateInventoryMedium(sourcePath: string): Promise<string | null> {
  try {
    const { url } = await runWithAmplifyServerContext({
      nextServerContext: { cookies },
      operation: (contextSpec) => getUrl(contextSpec, { path: sourcePath }),
    });
    const res = await fetchExternal(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching own object "${sourcePath}"`);
    const sourceBuffer = Buffer.from(await res.arrayBuffer());
    return await generateMediumFromBytes(sourceBuffer);
  } catch (err) {
    console.error(`[generateInventoryMedium] failed for "${sourcePath}":`, err);
    return null;
  }
}

/**
 * app/actions/inventory.ts's resolveImagesが「サムネイルが無い/中画像が
 * 無い」を同時に検知した場合の入口 — generateInventoryThumbnailと
 * generateInventoryMediumを別々に呼ぶと同じsourcePathへ署名URL取得+
 * fetchが2回走ってしまう(このファイルのgenerateInventoryMediumの
 * コメント参照)。ここは1回だけfetchし、同じバイト列から両方を
 * 生成する — ZAICO同期経路(downloadAndImportInventoryImage)が既に
 * 実践している「1回のダウンロードで両方作る」原則を、手動アップロード
 * 経路にも揃える。個別のgenerateInventoryThumbnail/generateInventoryMedium
 * は引き続きthumbnailBackfill.ts等の「片方だけ欲しい」呼び出し元向けに
 * 残す。
 */
export async function generateInventoryDerivatives(sourcePath: string): Promise<{ thumbnailKey: string | null; mediumKey: string | null }> {
  try {
    const { url } = await runWithAmplifyServerContext({
      nextServerContext: { cookies },
      operation: (contextSpec) => getUrl(contextSpec, { path: sourcePath }),
    });
    const res = await fetchExternal(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching own object "${sourcePath}"`);
    const sourceBuffer = Buffer.from(await res.arrayBuffer());
    const [thumbnailKey, mediumKey] = await Promise.all([generateThumbnailFromBytes(sourceBuffer), generateMediumFromBytes(sourceBuffer)]);
    return { thumbnailKey, mediumKey };
  } catch (err) {
    console.error(`[generateInventoryDerivatives] failed for "${sourcePath}":`, err);
    return { thumbnailKey: null, mediumKey: null };
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
  const destinationPath = derivedImageKeyFor("thumbnails");
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

/** copyInventoryThumbnailの中画像版 — 複製元が既に中画像を持っていれば(中身はバイト単位で複製元と同一なので)コピーで済ませ、無ければ呼び出し元(resolveImages)が新しくコピーされた原本から生成し直す。 */
export async function copyInventoryMedium(sourceMediumPath: string): Promise<string | null> {
  const destinationPath = derivedImageKeyFor("medium");
  try {
    await runWithAmplifyServerContext({
      nextServerContext: { cookies },
      operation: (contextSpec) => copy(contextSpec, { source: { path: sourceMediumPath }, destination: { path: destinationPath } }),
    });
    return destinationPath;
  } catch (err) {
    console.error(`[copyInventoryMedium] copy failed: "${sourceMediumPath}" -> "${destinationPath}"`, err);
    return null;
  }
}
