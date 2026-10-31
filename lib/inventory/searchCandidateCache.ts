import 'server-only';

// Server memory only. No images, credentials, or browser storage. Authorization
// remains mandatory on every request, before the caller reaches this cache.
const TTL_MS = 15_000;
const MAX_ENTRIES = 4;
const MAX_BYTES = 8 * 1024 * 1024;
type Entry = { at: number; bytes: number; value: Record<string, unknown>[] };
const entries = new Map<string, Entry>();
const pending = new Map<string, Promise<Record<string, unknown>[] | null>>();
let generation = 0;

export function invalidateSearchCandidates(): void {
  generation++;
  entries.clear();
  pending.clear();
}

/** Reuse only the small candidate projection; displayed rows are always reread. */
export async function readSearchCandidates(
  key: string,
  load: () => Promise<Record<string, unknown>[] | null>,
): Promise<Record<string, unknown>[] | null> {
  const now = Date.now();
  for (const [k, entry] of entries) if (now - entry.at >= TTL_MS) entries.delete(k);
  const hit = entries.get(key);
  if (hit) return hit.value;
  const running = pending.get(key);
  if (running) return running;
  const version = generation;
  const task = Promise.resolve().then(load).then(value => {
    if (value && version === generation && Date.now() - now < TTL_MS) {
      const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
      if (bytes <= MAX_BYTES) {
        let total = [...entries.values()].reduce((sum, e) => sum + e.bytes, 0);
        while (entries.size && (entries.size >= MAX_ENTRIES || total + bytes > MAX_BYTES)) {
          const oldest = entries.keys().next().value!;
          total -= entries.get(oldest)!.bytes;
          entries.delete(oldest);
        }
        entries.set(key, { at: now, bytes, value });
      }
    }
    return value;
  });
  // Do not retain an unbounded number of different concurrent filter requests.
  if (pending.size < MAX_ENTRIES) pending.set(key, task);
  try { return await task; }
  finally { if (pending.get(key) === task) pending.delete(key); }
}
