import "server-only";
import { cookies } from "next/headers";
import { copy, remove, uploadData } from "aws-amplify/storage/server";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";
import { generateThumbnailFromBytes, INVENTORY_IMAGE_CACHE_CONTROL } from "./thumbnail";
import { newInventoryImageKey } from "./imageKeys";

// Re-exported for every existing external caller (app/actions/inventory.ts,
// zaicoSyncPorts.ts) — this function itself moved to imageKeys.ts (BELLO
// 統合改修 master指示書 Phase B) purely to break a circular import with
// thumbnail.ts (which also needs it, and which this file now imports from
// for the line above) — see imageKeys.ts's file comment.
export { newInventoryImageKey } from "./imageKeys";

/**
 * Copies an `inventory/*` object to a fresh key under the same prefix and
 * returns the new key. Used only by createInventory's "copy" image slots
 * (duplicating an existing record) — see ImageEditor.tsx for why this
 * must be a real S3-level copy, not just pointing two Inventory records
 * at the same storageKey: deleting one record's image would silently
 * break the other's.
 *
 * Root cause of the "A network error has occurred." failure reported
 * from real duplicate testing: S3's copy operation sends the *source*
 * key as the literal value of the `x-amz-copy-source` HTTP header, and
 * neither this SDK nor S3 itself accepts arbitrary bytes there — a
 * source key containing a space, parentheses, or non-ASCII characters
 * (Japanese filenames, or Windows' own "(1)"/"(2)" duplicate-name
 * suffixes — both completely ordinary for real photos) produces an
 * invalid header, which fails before any HTTP response comes back and
 * surfaces through the SDK as exactly that generic network-error
 * message — never a helpful one, because from the SDK's perspective no
 * request was ever actually sent. Plain uploads never hit this, which is
 * why "normal registration" was unaffected: `uploadData()` only needs
 * the key correctly encoded in a URL *path*, not raw in a header.
 *
 * The real fix is upstream of this function — new uploads (ImageEditor.tsx)
 * now key everything as `inventory/<uuid><ext>`, never embedding the
 * original filename at all, so this problem cannot recur for anything
 * uploaded from here on. This function's own destination key is
 * generated the same safe way. What it can't fix is a *source* key that
 * already has unsafe characters baked in from before that upstream fix —
 * see the catch block below for how that specific case is surfaced.
 */
export async function copyInventoryImage(sourcePath: string): Promise<string> {
  const destinationPath = newInventoryImageKey(sourcePath);
  try {
    await runWithAmplifyServerContext({
      nextServerContext: { cookies },
      operation: (contextSpec) =>
        copy(contextSpec, {
          source: { path: sourcePath },
          destination: { path: destinationPath },
        }),
    });
    return destinationPath;
  } catch (err) {
    console.error(`[copyInventoryImage] copy failed: "${sourcePath}" -> "${destinationPath}"`, err);
    throw new Error(
      `画像の複製に失敗しました(元画像: ${sourcePath})。ファイル名に日本語や特殊文字、空白が含まれる古い画像はコピーできない場合があります。詳細画面で該当の画像を一度削除し、再度アップロードしてから複製をお試しください。`,
    );
  }
}

/** ZAICOの商品画像として受け入れる実際の画像MIME型のみ(拡張子は信用しない — spec: 「file extensionを信用し過ぎない」「invalid mime拒否」)。 */
const ALLOWED_IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/heic", "image/heif"]);

