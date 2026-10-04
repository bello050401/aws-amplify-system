import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { claimManualSaveOnce, readManualSaveClaim, readManualSaveOutcome,
  writeManualSaveOutcome } from "../src/manualSaveAttempt.mjs";

const target = { shopId: "shop1", remoteId: "existing1", inventoryCode: "B005795",
  priceYen: 90000, quantity: 0 };

test("one durable claim survives restart and a concurrent second claimant", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-save-once-"));
  try {
    const results = await Promise.allSettled([
      claimManualSaveOnce(root, target), claimManualSaveOnce(root, target),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected" &&
      result.reason?.code === "EEXIST").length, 1);
    const claim = await readManualSaveClaim(root, target);
    assert.equal(claim.claimed, true);
    assert.equal(claim.valid, true);
    await writeManualSaveOutcome(root, target, claim.attemptId, "UNKNOWN");
    assert.equal(JSON.parse(await readFile(join(root, "manual-save-once",
      "shop1-existing1.result.json"), "utf8")).outcome, "UNKNOWN");
    assert.deepEqual(await readManualSaveOutcome(root, target),
      { outcome: "UNKNOWN", postflightPrivate: false });
    assert.equal((await readManualSaveClaim(root, target)).claimed, true);
    await assert.rejects(claimManualSaveOnce(root, target), { code: "EEXIST" });
  } finally {
    assert.equal(resolve(root).startsWith(resolve(tmpdir()) + "\\"), true);
    await rm(root, { recursive: true, force: true });
  }
});
