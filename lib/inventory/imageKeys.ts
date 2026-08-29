/**
 * Pulled out of lib/inventory/imageServerOps.ts (BELLO統合改修 master指示書
 * Phase B) purely to break a circular import: thumbnail.ts needs this to
 * name its own thumbnail objects, and imageServerOps.ts now needs
 * thumbnail.ts (to generate one right after uploading an original) — both
 * importing this instead of one importing the other keeps that a
 * one-directional dependency graph. Not `server-only`: pure string
 * manipulation, no Amplify/Data/Storage access at all.
 */

/**
 * Only letters/digits, max 8 chars (covers jpg/jpeg/png/webp/heic/...).
 * Anything else (no extension, a weird one) is dropped rather than risked.
 */
function safeExtension(path: string): string {
  const match = /\.([a-zA-Z0-9]{1,8})$/.exec(path);
  return match ? `.${match[1].toLowerCase()}` : "";
}

/**
 * Builds a new `inventory/*` key that is guaranteed ASCII-only — see
 * imageServerOps.ts's copyInventoryImage for why this matters
 * specifically for *copies*, not just tidiness.
 */
export function newInventoryImageKey(sourcePathForExtension?: string): string {
  return `inventory/${crypto.randomUUID()}${sourcePathForExtension ? safeExtension(sourcePathForExtension) : ""}`;
}
