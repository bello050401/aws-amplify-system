import { existingReadDispatchForOwner } from "./httpContract.ts";
import { normalizeExistingReadResult } from "./resultAcceptance.ts";
import type { ExistingProductBinding, ExistingReadJob } from "./readRequest";
import type { StoredReadResult } from "./resultAcceptance";

const statuses = new Set(["CONNECTOR_NOT_CONFIGURED", "AUTH_REQUIRED", "UNKNOWN",
  "IDENTITY_MISMATCH", "NOT_PRIVATE", "DIFFERENT", "INCOMPLETE", "CORE_FIELDS_MATCH"]);
const reasons = new Set(["NO_READER", "SIGN_IN_REQUIRED", "READ_FAILED",
  "UNVERIFIED_READ", "INVALID_OBSERVATION"]);
const fields = new Set(["inventoryCode", "title", "description", "priceYen", "quantity",
  "categoryPath", "brand", "condition", "shippingMethod", "shippingPayer",
  "shippingOrigin", "shippingDays", "imageCount", "primaryImageIdentity"]);
const outcomes = new Set(["MATCH", "DIFFERENT", "UNOBSERVED", "NO_BELLO_EXPECTATION"]);

export type ReadResultView = {
  attemptId: string;
  recordedAt: string;
  status: string;
  reasonCode: string | null;
  fields: Record<string, string>;
  visibility: "PRIVATE_OBSERVED" | "NOT_PRIVATE" | "UNOBSERVED" | null;
  identity: "MATCH" | "DIFFERENT" | "UNOBSERVED" | null;
};

/** The UI receives only validated status codes, never persisted JSON or page text. */
export function existingReadResultsForOwner(job: ExistingReadJob | null,
  binding: ExistingProductBinding | null, principal: string | null,
  rows: StoredReadResult[]): ReadResultView[] | null {
  const dispatch = existingReadDispatchForOwner(job, binding, principal);
  if (!dispatch || !job || !binding) return null;
  const result: ReadResultView[] = [];
  for (const row of rows) {
    if (row.requestId !== dispatch.requestId || row.inventoryId !== job.inventoryId ||
        row.shopId !== dispatch.accountReference || row.remoteId !== dispatch.remoteId ||
        !statuses.has(row.status) || !Number.isFinite(Date.parse(row.recordedAt)) ||
        !/^[0-9a-f-]{36}$/i.test(row.attemptId) ||
        (row.reasonCode !== null && !reasons.has(row.reasonCode))) return null;
    let safeFields: Record<string, string> = {};
    let visibility: ReadResultView["visibility"] = null;
    let identity: ReadResultView["identity"] = null;
    if (row.comparisonJson !== null) {
      let value: unknown;
      try { value = JSON.parse(row.comparisonJson); } catch { return null; }
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const comparison = value as Record<string, unknown>;
      if (comparison.createAllowed !== false || !["PRIVATE_OBSERVED", "NOT_PRIVATE", "UNOBSERVED"].includes(String(comparison.visibility)) ||
          !comparison.fields || typeof comparison.fields !== "object" || Array.isArray(comparison.fields)) return null;
      visibility = comparison.visibility as ReadResultView["visibility"];
      identity = comparison.account === "MATCH" && comparison.remoteId === "MATCH" ? "MATCH" :
        comparison.account === "DIFFERENT" || comparison.remoteId === "DIFFERENT" ?
          "DIFFERENT" : "UNOBSERVED";
      safeFields = {};
      for (const [field, outcome] of Object.entries(comparison.fields)) {
        if (!fields.has(field) || typeof outcome !== "string" || !outcomes.has(outcome)) return null;
        safeFields[field] = outcome;
      }
    }
    try {
      const normalized = normalizeExistingReadResult(job, binding, {
        requestId: row.requestId, attemptId: row.attemptId,
        accountReference: row.shopId, remoteId: row.remoteId, status: row.status,
        comparison: row.comparisonJson === null ? null : JSON.parse(row.comparisonJson),
        reasonCode: row.reasonCode,
      }, row.recordedAt);
      if (normalized.resultId !== row.resultId || normalized.status !== row.status ||
          normalized.comparisonJson !== row.comparisonJson || normalized.reasonCode !== row.reasonCode) return null;
    } catch { return null; }
    result.push({ attemptId: row.attemptId, recordedAt: row.recordedAt,
      status: row.status, reasonCode: row.reasonCode, fields: safeFields, visibility, identity });
  }
  return result.sort((left, right) => right.recordedAt.localeCompare(left.recordedAt));
}
