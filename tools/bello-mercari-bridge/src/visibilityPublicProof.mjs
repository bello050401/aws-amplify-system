import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { openVisibilityTransitionSession } from "./session.mjs";
import { readExactVisibilityFromList } from "./visibilityReadback.mjs";
import { exactVisibilityTarget } from "./visibilityTransitionOnce.mjs";

const MAX_AGE_MS = 120_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fixed = diagnostic => ({ status: "UNVERIFIED", diagnostic,
  allowStop: false });
const digest = target => createHash("sha256")
  .update(JSON.stringify(target)).digest("hex");
const proofDir = root => join(root, "visibility-public-proofs");

/** Only a fresh persisted read of the same product can expose STOP. */
export async function readCurrentPublicVisibilityProof(root, target,
  now = Date.now()) {
  if (typeof root !== "string" || !isAbsolute(root) ||
      !exactVisibilityTarget(target) || !Number.isFinite(now))
    return fixed("TARGET_UNVERIFIED");
  const prefix = `${target.shopId}-${target.remoteId}-`;
  let names;
  try { names = await readdir(proofDir(root)); }
  catch (error) { return error?.code === "ENOENT" ? fixed("PROOF_ABSENT") :
    fixed("PROOF_READ_UNAVAILABLE"); }
  const candidates = names.filter(name => name.startsWith(prefix));
  if (candidates.length > 100 || candidates.some(name =>
      !name.endsWith(".json") ||
      !UUID.test(name.slice(prefix.length, -".json".length))))
    return fixed("PROOF_DIRECTORY_UNVERIFIED");
  let latest = null;
  for (const name of candidates) {
    let record;
    try { const bytes = await readFile(join(proofDir(root), name));
      if (bytes.length > 2048) return fixed("PROOF_UNVERIFIED");
      record = JSON.parse(bytes.toString("utf8")); }
    catch { return fixed("PROOF_UNVERIFIED"); }
    const time = Date.parse(record?.observedAt);
    if (record?.schemaVersion !== 1 ||
        record.status !== "PUBLIC_CONFIRMED" ||
        record.shopId !== target.shopId ||
        record.inventoryId !== target.inventoryId ||
        record.remoteId !== target.remoteId ||
        record.title !== target.title ||
        record.targetFingerprint !== digest(target) ||
        record.visibility !== "PUBLIC" ||
        !Number.isFinite(time) || time > now ||
        !UUID.test(record.attemptId ?? ""))
      return fixed("PROOF_UNVERIFIED");
    if (!latest || time > latest.time)
      latest = { time, observedAt: record.observedAt };
  }
  if (!latest) return fixed("PROOF_ABSENT");
  if (now - latest.time > MAX_AGE_MS) return fixed("PROOF_EXPIRED");
  return { status: "PUBLIC_CONFIRMED", allowStop: true,
    shopId: target.shopId, remoteId: target.remoteId,
    observedAt: latest.observedAt };
}

/** Existing normal seller UI only; no edit, save, STOP or RELIST control. */
export async function capturePublicVisibilityProofReadOnly({ root, profileDir,
  playwrightModulePath, target }, {
    openSession = openVisibilityTransitionSession,
    readVisibility = readExactVisibilityFromList,
  } = {}) {
  if (![root, profileDir, playwrightModulePath].every(value =>
      typeof value === "string" && isAbsolute(value)) ||
      !exactVisibilityTarget(target)) return fixed("TARGET_UNVERIFIED");
  let session;
  try { session = await openSession({ root, profileDir,
    playwrightModulePath, shopId: target.shopId }); }
  catch { return fixed("BROWSER_UNAVAILABLE"); }
  try {
    const observed = await readVisibility(session.page, {
      shopId: target.shopId, remoteId: target.remoteId,
      title: target.title, visibility: "PUBLIC" });
    if (observed?.kind !== "OBSERVED" ||
        observed.shopId !== target.shopId ||
        observed.remoteId !== target.remoteId ||
        observed.title !== target.title ||
        observed.visibility !== "PUBLIC")
      return fixed("PUBLIC_PRODUCT_UNVERIFIED");
    const attemptId = randomUUID();
    const record = { schemaVersion: 1, status: "PUBLIC_CONFIRMED",
      shopId: target.shopId, inventoryId: target.inventoryId,
      remoteId: target.remoteId, title: target.title,
      targetFingerprint: digest(target), visibility: "PUBLIC",
      attemptId, observedAt: new Date().toISOString() };
    await mkdir(proofDir(root), { recursive: true });
    const path = join(proofDir(root),
      `${target.shopId}-${target.remoteId}-${attemptId}.json`);
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(record) + "\n", "utf8");
      await handle.sync(); }
    finally { await handle.close(); }
    return { status: "PUBLIC_CONFIRMED", allowStop: true,
      shopId: target.shopId, remoteId: target.remoteId,
      observedAt: record.observedAt };
  } catch { return fixed("PUBLIC_READ_UNAVAILABLE"); }
  finally { await session.context.close().catch(() => {}); }
}
