import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const REFERENCE = /^[A-Za-z0-9_-]{1,100}$/;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i;
const FIELD_NAMES = new Set([
  "inventoryCode", "title", "description", "priceYen", "quantity", "categoryPath",
  "brand", "condition", "shippingMethod", "shippingPayer", "shippingOrigin",
  "shippingDays", "imageCount", "primaryImageIdentity",
]);
const RESULT_STATES = new Set([
  "CONNECTOR_NOT_CONFIGURED", "AUTH_REQUIRED", "UNKNOWN", "IDENTITY_MISMATCH",
  "NOT_PRIVATE", "DIFFERENT", "INCOMPLETE", "CORE_FIELDS_MATCH",
]);
const REASON_CODES = new Set(["NO_READER", "READ_FAILED", "SIGN_IN_REQUIRED", "UNVERIFIED_READ", "INVALID_OBSERVATION"]);
const FIELD_RESULTS = new Set(["MATCH", "DIFFERENT", "UNOBSERVED", "NO_BELLO_EXPECTATION"]);

async function writeExclusive(path, value) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value) + "\n", "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}

async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }

/** A root is bound to exactly one non-secret shop reference. No credentials live here. */
export async function bindAccount(root, accountReference) {
  if (!REFERENCE.test(accountReference)) throw Error("Invalid account reference");
  await mkdir(root, { recursive: true });
  const path = join(root, "account.json");
  try { await writeExclusive(path, { schemaVersion: 1, accountReference }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const bound = await readJson(path);
  if (bound.schemaVersion !== 1 || bound.accountReference !== accountReference)
    throw Error("This queue belongs to another account");
}

/** Queue contract: exact existing remote ID, immutable request, read-only operation. */
export async function enqueueExistingRead(root, { accountReference, inventoryCode, remoteId, expectedFields }) {
  await bindAccount(root, accountReference);
  if (!REFERENCE.test(inventoryCode) || !REFERENCE.test(remoteId)) throw Error("Invalid existing product identity");
  if (!expectedFields || typeof expectedFields !== "object" || Array.isArray(expectedFields))
    throw Error("Expected fields are required");
  for (const [key, value] of Object.entries(expectedFields)) {
    if (!FIELD_NAMES.has(key) || (typeof value !== "string" && typeof value !== "number") ||
        (typeof value === "number" && !Number.isFinite(value))) throw Error("Invalid expected field");
  }
  const job = { schemaVersion: 1, operation: "READ_EXISTING", jobId: randomUUID(),
    accountReference, inventoryCode, remoteId, expectedFields, createdAt: new Date().toISOString() };
  await mkdir(join(root, "jobs"), { recursive: true });
  await writeExclusive(join(root, "jobs", `${job.jobId}.json`), job);
  return job;
}

export async function readExistingJob(root, accountReference, jobId) {
  await bindAccount(root, accountReference);
  if (!JOB_ID.test(jobId)) throw Error("Invalid job ID");
  const job = await readJson(join(root, "jobs", `${jobId}.json`));
  if (job.schemaVersion !== 1 || job.operation !== "READ_EXISTING" ||
      job.jobId !== jobId || job.accountReference !== accountReference ||
      !REFERENCE.test(job.inventoryCode) || !REFERENCE.test(job.remoteId))
    throw Error("Invalid or mismatched read job");
  return job;
}

/** Manual one-job claim. A crashed lock stays closed until inspected; no automatic replay. */
export async function withReadLock(root, jobId, run) {
  if (!JOB_ID.test(jobId)) throw Error("Invalid job ID");
  await mkdir(join(root, "locks"), { recursive: true });
  const path = join(root, "locks", `${jobId}.lock`);
  const handle = await open(path, "wx", 0o600);
  try { return await run(); }
  finally { await handle.close(); await rm(path); }
}

/** Immutable, sanitized results; never store a page dump, cookie, token, or raw response. */
export async function saveReadResult(root, jobId, result) {
  if (!JOB_ID.test(jobId)) throw Error("Invalid job ID");
  if (!RESULT_STATES.has(result?.status) || !REFERENCE.test(result.accountReference) ||
      !REFERENCE.test(result.remoteId)) throw Error("Invalid read result");
  const job = await readExistingJob(root, result.accountReference, jobId);
  if (job.remoteId !== result.remoteId) throw Error("Read result does not match its queued product");
  const comparison = result.comparison ?? null;
  if (comparison !== null && (
    !FIELD_RESULTS.has(comparison.account) || !FIELD_RESULTS.has(comparison.remoteId) ||
    !["PRIVATE_OBSERVED", "NOT_PRIVATE", "UNOBSERVED"].includes(comparison.visibility) ||
    comparison.createAllowed !== false ||
    !comparison.fields || Object.keys(comparison.fields).some(key =>
      !FIELD_NAMES.has(key) || !FIELD_RESULTS.has(comparison.fields[key]))))
    throw Error("Invalid comparison result");
  const reasonCode = result.reasonCode ?? null;
  if (reasonCode !== null && !REASON_CODES.has(reasonCode)) throw Error("Invalid reason code");
  const safeComparison = comparison === null ? null : {
    account: comparison.account, remoteId: comparison.remoteId,
    visibility: comparison.visibility, createAllowed: false,
    fields: Object.fromEntries(Object.entries(comparison.fields)),
  };
  const directory = join(root, "results", jobId);
  await mkdir(directory, { recursive: true });
  const record = { schemaVersion: 1, jobId, attemptId: randomUUID(), recordedAt: new Date().toISOString(),
    status: result.status, accountReference: result.accountReference,
    remoteId: result.remoteId, comparison: safeComparison, reasonCode };
  await writeExclusive(join(directory, `${Date.now()}-${randomUUID()}.json`), record);
  return record;
}

export async function listReadResults(root, jobId) {
  if (!JOB_ID.test(jobId)) throw Error("Invalid job ID");
  const directory = join(root, "results", jobId);
  let files;
  try { files = await readdir(directory); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return Promise.all(files.filter(name => /^[0-9]+-[0-9a-f-]+\.json$/i.test(name)).sort()
    .map(name => readJson(join(directory, name))));
}
