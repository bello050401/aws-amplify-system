/**
 * Dependency-free cache primitives for useInventoryImageUrl.ts.
 *
 * Kept in its own module on purpose: no React import, no aws-amplify
 * import, no DOM global read at module scope. That lets this file's
 * behavior be exercised with plain `node` (see
 * scripts/verify-inventory-image-cache.ts) in environments where
 * `npm install` / `next dev` / `tsc` aren't available, and keeps the
 * cache/dedupe rules — the part worth testing in isolation — separate
 * from the hook's React lifecycle plumbing.
 */

export interface ImageUrlCacheEntry {
  readonly url: string;
  /** epoch ms; the entry is stale at/after this instant. */
  readonly expiresAt: number;
  /**
   * Cognito Identity Pool identity that produced `url`. Required so a
   * sessionStorage-persisted entry can never be handed to a *different*
   * signed-in user within the same tab (sign-out followed by a different
   * sign-in, without a full reload in between) — see isSameIdentity().
   */
  readonly identityId: string;
}

/**
 * A presigned S3 URL signed with temporary (STS) credentials — which is
 * what Cognito Identity Pools hand out — stops working once *those
 * credentials* expire, even if its own `X-Amz-Expires` window hasn't
 * elapsed yet. So neither expiry alone is safe to trust; the entry is
 * only good until the earlier of the two, minus a safety margin so nothing
 * is ever served (or persisted) right at the edge of going stale.
 */
export function safeExpiryMs(urlExpiresAtMs: number, credentialsExpiresAtMs: number | null, marginMs: number): number {
  const bound = credentialsExpiresAtMs === null ? urlExpiresAtMs : Math.min(urlExpiresAtMs, credentialsExpiresAtMs);
  return bound - marginMs;
}

export function isFresh(entry: ImageUrlCacheEntry | undefined | null, now: number): entry is ImageUrlCacheEntry {
  return !!entry && entry.expiresAt > now;
}

export function isSameIdentity(entry: ImageUrlCacheEntry | undefined | null, identityId: string): boolean {
  return !!entry && entry.identityId === identityId;
}

/**
 * Dedupes concurrent async work keyed by a string — e.g. two
 * InventoryThumbnail instances mounting with the same storageKey at the
 * same time (a list row and, say, a gallery thumbnail for the same
 * photo) previously each ran their own independent getUrl() signature.
 * All callers that arrive while one is in flight share that single
 * promise instead. The promise is only held while in flight: once it
 * settles (success *or* failure) it's removed, so the next caller (a
 * remount, or a retry after failure) always starts a fresh attempt
 * rather than replaying a stale result.
 */
export class InFlightMap<T> {
  private readonly map = new Map<string, Promise<T>>();

  run(key: string, factory: () => Promise<T>): Promise<T> {
    const existing = this.map.get(key);
    if (existing) return existing;
    const created = factory().finally(() => {
      if (this.map.get(key) === created) this.map.delete(key);
    });
    this.map.set(key, created);
    return created;
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

const STORAGE_PREFIX = "bello:inventory:imgcache:v1:";

function storageKeyFor(storageKey: string): string {
  return STORAGE_PREFIX + storageKey;
}

/**
 * Minimal shape of the Web Storage API this module needs — lets tests
 * inject a plain-object fake instead of requiring a DOM/jsdom dependency,
 * and lets the hook pass `null` when sessionStorage isn't available at
 * all (SSR, storage disabled, etc).
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

/**
 * sessionStorage-backed persistence — tab-scoped by construction (a new
 * tab, or the same tab after it's closed, starts empty), so it never
 * leaks a signed URL to a different browsing context, but *does* survive
 * a reload of the same tab, which is the "再訪・ページ更新後" case this
 * cache exists for.
 *
 * Every method swallows storage errors (disabled storage, quota,
 * corrupted/foreign JSON under our key prefix, private-mode
 * restrictions) and degrades to "no persisted entry" rather than
 * throwing — a broken sessionStorage must never break image loading,
 * only remove the reload-survival speedup.
 */
export class PersistentImageUrlCache {
  private readonly storage: StorageLike | null;

  constructor(storage: StorageLike | null) {
    this.storage = storage;
  }

  get(storageKey: string): ImageUrlCacheEntry | null {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(storageKeyFor(storageKey));
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as Record<string, unknown>).url !== "string" ||
        typeof (parsed as Record<string, unknown>).expiresAt !== "number" ||
        typeof (parsed as Record<string, unknown>).identityId !== "string"
      ) {
        return null;
      }
      return parsed as ImageUrlCacheEntry;
    } catch {
      return null;
    }
  }

  set(storageKey: string, entry: ImageUrlCacheEntry): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(storageKeyFor(storageKey), JSON.stringify(entry));
    } catch {
      // Quota exceeded / storage disabled mid-session — the in-memory
      // cache still works for the rest of this tab session, just not
      // across a reload.
    }
  }

  /**
   * ログアウト/ユーザー切替時に必ず全件破棄する — identity scoping on
   * each entry already stops a *different* identity from reading a
   * previous one's entries, but sign-out/sign-in is exactly the moment
   * this cache must be emptied outright rather than merely become
   * unreadable, so it never keeps growing with dead accounts' entries
   * either. Storage has no prefix-delete primitive, so this scans once.
   */
  clearAll(): void {
    if (!this.storage) return;
    try {
      const toRemove: string[] = [];
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i);
        if (key && key.startsWith(STORAGE_PREFIX)) toRemove.push(key);
      }
      for (const key of toRemove) this.storage.removeItem(key);
    } catch {
      // best-effort — see class doc.
    }
  }
}
