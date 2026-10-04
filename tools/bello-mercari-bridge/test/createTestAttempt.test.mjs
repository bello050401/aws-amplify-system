import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CREATE_TEST_TARGET, claimCreateTestOnce, readCreateTestClaim,
  readCreateTestObservation, recordCreateTestObservation } from
  "../src/createTestAttempt.mjs";

const matched = remoteId => ({ status: "MATCHED", reason: "MATCHED",
  expectedKind: "CREATE_PRODUCT", observedKind: "CREATE_PRODUCT",
  newRemoteId: remoteId, operationName: "CreateProduct",
  httpStatus: 200, requestTargetMatch: "MATCH", responseTargetMatch: "MATCH" });

test("the exact B005757 private-create target is fixed and claimed once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bello-create-once-"));
  try {
    assert.equal(CREATE_TEST_TARGET.inventoryCode, "B005757");
    assert.equal(CREATE_TEST_TARGET.skuCode, "B005757-TEST-20261004");
    assert.equal(CREATE_TEST_TARGET.priceYen, 98000);
    assert.equal(CREATE_TEST_TARGET.existingRemoteId, "2JXdS6R5NNQPJadMexKmTr");
    assert.equal((await readCreateTestClaim(dir)).claimed, false);
    const claim = await claimCreateTestOnce(dir);
    assert.equal((await readCreateTestClaim(dir)).attemptId, claim.attemptId);
    await assert.rejects(claimCreateTestOnce(dir), { code: "EEXIST" });
    const result = await recordCreateTestObservation(dir, claim.attemptId,
      matched("newPrivateProduct"));
    assert.deepEqual(result, { outcome: "OBSERVED_PRIVATE_CREATE_RESPONSE",
      newRemoteId: "newPrivateProduct", listingConfirmed: false, reason: "MATCHED" });
    assert.equal((await readCreateTestObservation(dir)).result.newRemoteId,
      "newPrivateProduct");
    await assert.rejects(recordCreateTestObservation(dir, claim.attemptId,
      matched("anotherProduct")), { code: "EEXIST" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an old existing product response is unknown and cannot be retried", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bello-create-old-"));
  try {
    const claim = await claimCreateTestOnce(dir);
    const result = await recordCreateTestObservation(dir, claim.attemptId,
      matched(CREATE_TEST_TARGET.existingRemoteId));
    assert.equal(result.outcome, "UNVERIFIED");
    assert.equal(result.newRemoteId, null);
    assert.equal(result.listingConfirmed, false);
    assert.equal((await readCreateTestObservation(dir)).result.outcome, "UNVERIFIED");
    await assert.rejects(claimCreateTestOnce(dir), { code: "EEXIST" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
