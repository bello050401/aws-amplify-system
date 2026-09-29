import { createHash } from "node:crypto";

export type ObservationStore = {
  read(key: string): Promise<string[] | null>;
  write(key: string, observations: string[]): Promise<void>;
};

export function photoObservationKey(jpeg: Uint8Array, modelId: string, promptVersion: string): string {
  const digest = createHash("sha256").update(jpeg).digest("hex");
  return `photo-observation:v1:${createHash("sha256").update(`${modelId}|${promptVersion}|${digest}`).digest("hex")}`;
}

/** A valid empty observation is reusable; an unavailable observation is null. */
export function createPhotoObservationReuse(store: ObservationStore, observe: (jpeg: Uint8Array) => Promise<string[] | null>) {
  const remembered = new Map<string, string[]>();
  const pending = new Map<string, Promise<string[]>>();
  return async (jpeg: Uint8Array, modelId: string, promptVersion: string): Promise<string[]> => {
    if (jpeg.byteLength === 0 || jpeg.byteLength > 5_000_000) return [];
    const key = photoObservationKey(jpeg, modelId, promptVersion);
    const hit = remembered.get(key);
    if (hit) return hit;
    const running = pending.get(key);
    if (running) return running;
    const work = (async () => {
      try {
        const stored = await store.read(key);
        if (stored) {
          remember(key, stored);
          return stored;
        }
      } catch { /* Cache outages must not block observation. */ }
      let result: string[] | null;
      try { result = await observe(jpeg); } catch { return []; }
      if (result === null) return [];
      remember(key, result);
      try { await store.write(key, result); } catch { /* Best effort cache. */ }
      return result;
    })();
    pending.set(key, work);
    try { return await work; } finally { pending.delete(key); }
  };

  function remember(key: string, value: string[]): void {
    remembered.delete(key);
    remembered.set(key, value);
    if (remembered.size > 100) remembered.delete(remembered.keys().next().value!);
  }
}
