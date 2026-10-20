import assert from "node:assert/strict";
import {
  collectReferencedKeys,
  isManagedInventoryImage,
  orphanAction,
  ORPHAN_GRACE_MS,
  liveMediaReferenceRows,
  type StoredImage,
  type OrphanObservation,
} from "../lib/mediaMaintenance/core";
import {
  sweepUnusedImages,
  type SweepPorts,
} from "../lib/mediaMaintenance/sweep";
import {
  purgeDeletedPhotos,
  type DeletedPhoto,
  type PhotoCleanupPorts,
} from "../lib/mediaMaintenance/photoCleanup";

const key = "inventory/00000000-0000-4000-8000-000000000001.jpg";
const now = Date.parse("2026-10-20T00:00:00Z");
const obj: StoredImage = {
  key,
  etag: '"same"',
  modifiedAt: "2026-08-01T00:00:00Z",
  size: 321,
};
const old: OrphanObservation = {
  id: key,
  etag: obj.etag,
  firstSeenAt: "2026-10-01T00:00:00Z",
};
let checks = 0;
function test(name: string, fn: () => unknown) {
  fn();
  checks++;
  console.log("PASS " + name);
}
test("image keys are strictly scoped", () => {
  assert(isManagedInventoryImage(key));
  for (const k of [
    "knowledge/doc.pdf",
    "inventory/private.txt",
    "inventory/../key.jpg",
    "photo-batches/x.jpg",
  ])
    assert(!isManagedInventoryImage(k));
});
test("nested JSON, signed URL, encoded URL and HTML remain live", () => {
  for (const value of [
    { images: [{ storageKey: key }] },
    JSON.stringify({ images: [{ storageKey: key }] }),
    "https://bucket/" + key + "?X-Amz-Signature=redacted",
    `<img src="https://bucket/${encodeURIComponent(key)}">`,
  ])
    assert(collectReferencedKeys(value).has(key));
});
test("live image never expires", () =>
  assert.equal(orphanAction(obj, new Set([key]), old, now), "KEEP"));
test("first observation never deletes even an old upload", () =>
  assert.equal(orphanAction(obj, new Set(), undefined, now), "OBSERVE"));
test("seven day boundary is retained", () =>
  assert.equal(
    orphanAction(
      obj,
      new Set(),
      { ...old, firstSeenAt: new Date(now - ORPHAN_GRACE_MS).toISOString() },
      now,
    ),
    "OBSERVE",
  ));
test("changed bytes restart observation", () =>
  assert.equal(
    orphanAction({ ...obj, etag: "changed" }, new Set(), old, now),
    "OBSERVE",
  ));
test("recent upload and invalid dates are retained", () => {
  assert.equal(
    orphanAction(
      { ...obj, modifiedAt: new Date(now).toISOString() },
      new Set(),
      old,
      now,
    ),
    "KEEP",
  );
  assert.equal(
    orphanAction({ ...obj, modifiedAt: "invalid" }, new Set(), old, now),
    "KEEP",
  );
});
test("only old unreferenced images become eligible", () =>
  assert.equal(orphanAction(obj, new Set(), old, now), "DELETE"));
