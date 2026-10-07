import { open, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { assertPinnedDirectReadTarget, readDirectReadProbeProof } from "./directReadProbe.mjs";

const HASH = /^[a-f0-9]{64}$/;
const REFERENCE = /^[A-Za-z0-9_-]{1,100}$/;

export async function savedDirectReadProofRecord(root, requestId, target) {
  if (!isAbsolute(root) || !HASH.test(requestId) || !REFERENCE.test(target?.shopId))
    throw Error("The saved direct read target is invalid");
  assertPinnedDirectReadTarget(target, requestId);
  const { attemptId } = await readDirectReadProbeProof(root, requestId, target);
  return { schemaVersion: 1, kind: "BELLO_PINNED_DIRECT_READ_PROOF",
    requestId, attemptId, accountReference: target.shopId,
    remoteId: target.remoteId, inventoryCode: target.inventoryCode,
    status: "DIRECT_HTTP_READ_CONFIRMED", reasonCode: "PINNED_HTTP_200_MATCHED",
    listingConfirmed: false };
}

/** Export only an already verified local receipt for upload in the signed-in BELLO tab. */
export async function exportSavedDirectReadProof({ configPath, outputPath }) {
  if (typeof configPath !== "string" || typeof outputPath !== "string" ||
      !isAbsolute(configPath) || !isAbsolute(outputPath))
    throw Error("Absolute configuration and output paths are required");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const target = config?.directReadTarget ?? config?.manualObservation;
  if (!HASH.test(config?.requestId) || !REFERENCE.test(target?.shopId))
    throw Error("The saved direct read target is invalid");
  assertPinnedDirectReadTarget(target, config.requestId);
  const localAppData = process.env.LOCALAPPDATA;
  const dataDir = config.dataDir ?? (localAppData && join(localAppData, "BELLO", "MercariBridge"));
  if (!dataDir || !isAbsolute(dataDir)) throw Error("The local proof directory is invalid");
  const exportRecord = await savedDirectReadProofRecord(join(dataDir, "Queue"),
    config.requestId, target);
  const handle = await open(outputPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(exportRecord) + "\n", "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  return { outputPath, requestId: config.requestId };
}
