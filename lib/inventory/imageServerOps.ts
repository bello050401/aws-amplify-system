import "server-only";
import { cookies } from "next/headers";
import { copy, remove } from "aws-amplify/storage/server";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";

/**
 * Only letters/digits, max 8 chars (covers jpg/jpeg/png/webp/heic/...).
 * Anything else (no extension, a weird one) is dropped rather than risked.
 */
function safeExtension(path: string): string {
  const match = /\.([a-zA-Z0-9]{1,8})$/.exec(path);
  return match ? `.${match[1].toLowerCase()}` : "";
}

/**
 * Builds a new `inventory/*` key that is guaranteed ASCII-only — see the
 * root-cause note on copyInventoryImage below for why this matters
 * specifically for *copies*, not just tidiness.
 */
export function newInventoryImageKey(sourcePathForExtension?: string): string {
  return `inventory/${crypto.randomUUID()}${sourcePathForExtension ? safeExtension(sourcePathForExtension) : ""}`;
}

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
