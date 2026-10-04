import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { safeShopsTrafficSummary } from "./trafficObservation.mjs";
import { safeReadQueryCandidates } from "./readQueryObservation.mjs";

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(["OBSERVED", "EMPTY", "NOT_CAPTURED"]);

function evidenceDir(root, requestId) {
  if (!isAbsolute(root) || !HASH.test(requestId))
    throw Error("Invalid read-only traffic evidence target");
  return join(root, "shops-traffic-evidence", requestId);
}

function view(status, entries = [], readQueries = [], observedAt = null) {
  // The metadata deliberately has no endpoint values, GraphQL document, variables,
  // credentials or response body. It can never authorize direct HTTP traffic.
  return { status, entries, readQueries, observedAt, directHttpAllowed: false };
}

/** Append only: a later empty observation does not erase an earlier one. */
export async function saveReadTrafficEvidence(root, requestId, jobId, items, queryCandidates = []) {
  if (!UUID.test(jobId) || (items !== null && !Array.isArray(items)) ||
      !Array.isArray(queryCandidates))
    throw Error("Invalid read-only traffic evidence");
  const dir = evidenceDir(root, requestId);
  const entries = items === null ? [] : safeShopsTrafficSummary(items);
  const readQueries = items === null ? [] : safeReadQueryCandidates(queryCandidates);
  const status = items === null ? "NOT_CAPTURED" :
    entries.length || readQueries.length ? "OBSERVED" : "EMPTY";
  const observedAt = new Date().toISOString();
  const filename = `${Date.now()}-${randomUUID()}.json`;
  await mkdir(dir, { recursive: true });
  const handle = await open(join(dir, filename), "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ schemaVersion: 2, requestId, jobId,
      status, observedAt, entries, readQueries }) + "\n", "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  return view(status, entries, readQueries, observedAt);
}

/** A missing file means old memory-only observations cannot be reconstructed. */
export async function latestReadTrafficEvidence(root, requestId) {
  const dir = evidenceDir(root, requestId);
  let names;
  try { names = await readdir(dir); }
  catch (error) {
    return view(error?.code === "ENOENT" ? "LEGACY_NOT_PERSISTED" : "READ_FAILED");
  }
  const name = names.filter(item => /^[0-9]{13}-[0-9a-f-]{36}\.json$/i.test(item)).sort().at(-1);
  if (!name) return view("LEGACY_NOT_PERSISTED");
  try {
    const record = JSON.parse(await readFile(join(dir, name), "utf8"));
    const entries = safeShopsTrafficSummary(record?.entries);
    const oldSchema = record?.schemaVersion === 1;
    const readQueries = oldSchema ? [] : safeReadQueryCandidates(record?.readQueries);
    if ((!oldSchema && record?.schemaVersion !== 2) || record.requestId !== requestId ||
        !UUID.test(record.jobId ?? "") || !STATUSES.has(record.status) ||
        typeof record.observedAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.observedAt) ||
        !Array.isArray(record.entries) || entries.length !== record.entries.length ||
        (oldSchema && record.readQueries !== undefined) ||
        (!oldSchema && (!Array.isArray(record.readQueries) ||
          readQueries.length !== record.readQueries.length)) ||
        (record.status === "OBSERVED") !== (entries.length + readQueries.length > 0) ||
        (record.status === "NOT_CAPTURED" && entries.length + readQueries.length !== 0))
      return view("INVALID_RECORD");
    return view(record.status, entries, readQueries, record.observedAt);
  } catch { return view("READ_FAILED"); }
}
