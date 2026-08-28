import "server-only";
import { cookies } from "next/headers";
import { copy, remove } from "aws-amplify/storage/server";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";

/**
 * Copies an `inventory/*` object to a fresh key under the same prefix and
 * returns the new key. Used only by duplicateInventory's flow in
 * app/actions/inventory.ts — see ImageEditor.tsx's "copy" slot kind for
 * why this must be a real S3-level copy (a new, independent object) and
 * not just pointing two Inventory records at the same storageKey:
 * deleting one record's image would silently break the other's.
 */
export async function copyInventoryImage(sourcePath: string, fileNameHint: string): Promise<string> {
  const destinationPath = `inventory/${crypto.randomUUID()}-${fileNameHint}`;
  await runWithAmplifyServerContext({
    nextServerContext: { cookies },
    operation: (contextSpec) =>
      copy(contextSpec, {
        source: { path: sourcePath },
        destination: { path: destinationPath },
      }),
  });
  return destinationPath;
}

/**
 * Best-effort delete of one `inventory/*` object. Called only after the
 * owning Inventory record has already been updated/deleted successfully
 * (see updateInventory/deleteInventory) — never awaited as a precondition
 * for the DB write, and a failure here is logged, not thrown: an orphaned
 * S3 object is a minor cleanup concern, the DB write already succeeded
 * and must not be rolled back because cleanup didn't.
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
