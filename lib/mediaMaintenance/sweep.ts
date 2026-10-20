import {
  collectReferencedKeys,
  orphanAction,
  type StoredImage,
  type OrphanObservation,
} from "./core";

export interface SweepPorts {
  readReferences(): Promise<unknown[]>;
  listObjects(): Promise<StoredImage[]>;
  listObservations(): Promise<OrphanObservation[]>;
  observe(
    object: StoredImage,
    previous: OrphanObservation | undefined,
    now: string,
  ): Promise<void>;
  forget(observation: OrphanObservation): Promise<void>;
  /** Conditional delete: the object's ETag must still match. */
  remove(object: StoredImage): Promise<void>;
}
export async function sweepUnusedImages(
  ports: SweepPorts,
  now = Date.now(),
  limit = 250,
) {
  const references = collectReferencedKeys(await ports.readReferences());
  const objects = await ports.listObjects();
  const observations = await ports.listObservations();
  const previous = new Map(observations.map((x) => [x.id, x]));
  const seen = new Set(objects.map((o) => o.key));
  const due: StoredImage[] = [];
  const result = {
    observed: 0,
    deleted: 0,
    deletedBytes: 0,
    kept: 0,
    failures: [] as string[],
  };
  for (const object of objects) {
    const old = previous.get(object.key);
    switch (orphanAction(object, references, old, now)) {
      case "KEEP":
        result.kept++;
        if (old) await ports.forget(old);
        break;
      case "OBSERVE":
        if (!old || old.etag !== object.etag || !Number.isFinite(Date.parse(old.firstSeenAt)))
          await ports.observe(object, old, new Date(now).toISOString());
        result.observed++;
        break;
      case "DELETE":
        due.push(object);
        break;
    }
  }
  // Refresh all references immediately before a bounded deletion batch. An
  // interrupted upload or a newly saved draft must cancel its deletion timer.
  if (due.length) {
    const fresh = collectReferencedKeys(await ports.readReferences());
    for (const object of due.slice(0, limit)) {
      const old = previous.get(object.key)!;
      if (fresh.has(object.key)) {
        await ports.forget(old);
        result.kept++;
        continue;
      }
      try {
        await ports.remove(object);
        await ports.forget(old);
        result.deleted++;
        result.deletedBytes += object.size;
      } catch {
        result.failures.push(object.key);
      } // retain observation: next run retries
    }
  }
  for (const old of observations)
    if (!seen.has(old.id)) await ports.forget(old);
  return result;
}
