import { enqueueExistingRead, listReadResults, readExistingJob } from "./queue.mjs";
import { runExistingRead } from "./readWorker.mjs";
import { createExistingProductReader } from "./existingProductReader.mjs";
import { openBelloAdminContext, validBelloOrigin } from "./belloSession.mjs";
import { safeShopsTrafficSummary } from "./trafficObservation.mjs";
import { saveReadTrafficEvidence } from "./trafficEvidence.mjs";
import { isAbsolute } from "node:path";

const HASH = /^[a-f0-9]{64}$/;
const REFERENCE = /^[A-Za-z0-9_-]{1,100}$/;
const FIELDS = new Set(["title", "description", "priceYen", "quantity"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVER_CODES = new Set(["INVALID_RESULT", "IDENTITY_MISMATCH", "RESULT_CONFLICT", "STORAGE_UNAVAILABLE",
  "ORIGIN_MISMATCH", "CONTENT_TYPE_INVALID", "NEXT_ACTION_FORBIDDEN", "OWNER_REQUIRED"]);

export class BridgeBoundaryError extends Error {
  constructor(phase, httpStatus = null, serverCode = null) {
    super(`BELLO bridge ${phase}`);
    this.phase = phase;
    this.httpStatus = httpStatus;
    this.serverCode = serverCode;
  }
}

const httpStatusOf = response => {
  try { const value = response.status(); return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null; }
  catch { return null; }
};
async function serverCodeOf(response) {
  try {
    const payload = await response.json();
    return SERVER_CODES.has(payload?.code) ? payload.code : null;
  } catch { return null; }
}

function validDispatch(value, requestId) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.operation !== "READ_EXISTING" ||
      value.requestId !== requestId || !REFERENCE.test(value.accountReference) ||
      !REFERENCE.test(value.remoteId) || !REFERENCE.test(value.inventoryCode) ||
      !value.expectedFields || typeof value.expectedFields !== "object" ||
      Array.isArray(value.expectedFields) || Object.entries(value.expectedFields).some(([key, field]) =>
        !FIELDS.has(key) || (typeof field !== "string" &&
          !(typeof field === "number" && Number.isSafeInteger(field) && field >= 0)))) return false;
  return typeof value.expectedFields.title === "string" &&
    typeof value.expectedFields.description === "string" &&
    Number.isSafeInteger(value.expectedFields.quantity) && value.expectedFields.quantity >= 0;
}

function envelope(requestId, result) {
  return { requestId, attemptId: result.attemptId, accountReference: result.accountReference,
    remoteId: result.remoteId, status: result.status,
    comparison: result.comparison, reasonCode: result.reasonCode };
}

async function fetchOwnedDispatch(context, origin, requestId) {
  const url = `${origin}/api/inventory/mercari-bridge/read?requestId=${requestId}`;
  const headers = { "x-bello-mercari-bridge": "READ_EXISTING" };
  let response;
  try { response = await context.request.get(url, { headers, failOnStatusCode: false, maxRedirects: 0 }); }
  catch { throw new BridgeBoundaryError("REQUEST_GET_NETWORK"); }
  if (!response.ok()) throw new BridgeBoundaryError("REQUEST_GET_HTTP", httpStatusOf(response));
  let payload;
  try { payload = await response.json(); } catch { throw new BridgeBoundaryError("REQUEST_GET_JSON"); }
  if (payload?.ok !== true || !validDispatch(payload.job, requestId))
    throw new BridgeBoundaryError("REQUEST_GET_INVALID");
  return payload.job;
}

async function postReadResult(context, origin, requestId, result) {
  const url = `${origin}/api/inventory/mercari-bridge/read?requestId=${requestId}`;
  const report = envelope(requestId, result);
  let posted;
  try {
    posted = await context.request.post(url, { headers: { "x-bello-mercari-bridge": "READ_EXISTING",
      Origin: origin, "Content-Type": "application/json" }, data: JSON.stringify(report),
      failOnStatusCode: false, maxRedirects: 0 });
  } catch { throw new BridgeBoundaryError("RESULT_POST_NETWORK"); }
  if (!posted.ok()) throw new BridgeBoundaryError("RESULT_POST_HTTP", httpStatusOf(posted), await serverCodeOf(posted));
  let receipt;
  try { receipt = await posted.json(); } catch { throw new BridgeBoundaryError("RESULT_RECEIPT_JSON", httpStatusOf(posted)); }
  if (receipt?.ok !== true || receipt.stored !== true || receipt.requestId !== requestId ||
      receipt.attemptId !== result.attemptId || receipt.readStatus !== result.status ||
      receipt.listingConfirmed !== false)
    throw new BridgeBoundaryError("RESULT_RECEIPT_MISMATCH", httpStatusOf(posted));
  return { requestId, attemptId: result.attemptId, status: result.status, listingConfirmed: false };
}

