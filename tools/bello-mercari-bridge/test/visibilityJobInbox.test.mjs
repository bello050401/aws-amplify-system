import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { enqueueVisibilityPcJob, listVisibilityPcJobs } from
  "../src/visibilityJobInbox.mjs";

const body = { schemaVersion: 1, action: "STOP",
  target: { shopId: "evkhihBFFNn5hukMS9s36H",
    inventoryId: "bd4850de-9156-4890-a821-cae75da5c8f7",
    remoteId: "ownedProduct123", title: "Exact owned product",
    skuCode: "B009999", priceYen: 45000, quantity: 1,
    visibilityPolicy: "PUBLIC_ALLOWED" },
  listing: { status: "ACTIVE", externalListingId: "ownedProduct123" } };
const job = { ...body,
  fingerprint: createHash("sha256").update(JSON.stringify(body)).digest("hex") };

test("BELLO job inbox is no-send, idempotent, and conflicts fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-visibility-inbox-"));
  try {
    const first = await enqueueVisibilityPcJob(root, job);
    assert.equal(first.status, "QUEUED_NO_SEND");
    assert.deepEqual(await enqueueVisibilityPcJob(root, job),
      { ...first, status: "ALREADY_QUEUED_NO_SEND" });
    const rows = await listVisibilityPcJobs(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].attempted, false);
    assert.equal(rows[0].job.target.remoteId, job.target.remoteId);
    const changed = { ...body, target: { ...body.target, priceYen: 50000 } };
    const conflicting = { ...changed,
      fingerprint: createHash("sha256").update(JSON.stringify(changed)).digest("hex") };
    await assert.rejects(enqueueVisibilityPcJob(root, conflicting), /conflict/);
    assert.equal((await listVisibilityPcJobs(root))[0].job.target.priceYen, 45000);
  } finally { await rm(root, { recursive: true, force: true }); }
});
