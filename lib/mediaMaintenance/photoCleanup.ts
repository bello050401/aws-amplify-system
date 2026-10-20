import { ORPHAN_GRACE_MS } from "./core";
export interface DeletedPhoto {
  PK: string;
  SK: string;
  id: string;
  photoBatchId: string;
  isDeleted: boolean;
  status: string;
  listingSelectionCount: number;
  deletedAt?: string;
  purgeStartedAt?: string;
  purgedAt?: string;
  declaredProcessedMimeType: string;
  declaredThumbnailMimeType: string;
}
export interface PhotoCleanupPorts {
  listDeleted(): Promise<DeletedPhoto[]>;
  markDeletionObserved(photo: DeletedPhoto, now: string): Promise<void>;
  /** Atomically claims isDeleted=true, status=DELETED, refcount=0 and unchanged deletedAt. */
  claim(photo: DeletedPhoto, now: string): Promise<boolean>;
  /** Deletes all S3 versions and delete markers for the asset's two exact keys. */
  removeAllVersions(photo: DeletedPhoto): Promise<void>;
  finish(photo: DeletedPhoto, now: string): Promise<void>;
}
export async function purgeDeletedPhotos(
  ports: PhotoCleanupPorts,
  now = Date.now(),
) {
  const result = { observed: 0, purged: 0, kept: 0, failures: [] as string[] };
  for (const p of await ports.listDeleted()) {
    if (
      !p.isDeleted ||
      p.status !== "DELETED" ||
      p.listingSelectionCount !== 0 ||
      p.purgedAt
    ) {
      result.kept++;
      continue;
    }
    // Legacy deletions did not record a date: start a NEW full grace period.
    if (!p.deletedAt) {
      await ports.markDeletionObserved(p, new Date(now).toISOString());
      result.observed++;
      continue;
    }
    const deleted = Date.parse(p.deletedAt);
    if (!Number.isFinite(deleted) || deleted >= now - ORPHAN_GRACE_MS) {
      result.kept++;
      continue;
    }
    if (!(await ports.claim(p, new Date(now).toISOString()))) {
      result.kept++;
      continue;
    }
    try {
      await ports.removeAllVersions(p);
      await ports.finish(p, new Date(now).toISOString());
      result.purged++;
    } catch {
      result.failures.push(p.id);
    } // leave the durable purge claim for retry
  }
  return result;
}