function sameExpected(left, right) {
  if (!left || typeof left !== "object" || Array.isArray(left) ||
      !right || typeof right !== "object" || Array.isArray(right)) return false;
  const keys = Object.keys(left).sort();
  return keys.length === Object.keys(right).length &&
    keys.every(key => Object.hasOwn(right, key) && left[key] === right[key]);
}

/** Report one already saved attempt. This never opens Shops or creates another local read. */
export async function reportSavedReadResultOnce({ origin, requestId, root, belloProfileDir,
  playwrightModulePath, jobId, attemptId, launchBelloContext = openBelloAdminContext }) {
  if (!validBelloOrigin(origin) || !HASH.test(requestId) || !root || !isAbsolute(root) ||
      !belloProfileDir || !isAbsolute(belloProfileDir) || !UUID.test(jobId) || !UUID.test(attemptId))
    throw new BridgeBoundaryError("RECOVERY_CONFIG_INVALID");
  const context = await launchBelloContext({ origin, profileDir: belloProfileDir, playwrightModulePath });
  try {
    const dispatch = await fetchOwnedDispatch(context, origin, requestId);
    let job;
    let result;
    try {
      job = await readExistingJob(root, dispatch.accountReference, jobId);
      const matches = (await listReadResults(root, jobId)).filter(item => item.attemptId === attemptId);
      if (matches.length !== 1) throw Error("saved attempt missing or ambiguous");
      result = matches[0];
    } catch { throw new BridgeBoundaryError("SAVED_RESULT_MISSING"); }
    if (job.accountReference !== dispatch.accountReference || job.remoteId !== dispatch.remoteId ||
        job.inventoryCode !== dispatch.inventoryCode || !sameExpected(job.expectedFields, dispatch.expectedFields) ||
        result.jobId !== jobId || result.accountReference !== dispatch.accountReference ||
        result.remoteId !== dispatch.remoteId)
      throw new BridgeBoundaryError("SAVED_RESULT_MISMATCH");
    return await postReadResult(context, origin, requestId, result);
  } finally { await context.close(); }
}

/** One explicitly requested existing-ID read. BELLO's authenticated browser cookie stays in its own profile. */
export async function runBelloCloudReadOnce({ origin, requestId, root, belloProfileDir,
  shopsProfileDir, playwrightModulePath, browserRead = false, launchBelloContext = openBelloAdminContext,
  runLocalRead = runExistingRead, onShopsTraffic = null, onReadDiagnostics = null,
  onTrafficEvidenceStatus = null }) {
  if (!validBelloOrigin(origin) || !HASH.test(requestId) || !root || !isAbsolute(root) ||
      !belloProfileDir || !isAbsolute(belloProfileDir) ||
      (browserRead && (!shopsProfileDir || !isAbsolute(shopsProfileDir))))
    throw Error("Invalid BELLO read request configuration");
  const context = await launchBelloContext({ origin, profileDir: belloProfileDir, playwrightModulePath });
  try {
    const dispatch = await fetchOwnedDispatch(context, origin, requestId);
    const localJob = await enqueueExistingRead(root, { accountReference: dispatch.accountReference,
      inventoryCode: dispatch.inventoryCode, remoteId: dispatch.remoteId,
      expectedFields: dispatch.expectedFields });
    let trafficSnapshot = null;
    const reader = browserRead ? createExistingProductReader({ root,
      profileDir: shopsProfileDir, playwrightModulePath, shopId: dispatch.accountReference,
      onTrafficSummary: items => {
        trafficSnapshot = safeShopsTrafficSummary(items);
        try { onShopsTraffic?.(trafficSnapshot); } catch { /* Display cannot alter a read. */ }
      }, onReadDiagnostics }) : null;
    let result;
    try { result = await runLocalRead(root, dispatch.accountReference, localJob.jobId, reader); }
    finally {
      if (browserRead) {
        let status;
        let observedAt = null;
        try {
          const evidence = await saveReadTrafficEvidence(root, requestId, localJob.jobId,
            trafficSnapshot);
          status = evidence.status;
          observedAt = evidence.observedAt;
        } catch { status = "STORE_FAILED"; }
        try { onTrafficEvidenceStatus?.(status, observedAt); }
        catch { /* Evidence UI cannot alter a read. */ }
      }
    }
    return await postReadResult(context, origin, requestId, result);
  } finally { await context.close(); }
}
