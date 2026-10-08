import { mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { readGeneralPrivateCreateClaim, listGeneralPrivateCreateJobs } from
  "./generalPrivateCreateJob.mjs";

const INVENTORY = "2c53f36a-7a60-4e34-801d-8abc24f6cfc0";
const pathOf = root => join(root, "general-private-draft-recovery",
  `${INVENTORY}.json`);

async function validRecovery(root, claim) {
  try { const bytes = await readFile(pathOf(root));
    if (bytes.length > 1024) return false;
    const record = JSON.parse(bytes.toString("utf8"));
    return record?.schemaVersion === 1 &&
      record.inventoryId === INVENTORY &&
      record.formAttemptId === claim.attemptId &&
      record.action === "EXPLICIT_SCREEN_RECOVERY" &&
      Number.isFinite(Date.parse(record.recordedAt));
  } catch { return false; }
}

/** A form claim is an unresolved PC occupation until explicit recovery. */
export async function generalPrivateDraftOccupationActive(root) {
  if (typeof root !== "string" || !isAbsolute(root)) return true;
  const claim = await readGeneralPrivateCreateClaim(root, INVENTORY);
  if (!claim) return false;
  const jobs = await listGeneralPrivateCreateJobs(root);
  const job = jobs.find(item => item.inventoryId === INVENTORY);
  if (!job || job.attemptId !== claim.attemptId) return true;
  if (job.outcome === "PRIVATE_READBACK_CONFIRMED") return false;
  return !await validRecovery(root, claim);
}

/** Releases only the PC occupation; all one-shot claims remain intact. */
export async function recordGeneralPrivateDraftScreenRecovery(root) {
  if (typeof root !== "string" || !isAbsolute(root))
    throw Error("Invalid PC queue root");
  const claim = await readGeneralPrivateCreateClaim(root, INVENTORY);
  if (!claim) return false;
  if (await validRecovery(root, claim)) return true;
  const dir = join(root, "general-private-draft-recovery");
  await mkdir(dir, { recursive: true });
  const handle = await open(pathOf(root), "wx", 0o600);
  try { await handle.writeFile(JSON.stringify({ schemaVersion: 1,
    inventoryId: INVENTORY, formAttemptId: claim.attemptId,
    action: "EXPLICIT_SCREEN_RECOVERY",
    recordedAt: new Date().toISOString() }) + "\n", "utf8");
    await handle.sync(); }
  finally { await handle.close(); }
  return true;
}
