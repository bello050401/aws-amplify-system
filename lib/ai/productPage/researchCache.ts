/** Process-local reuse; never stores credentials or customer data. */
export function createResearchCache<T>(now = Date.now) {
  const entries = new Map<string, { expires: number; value: T }>();
  const pending = new Map<string, Promise<T>>();
  return (key: string, load: () => Promise<T>, fallback: T): Promise<T> => {
    const hit = entries.get(key);
    if (hit && hit.expires > now()) return Promise.resolve(hit.value);
    const running = pending.get(key);
    if (running) return running;
    // Bound both stored entries and concurrent distinct searches.
    if (pending.size >= 100) return Promise.resolve(fallback);
    const operation = Promise.resolve().then(load).then(
      value => ({ value, ttl: 30 * 60_000 }),
      () => ({ value: fallback, ttl: 60_000 }),
    ).then(({ value, ttl }) => {
      if (entries.size >= 100) entries.delete(entries.keys().next().value!);
      entries.set(key, { value, expires: now() + ttl });
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
  };
}
