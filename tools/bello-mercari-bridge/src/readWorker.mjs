import { reconcileExistingMercariProduct } from "../../../lib/listing/mercariDirectProbe/reconcileExisting.ts";
import { readExistingJob, saveReadResult, withReadLock } from "./queue.mjs";

const CORE_FIELDS = ["inventoryCode", "title", "description", "priceYen", "quantity", "primaryImageIdentity"];
const FIELDS = new Set([
  "inventoryCode", "title", "description", "priceYen", "quantity", "categoryPath",
  "brand", "condition", "shippingMethod", "shippingPayer", "shippingOrigin",
  "shippingDays", "imageCount", "primaryImageIdentity",
]);

function validObservation(value, allowedValue) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.kind === "UNOBSERVED") return !Object.hasOwn(value, "value");
  return value.kind === "OBSERVED" && allowedValue(value.value);
}

function validExactObservation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.exactProductReadBack !== true ||
      !validObservation(value.accountReference, item => typeof item === "string" && item.trim().length > 0) ||
      !validObservation(value.remoteId, item => typeof item === "string" && item.trim().length > 0) ||
      !validObservation(value.visibility, item => ["PRIVATE", "PUBLIC", "OTHER"].includes(item)) ||
      !value.fields || typeof value.fields !== "object" || Array.isArray(value.fields)) return false;
  return Object.entries(value.fields).every(([key, item]) => FIELDS.has(key) &&
    validObservation(item, field => typeof field === "string" ||
      (typeof field === "number" && Number.isFinite(field))));
}

function classify(comparison) {
  if (comparison.account === "DIFFERENT" || comparison.remoteId === "DIFFERENT") return "IDENTITY_MISMATCH";
  if (comparison.account !== "MATCH" || comparison.remoteId !== "MATCH") return "INCOMPLETE";
  if (comparison.visibility === "NOT_PRIVATE") return "NOT_PRIVATE";
  if (Object.values(comparison.fields).includes("DIFFERENT")) return "DIFFERENT";
  if (comparison.visibility !== "PRIVATE_OBSERVED" ||
      CORE_FIELDS.some(field => comparison.fields[field] !== "MATCH")) return "INCOMPLETE";
  return "CORE_FIELDS_MATCH";
}

/** One explicit read of one known remote ID. No browser, login, create, edit, or retry happens here. */
export async function runExistingRead(root, accountReference, jobId, reader = null) {
  const job = await readExistingJob(root, accountReference, jobId);
  return withReadLock(root, jobId, async () => {
    const base = { accountReference, remoteId: job.remoteId };
    if (!reader || typeof reader.readExactProduct !== "function")
      return saveReadResult(root, jobId, { ...base, status: "CONNECTOR_NOT_CONFIGURED", reasonCode: "NO_READER" });
    let output;
    try {
      output = await reader.readExactProduct({ accountReference, remoteId: job.remoteId });
    } catch {
      return saveReadResult(root, jobId, { ...base, status: "UNKNOWN", reasonCode: "READ_FAILED" });
    }
    if (output?.kind === "AUTH_REQUIRED")
      return saveReadResult(root, jobId, { ...base, status: "AUTH_REQUIRED", reasonCode: "SIGN_IN_REQUIRED" });
    if (output?.kind !== "OBSERVED" || !validExactObservation(output.observation))
      return saveReadResult(root, jobId, { ...base, status: "UNKNOWN", reasonCode: "UNVERIFIED_READ" });
    try {
      const comparison = reconcileExistingMercariProduct({
        accountReference, remoteId: job.remoteId,
        fields: { ...job.expectedFields, inventoryCode: job.inventoryCode },
      }, output.observation);
      return saveReadResult(root, jobId, { ...base, status: classify(comparison), comparison });
    } catch {
      return saveReadResult(root, jobId, { ...base, status: "UNKNOWN", reasonCode: "INVALID_OBSERVATION" });
    }
  });
}