function fixture() {
  const removed: string[] = [],
    forgot: string[] = [],
    observed: string[] = [];
  let calls = 0;
  const ports: SweepPorts = {
    readReferences: async () => {
      calls++;
      return [];
    },
    listObjects: async () => [obj],
    listObservations: async () => [old],
    observe: async (o) => {
      observed.push(o.key);
    },
    forget: async (o) => {
      forgot.push(o.id);
    },
    remove: async (o) => {
      removed.push(o.key);
    },
  };
  return { ports, removed, forgot, observed, calls: () => calls };
}
async function main() {
  test("deleted inventory processing rows cannot keep files forever", () => {
    const live = { inventoryId: "live", imageStorageKey: key, webKey: key };
    const removed = {
      inventoryId: "removed",
      imageStorageKey: key,
      webKey: key,
    };
    const rows = liveMediaReferenceRows({
      Inventory: [
        { id: "live", images: JSON.stringify([{ storageKey: key }]) },
      ],
      ProcessingJob: [live, removed],
      ImageProcessingVersion: [live, removed],
      ListingDraft: [{ inventoryId: "removed", imageKeys: [key] }],
    });
    assert.equal(rows.length, 4);
    assert(!rows.includes(removed));
    assert(collectReferencedKeys(rows).has(key));
  });
  {
    const x = fixture();
    const r = await sweepUnusedImages(x.ports, now);
    assert.equal(r.deleted, 1);
    assert.equal(r.deletedBytes, 321);
    assert.equal(x.calls(), 2);
    assert.deepEqual(x.forgot, [key]);
    checks++;
  }
  {
    const x = fixture();
    x.ports.readReferences = async () => {
      throw Error("table unreadable");
    };
    await assert.rejects(() => sweepUnusedImages(x.ports, now));
    assert.equal(x.removed.length, 0);
    checks++;
  }
  {
    const x = fixture();
    let n = 0;
    x.ports.readReferences = async () =>
      ++n === 1 ? [] : [{ images: [{ storageKey: key }] }];
    await sweepUnusedImages(x.ports, now);
    assert.equal(x.removed.length, 0);
    assert.deepEqual(x.forgot, [key]);
    checks++;
  }
  {
    const x = fixture();
    x.ports.remove = async () => {
      throw Error("S3 unavailable");
    };
    const r = await sweepUnusedImages(x.ports, now);
    assert.deepEqual(r.failures, [key]);
    assert.equal(x.forgot.length, 0);
    checks++;
  }
  {
    const x = fixture();
    x.ports.listObservations = async () => [];
    await sweepUnusedImages(x.ports, now);
    assert.equal(x.removed.length, 0);
    assert.deepEqual(x.observed, [key]);
    checks++;
  }
  {
    const x = fixture();
    await sweepUnusedImages(x.ports, now, 0);
    assert.equal(x.removed.length, 0);
    assert.equal(x.forgot.length, 0);
    checks++;
  }
  {
    const x = fixture();
    x.ports.listObservations = async () => [{ ...old, firstSeenAt: "invalid" }];
    await sweepUnusedImages(x.ports, now);
    assert.equal(x.removed.length, 0);
    assert.deepEqual(x.observed, [key]);
    checks++;
  }
  const photo: DeletedPhoto = {
    PK: "batch",
    SK: "photo",
    id: "photo",
    photoBatchId: "batch",
    isDeleted: true,
    status: "DELETED",
    listingSelectionCount: 0,
    deletedAt: old.firstSeenAt,
    declaredProcessedMimeType: "image/jpeg",
    declaredThumbnailMimeType: "image/jpeg",
  };
  function photoFixture(row: DeletedPhoto) {
    const actions: string[] = [];
    const ports: PhotoCleanupPorts = {
      listDeleted: async () => [row],
      markDeletionObserved: async () => {
        actions.push("observe");
      },
      claim: async () => {
        actions.push("claim");
        return true;
      },
      removeAllVersions: async () => {
        actions.push("remove");
      },
      finish: async () => {
        actions.push("finish");
      },
    };
    return { ports, actions };
  }
  {
    const x = photoFixture({ ...photo, deletedAt: undefined });
    const r = await purgeDeletedPhotos(x.ports, now);
    assert.equal(r.observed, 1);
    assert.deepEqual(x.actions, ["observe"]);
    checks++;
  }
  {
    const x = photoFixture({
      ...photo,
      deletedAt: new Date(now - ORPHAN_GRACE_MS).toISOString(),
    });
    await purgeDeletedPhotos(x.ports, now);
    assert.deepEqual(x.actions, []);
    checks++;
  }
  {
    const x = photoFixture({ ...photo, listingSelectionCount: 1 });
    await purgeDeletedPhotos(x.ports, now);
    assert.deepEqual(x.actions, []);
    checks++;
  }
  {
    const x = photoFixture(photo);
    x.ports.claim = async () => false;
    const r = await purgeDeletedPhotos(x.ports, now);
    assert.equal(r.purged, 0);
    assert.deepEqual(x.actions, []);
    checks++;
  }
  {
    const x = photoFixture(photo);
    x.ports.removeAllVersions = async () => {
      throw Error("S3 unavailable");
    };
    const r = await purgeDeletedPhotos(x.ports, now);
    assert.deepEqual(r.failures, [photo.id]);
    assert(!x.actions.includes("finish"));
    checks++;
  }
  {
    const x = photoFixture({ ...photo, purgeStartedAt: old.firstSeenAt });
    const r = await purgeDeletedPhotos(x.ports, now);
    assert.equal(r.purged, 1);
    assert.deepEqual(x.actions, ["claim", "remove", "finish"]);
    checks++;
  }
  {
    const x = photoFixture({ ...photo, purgedAt: old.firstSeenAt });
    await purgeDeletedPhotos(x.ports, now);
    assert.deepEqual(x.actions, []);
    checks++;
  }
  console.log(`PASS ${checks} media lifecycle checks`);
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
