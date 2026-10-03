import { enqueueExistingRead } from "./queue.mjs";
import { runExistingRead } from "./readWorker.mjs";
import { createExistingProductReader } from "./existingProductReader.mjs";
import { openBelloAdminContext, validBelloOrigin } from "./belloSession.mjs";
import { isAbsolute } from "node:path";

const HASH = /^[a-f0-9]{64}$/;
const REFERENCE = /^[A-Za-z0-9_-]{1,100}$/;
const FIELDS = new Set(["title", "description", "priceYen", "quantity"]);

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

/** One explicitly requested existing-ID read. BELLO's authenticated browser cookie stays in its own profile. */
export async function runBelloCloudReadOnce({ origin, requestId, root, belloProfileDir,
  shopsProfileDir, playwrightModulePath, browserRead = false, launchBelloContext = openBelloAdminContext,
  runLocalRead = runExistingRead }) {
  if (!validBelloOrigin(origin) || !HASH.test(requestId) || !root || !isAbsolute(root) ||
      !belloProfileDir || !isAbsolute(belloProfileDir) ||
      (browserRead && (!shopsProfileDir || !isAbsolute(shopsProfileDir))))
    throw Error("Invalid BELLO read request configuration");
  const context = await launchBelloContext({ origin, profileDir: belloProfileDir, playwrightModulePath });
  try {
    const url = `${origin}/api/inventory/mercari-bridge/read?requestId=${requestId}`;
    const headers = { "x-bello-mercari-bridge": "READ_EXISTING" };
    const response = await context.request.get(url, { headers, failOnStatusCode: false,
      maxRedirects: 0 });
    if (!response.ok()) throw Error("BELLO ADMIN login or read-request ownership is required");
    let payload;
    try { payload = await response.json(); } catch { throw Error("BELLO did not return a read request"); }
    if (payload?.ok !== true || !validDispatch(payload.job, requestId))
      throw Error("BELLO returned an invalid existing-product read request");
    const dispatch = payload.job;
    const localJob = await enqueueExistingRead(root, { accountReference: dispatch.accountReference,
      inventoryCode: dispatch.inventoryCode, remoteId: dispatch.remoteId,
      expectedFields: dispatch.expectedFields });
    const reader = browserRead ? createExistingProductReader({ root,
      profileDir: shopsProfileDir, playwrightModulePath, shopId: dispatch.accountReference }) : null;
    const result = await runLocalRead(root, dispatch.accountReference, localJob.jobId, reader);
    const report = envelope(requestId, result);
    const posted = await context.request.post(url, { headers: { ...headers, Origin: origin,
      "Content-Type": "application/json" }, data: JSON.stringify(report), failOnStatusCode: false,
    maxRedirects: 0 });
    if (!posted.ok()) throw Error("BELLO did not accept the sanitized read result");
    let receipt;
    try { receipt = await posted.json(); } catch { throw Error("BELLO returned an invalid result receipt"); }
    if (receipt?.ok !== true || receipt.stored !== true || receipt.requestId !== requestId ||
        receipt.attemptId !== result.attemptId || receipt.readStatus !== result.status ||
        receipt.listingConfirmed !== false) throw Error("BELLO result receipt does not match the read attempt");
    return { requestId, attemptId: result.attemptId, status: result.status, listingConfirmed: false };
  } finally { await context.close(); }
}
