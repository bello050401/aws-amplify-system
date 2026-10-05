import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { CREATE_TEST_TARGET, readCreateTestClaim,
  readCreateTestObservation, validCreateTestClaimedAt } from "./createTestAttempt.mjs";

function claimRecord(claim) {
  if (!claim.claimed || !claim.valid || !claim.attemptId ||
      !validCreateTestClaimedAt(claim.claimedAt))
    throw Error("The pinned private-create claim is unavailable");
  return { schemaVersion: 1, kind: "BELLO_PRIVATE_CREATE_CLAIM",
    attemptId: claim.attemptId, claimedAt: claim.claimedAt,
    inventoryId: CREATE_TEST_TARGET.sourceInventoryId,
    inventoryCode: CREATE_TEST_TARGET.inventoryCode,
    shopId: CREATE_TEST_TARGET.shopId, skuCode: CREATE_TEST_TARGET.skuCode,
    priceYen: CREATE_TEST_TARGET.priceYen, listingConfirmed: false };
}

export async function savedCreateTestClaimRecord(root) {
  if (typeof root !== "string" || !isAbsolute(root)) throw Error("Absolute queue root required");
  return claimRecord(await readCreateTestClaim(root));
}

export async function savedCreateTestUiResultRecord(root) {
  if (typeof root !== "string" || !isAbsolute(root)) throw Error("Absolute queue root required");
  const { claim, result } = await readCreateTestObservation(root);
  const base = claimRecord(claim);
  if (result?.outcome !== "UNVERIFIED" ||
      result.reason !== "NETWORK_NOT_OBSERVED" || result.newRemoteId !== null ||
      result.listingConfirmed !== false)
    throw Error("The GPT-tab UI attempt result is unavailable");
  return { ...base, kind: "BELLO_PRIVATE_CREATE_UI_ATTEMPT",
    outcome: "UNVERIFIED", reasonCode: "NETWORK_NOT_OBSERVED" };
}

async function exportCreateTestRecord(record, outputPath) {
  if (typeof outputPath !== "string" || !isAbsolute(outputPath))
    throw Error("Absolute output path required");
  const handle = await open(outputPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(record) + "\n", "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  return outputPath;
}

export async function exportSavedCreateTestClaim(root, outputPath) {
  return exportCreateTestRecord(await savedCreateTestClaimRecord(root), outputPath);
}

export async function exportSavedCreateTestUiResult(root, outputPath) {
  return exportCreateTestRecord(await savedCreateTestUiResultRecord(root), outputPath);
}
