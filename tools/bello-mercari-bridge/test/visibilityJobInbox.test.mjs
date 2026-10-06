import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("saved verification must belong to the exact claimed target and attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-visibility-result-"));
  try {
    await enqueueVisibilityPcJob(root, job);
    const dir = join(root, "visibility-transition-once");
    await mkdir(dir);
    const stem = `${job.target.shopId}-${job.target.remoteId}-${job.action}`;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(job.target)).digest("hex");
    const attemptId = "9f84d8ec-25af-4489-8180-47f2de5a113c";
    const claim = { schemaVersion: 1, action: job.action,
      shopId: job.target.shopId, inventoryId: job.target.inventoryId,
      remoteId: job.target.remoteId, targetFingerprint: fingerprint,
      attemptId, outcome: "UNKNOWN" };
    const result = { ...claim, title: job.target.title,
      outcome: "STOP_VERIFIED", observedVisibility: "PRIVATE" };
    const claimPath = join(dir, `${stem}.claim.json`);
    const resultPath = join(dir, `${stem}.result.json`);
    await writeFile(claimPath, JSON.stringify(claim));
    await writeFile(resultPath, JSON.stringify(result));
    assert.equal((await listVisibilityPcJobs(root))[0].outcome, "STOP_VERIFIED");
    await writeFile(resultPath, JSON.stringify({ ...result,
      attemptId: "4aa2ed43-5d21-4350-9fe9-2f89d21c0c7f" }));
    assert.equal((await listVisibilityPcJobs(root))[0].outcome, "UNKNOWN");
    await writeFile(resultPath, JSON.stringify({ ...result,
      observedVisibility: "PUBLIC" }));
    assert.equal((await listVisibilityPcJobs(root))[0].outcome, "UNKNOWN");
    for (const changed of [
      { inventoryId: "a18e56af-423d-496d-b82b-a2732fa9a267" },
      { shopId: "anotherShop" }, { action: "RELIST" },
      { remoteId: "anotherProduct" },
    ]) {
      await writeFile(resultPath, JSON.stringify({ ...result, ...changed }));
      assert.equal((await listVisibilityPcJobs(root))[0].outcome, "UNKNOWN");
    }
    await writeFile(resultPath, JSON.stringify(result));
    await writeFile(claimPath, JSON.stringify({ ...claim,
      inventoryId: "a18e56af-423d-496d-b82b-a2732fa9a267" }));
    assert.equal((await listVisibilityPcJobs(root))[0].outcome, "UNKNOWN");
    await writeFile(claimPath, JSON.stringify({ ...claim,
      targetFingerprint: "0".repeat(64) }));
    assert.equal((await listVisibilityPcJobs(root))[0].outcome, "UNKNOWN");
  } finally { await rm(root, { recursive: true, force: true }); }
});
