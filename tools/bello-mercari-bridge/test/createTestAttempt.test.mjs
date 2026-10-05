import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CREATE_TEST_TARGET, claimCreateTestOnce, readCreateTestClaim,
  readCreateTestPreflight,
  readCreateTestObservation, recordCreateTestObservation,
  recordCreateTestUiAttemptUnverified } from
  "../src/createTestAttempt.mjs";

const matched = remoteId => ({ status: "MATCHED", reason: "MATCHED",
  expectedKind: "CREATE_PRODUCT", observedKind: "CREATE_PRODUCT",
  newRemoteId: remoteId, operationName: "CreateProduct",
  httpStatus: 200, requestTargetMatch: "MATCH", responseTargetMatch: "MATCH" });

test("the exact B005757 private-create target is fixed and claimed once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bello-create-once-"));
  try {
    assert.equal(CREATE_TEST_TARGET.inventoryCode, "B005757");
    assert.equal(CREATE_TEST_TARGET.skuCode,
      "B005757-TEST-20261004-caf445ac6e676343");
    assert.equal(CREATE_TEST_TARGET.priceYen, 98000);
    assert.equal(CREATE_TEST_TARGET.existingRemoteId, "2JXdS6R5NNQPJadMexKmTr");
    assert.equal((await readCreateTestClaim(dir)).claimed, false);
    assert.equal((await readCreateTestPreflight(dir)).clear, true);
    const claim = await claimCreateTestOnce(dir);
    assert.equal((await readCreateTestPreflight(dir)).reason, "PRIOR_CREATE_ATTEMPT");
    assert.equal((await readCreateTestClaim(dir)).attemptId, claim.attemptId);
    await assert.rejects(claimCreateTestOnce(dir), /PRIOR_CREATE_ATTEMPT/);
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

test("GPT-tab UI attempt is recorded once as network-unobserved, never as a creation success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bello-create-ui-once-"));
  try {
    const claim = await claimCreateTestOnce(dir);
    assert.deepEqual(await recordCreateTestUiAttemptUnverified(dir, claim.attemptId), {
      outcome: "UNVERIFIED", newRemoteId: null, listingConfirmed: false,
      reason: "NETWORK_NOT_OBSERVED" });
    assert.deepEqual((await readCreateTestObservation(dir)).result, {
      outcome: "UNVERIFIED", newRemoteId: null, listingConfirmed: false,
      reason: "NETWORK_NOT_OBSERVED" });
    await assert.rejects(recordCreateTestUiAttemptUnverified(dir, claim.attemptId),
      { code: "EEXIST" });
    await assert.rejects(recordCreateTestObservation(dir, claim.attemptId,
      matched("anotherProduct")), { code: "EEXIST" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("all known local attempts are checked before a one-shop create claim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bello-create-ledger-"));
  try {
    const saveDir = join(dir, "manual-save-once");
    await mkdir(saveDir);
    await writeFile(join(saveDir, "old.json"), JSON.stringify({ schemaVersion: 1,
      operation: "NO_CHANGE_PRIVATE_SAVE_ONCE",
      attemptId: "a03e942f-4f6c-4c4d-b030-6eab0e341911",
      inventoryCode: "B005795" }));
    assert.deepEqual(await readCreateTestPreflight(dir), {
      clear: true, reason: "LOCAL_ATTEMPTS_CLEAR", checkedRecords: 1 });
    const createDir = join(dir, "private-create-test-once");
    await mkdir(createDir);
    await writeFile(join(createDir, "older-attempt.json"), "{}\n");
    assert.equal((await readCreateTestPreflight(dir)).reason, "PRIOR_CREATE_ATTEMPT");
    await assert.rejects(claimCreateTestOnce(dir), /PRIOR_CREATE_ATTEMPT/);
    await rm(createDir, { recursive: true });
    await writeFile(join(saveDir, "old.json"), "not json");
    assert.equal((await readCreateTestPreflight(dir)).reason, "LEDGER_UNVERIFIED");
    await assert.rejects(claimCreateTestOnce(dir), /LEDGER_UNVERIFIED/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a concurrent create claim permits only one new attempt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bello-create-race-"));
  try {
    const settled = await Promise.allSettled([
      claimCreateTestOnce(dir), claimCreateTestOnce(dir),
    ]);
    assert.equal(settled.filter(item => item.status === "fulfilled").length, 1);
    assert.equal(settled.filter(item => item.status === "rejected").length, 1);
    assert.equal((await readCreateTestClaim(dir)).claimed, true);
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
    await assert.rejects(claimCreateTestOnce(dir), /PRIOR_CREATE_ATTEMPT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