/** 1枚あたりの上限(バイト) — 壊れたURL/想定外の巨大レスポンスでメモリを圧迫しないための安全弁(spec: 「file size上限」)。ZAICOの実運用画像はこれで十分収まる想定。 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB

/** fetch自体がハングし続けないための上限(spec: 「timeout」)。 */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * ZAICO image sync (implementation instructions §14-18、AWSテスト環境
 * 構築指示 §12-13で強化): downloads ZAICO's `item_image.url` server-side
 * and re-uploads it into BELLO's own S3 under the same safe
 * `inventory/<uuid><ext>` key convention every other image uses — the
 * ZAICO URL is NEVER stored as a hotlink anywhere the UI would render it
 * directly (spec: ダウンロード後、BELLO自身のS3へ保存)。この関数は商品
 * 単位・画像単位で1枚ずつ処理する(呼び出し元のlib/inventory/zaicoSync.ts
 * が1商品ずつ順番に呼ぶ) — 複数画像を1つの巨大Bufferへまとめて読み込む
 * ことはしない。
 *
 * 強化点(AWSテスト環境構築指示 §12/§13/§22):
 *  - timeout: AbortControllerでFETCH_TIMEOUT_MSを超えるfetchを中断する
 *    (壊れたURL/応答しないホストでハングし続けない)。
 *  - invalid mime拒否: レスポンスのContent-Typeヘッダを実際に検査し、
 *    ALLOWED_IMAGE_CONTENT_TYPESに無い型は拒否する — URLの拡張子は
 *    一切信用しない(spec: 「file extensionを信用し過ぎない」)。
 *  - file size上限: Content-Lengthヘッダ(あれば)とダウンロード後の実
 *    バイト数の両方をMAX_IMAGE_BYTESと比較し、超過分は拒否する(嘘の
 *    Content-Lengthやヘッダ欠如でも実サイズ側のチェックで防げる)。
 *
 * The caller (lib/inventory/zaicoSync.ts) is responsible for deciding
 * WHETHER to call this at all — it compares the new URL against the
 * image's last-synced `sourceUrl` first and skips re-downloading when
 * unchanged; this function itself always downloads unconditionally when
 * called.
 *
 * BELLO統合改修 master指示書 Phase B(画像パフォーマンス優先度3: ZAICO
 * 同期時のサムネイル生成): also generates the small list-view thumbnail
 * right here, once, from the same downloaded bytes an original sync
 * ever gets — never a second, separately-scheduled step, and never
 * re-run on a later sync of the same unchanged image (the caller only
 * calls this function at all when the ZAICO URL actually changed).
 * `thumbnailKey` is null when generation failed — never fatal, see
 * lib/inventory/thumbnail.ts's own comment.
 */
export async function downloadAndImportInventoryImage(sourceUrl: string): Promise<{ storageKey: string; thumbnailKey: string | null }> {
  let blob: Blob;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(sourceUrl, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_IMAGE_CONTENT_TYPES.has(contentType)) {
      throw new Error(`invalid content-type: "${contentType || "(なし)"}"`);
    }

    const contentLengthHeader = res.headers.get("content-length");
    const declaredLength = contentLengthHeader ? Number(contentLengthHeader) : NaN;
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
      throw new Error(`image too large: declared ${declaredLength} bytes`);
    }

    blob = await res.blob();
    if (blob.size > MAX_IMAGE_BYTES) {
      // Content-Lengthが無い/嘘だった場合の最終防衛線 — ダウンロード後
      // の実サイズでも必ず上限を確認する。
      throw new Error(`image too large: actual ${blob.size} bytes`);
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    console.error(`[downloadAndImportInventoryImage] fetch failed: "${sourceUrl}"`, err);
    if (aborted) throw new Error(`ZAICOの画像の取得がタイムアウトしました(URL: ${sourceUrl})。`);
    throw new Error(`ZAICOの画像の取得に失敗しました(URL: ${sourceUrl})。${err instanceof Error ? err.message : ""}`.trim());
  }

  const destinationPath = newInventoryImageKey(sourceUrl);
  try {
    await runWithAmplifyServerContext({
      nextServerContext: { cookies },
      operation: (contextSpec) =>
        uploadData(contextSpec, {
          path: destinationPath,
          data: blob,
          options: { cacheControl: INVENTORY_IMAGE_CACHE_CONTROL },
        }).result,
    });
  } catch (err) {
    console.error(`[downloadAndImportInventoryImage] upload failed: "${destinationPath}"`, err);
    throw new Error(`ZAICOの画像のアップロードに失敗しました(URL: ${sourceUrl})。`);
  }

  // Resizes the SAME bytes just uploaded, already in memory — never a
  // second fetch of the object this function just wrote (see
  // thumbnail.ts's generateThumbnailFromBytes/generateInventoryThumbnail
  // split for why the manual-upload path can't take this shortcut).
  const thumbnailKey = await generateThumbnailFromBytes(Buffer.from(await blob.arrayBuffer()));
  return { storageKey: destinationPath, thumbnailKey };
}

/**
 * Best-effort delete of one `inventory/*` object. Called only after the
 * owning Inventory record has already been updated/deleted/aborted
 * successfully (see createInventory/updateInventory/deleteInventory) —
 * never awaited as a precondition for the DB write, and a failure here
 * is logged, not thrown: an orphaned S3 object is a minor cleanup
 * concern, it must never roll back a DB write that already succeeded
 * (or block reporting a failure that already happened).
 */
export async function removeInventoryImage(path: string): Promise<void> {
  try {
    await runWithAmplifyServerContext({
      nextServerContext: { cookies },
      operation: (contextSpec) => remove(contextSpec, { path }),
    });
  } catch (err) {
    console.error(`[removeInventoryImage] failed to delete "${path}":`, err);
  }
}
