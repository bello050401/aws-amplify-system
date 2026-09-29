import { createHash } from "node:crypto";
import type { PhotoCacheOperation, PhotoCacheTelemetry } from "./photoObservationTelemetry";

export type ObservationStore = {
  read(key: string, operation?: PhotoCacheOperation | null): Promise<string[] | null>;
  write(key: string, observations: string[], operation?: PhotoCacheOperation | null): Promise<void>;
};

export function photoObservationKey(jpeg: Uint8Array, modelId: string, promptVersion: string): string {
  const digest = createHash("sha256").update(jpeg).digest("hex");
  return `photo-observation:v1:${createHash("sha256").update(`${modelId}|${promptVersion}|${digest}`).digest("hex")}`;
}

/** A valid empty observation is reusable; an unavailable observation is null. */
export function createPhotoObservationReuse(
  store: ObservationStore,
  observe: (jpeg: Uint8Array, operation?: PhotoCacheOperation | null) => Promise<string[] | null>,
  telemetry?: PhotoCacheTelemetry,
) {
  const remembered = new Map<string, string[]>();
  type PendingResult = { observations: string[]; completed: boolean };
  const pending = new Map<string, Promise<PendingResult>>();
  return async (jpeg: Uint8Array, modelId: string, promptVersion: string): Promise<string[]> => {
    const operation = telemetry?.start();
    if (jpeg.byteLength === 0 || jpeg.byteLength > 5_000_000) {
      operation?.finish("none", "failed");
      return [];
    }
    const key = photoObservationKey(jpeg, modelId, promptVersion);
    const hit = remembered.get(key);
    if (hit) {
      operation?.finish("memory", "completed");
      return hit;
    }
    const running = pending.get(key);
    if (running) {
      try {
        const result = await running;
        operation?.finish("inflight", result.completed ? "completed" : "failed");
        return result.observations;
      } catch (error) {
        operation?.finish("inflight", "failed");
        throw error;
      }
    }
    const work = (async () => {
      try {
        const stored = await store.read(key, operation);
        if (stored !== null) {
          operation?.markRead("hit");
          remember(key, stored);
          operation?.finish("persistent", "completed");
          return { observations: stored, completed: true };
        }
        operation?.markRead("miss");
      } catch {
        operation?.markRead("error");
        // Cache outages must not block observation.
      }
      let result: string[] | null;
      try { result = await observe(jpeg, operation); }
      catch {
        operation?.finish("none", "failed");
        return { observations: [], completed: false };
      }
      if (result === null) {
        operation?.finish("none", "failed");
        return { observations: [], completed: false };
      }
      remember(key, result);
      try {
        await store.write(key, result, operation);
        operation?.markWrite("success");
      } catch {
        operation?.markWrite("error");
        // Best effort cache.
      }
      operation?.finish("vision", "completed");
      return { observations: result, completed: true };
    })();
    pending.set(key, work);
    try { return (await work).observations; } finally { pending.delete(key); }
  };

  function remember(key: string, value: string[]): void {
    remembered.delete(key);
    remembered.set(key, value);
    if (remembered.size > 100) remembered.delete(remembered.keys().next().value!);
  }
}
