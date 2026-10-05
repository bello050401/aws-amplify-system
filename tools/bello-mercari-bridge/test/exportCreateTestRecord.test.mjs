import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claimCreateTestOnce, recordCreateTestUiAttemptUnverified } from
  "../src/createTestAttempt.mjs";
import { exportSavedCreateTestClaim, exportSavedCreateTestUiResult,
  savedCreateTestClaimRecord, savedCreateTestUiResultRecord } from
  "../src/exportCreateTestRecord.mjs";

test("one local create claim exports fixed target codes and an unverified UI result separately", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-private-create-export-"));
  try {
    await assert.rejects(savedCreateTestClaimRecord(root));
    await assert.rejects(savedCreateTestUiResultRecord(root));
    const claim = await claimCreateTestOnce(root);
    const exportedClaim = await savedCreateTestClaimRecord(root);
    assert.deepEqual(exportedClaim, { schemaVersion: 1, kind: "BELLO_PRIVATE_CREATE_CLAIM",
      attemptId: claim.attemptId, claimedAt: claim.claimedAt,
      inventoryId: "c9ee4ea7-070f-491c-bd4c-c1547cb73436",
      inventoryCode: "B005757", shopId: "evkhihBFFNn5hukMS9s36H",
      skuCode: "B005757-TEST-20261004-caf445ac6e676343",
      priceYen: 98000, listingConfirmed: false });
    await assert.rejects(savedCreateTestUiResultRecord(root));
    await recordCreateTestUiAttemptUnverified(root, claim.attemptId);
    const exportedResult = await savedCreateTestUiResultRecord(root);
    assert.deepEqual(exportedResult, { ...exportedClaim,
      kind: "BELLO_PRIVATE_CREATE_UI_ATTEMPT", outcome: "UNVERIFIED",
      reasonCode: "NETWORK_NOT_OBSERVED" });
    const path = join(root, "export.json");
    await exportSavedCreateTestUiResult(root, path);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), exportedResult);
    await assert.rejects(exportSavedCreateTestClaim(root, path),
      error => error.code === "EEXIST");
  } finally { await rm(root, { recursive: true, force: true }); }
});
