import { createHash } from "node:crypto";
import type { ExistingProductBinding, ExistingReadJob } from "./readRequest";

const FIELD_NAMES = new Set(["inventoryCode", "title", "description", "priceYen", "quantity",
  "categoryPath", "brand", "condition", "shippingMethod", "shippingPayer", "shippingOrigin",
  "shippingDays", "imageCount", "primaryImageIdentity"]);
const FIELD_RESULTS = new Set(["MATCH", "DIFFERENT", "UNOBSERVED", "NO_BELLO_EXPECTATION"]);
const CORE_FIELDS = ["inventoryCode", "title", "description", "priceYen", "quantity", "primaryImageIdentity"];
const TOP_LEVEL = new Set(["requestId", "attemptId", "accountReference", "remoteId", "status",
  "comparison", "reasonCode"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export type StoredReadResult = {
  resultId: string;
  requestId: string;
  attemptId: string;
  inventoryId: string;
  shopId: string;
  remoteId: string;
  status: string;
  comparisonJson: string | null;
  reasonCode: string | null;
  recordedAt: string;
};

export type ResultRepository = {
  getBinding: (inventoryId: string) => Promise<ExistingProductBinding | null>;
  getJob: (requestId: string) => Promise<ExistingReadJob | null>;
  getResult: (resultId: string) => Promise<StoredReadResult | null>;
  createResult: (result: StoredReadResult) => Promise<void>;
};

export class ResultAcceptanceError extends Error {
  readonly code: "INVALID_RESULT" | "IDENTITY_MISMATCH" | "RESULT_CONFLICT" | "STORAGE_UNAVAILABLE";
  constructor(code: ResultAcceptanceError["code"], message: string) {
    super(message); this.code = code;
  }
}

function invalid(): never {
  throw new ResultAcceptanceError("INVALID_RESULT", "既存商品の読取結果を検証できません。");
}

function classify(comparison: Record<string, unknown>): string {
  const fields = comparison.fields as Record<string, string>;
  if (comparison.account === "DIFFERENT" || comparison.remoteId === "DIFFERENT") return "IDENTITY_MISMATCH";
  if (comparison.account !== "MATCH" || comparison.remoteId !== "MATCH") return "INCOMPLETE";
  if (comparison.visibility === "NOT_PRIVATE") return "NOT_PRIVATE";
  if (Object.values(fields).includes("DIFFERENT")) return "DIFFERENT";
  if (comparison.visibility !== "PRIVATE_OBSERVED" || CORE_FIELDS.some((field) => fields[field] !== "MATCH"))
    return "INCOMPLETE";
  return "CORE_FIELDS_MATCH";
}

/** Accept only the bridge's small comparison record, never page text or credentials. */
export function normalizeExistingReadResult(job: ExistingReadJob, binding: ExistingProductBinding,
  input: unknown, recordedAt: string): StoredReadResult {
  if (!record(input) || Object.keys(input).some((key) => !TOP_LEVEL.has(key)) ||
      JSON.stringify(input).length > 16000 || !HASH.test(job.requestId) ||
      !HASH.test(job.snapshotFingerprint) || digest(job.snapshotJson) !== job.snapshotFingerprint ||
      job.operation !== "READ_EXISTING" || job.status !== "CONNECTOR_NOT_CONFIGURED" ||
      binding.inventoryId !== job.inventoryId || binding.shopId !== job.shopId || binding.remoteId !== job.remoteId ||
      typeof input.attemptId !== "string" || !UUID.test(input.attemptId) ||
      typeof input.status !== "string" || input.requestId !== job.requestId ||
      input.accountReference !== job.shopId || input.remoteId !== job.remoteId ||
      !Number.isFinite(Date.parse(recordedAt))) invalid();

  let snapshot: unknown;
  try { snapshot = JSON.parse(job.snapshotJson); } catch { invalid(); }
  if (!record(snapshot) || snapshot.operation !== "READ_EXISTING" ||
      snapshot.shopId !== job.shopId || snapshot.remoteId !== job.remoteId ||
      snapshot.inventoryId !== job.inventoryId || !record(snapshot.expected)) invalid();

  let comparisonJson: string | null = null;
  let reasonCode: string | null = null;
  if (input.comparison === null) {
    if (input.status === "DIRECT_HTTP_READ_CONFIRMED" &&
        (job.remoteId !== "2JXePE4ke8UCBTj6mxc4cf" ||
          snapshot.expected.inventoryCode !== "B005795")) invalid();
    const reasonToStatus: Record<string, string> = {
      NO_READER: "CONNECTOR_NOT_CONFIGURED", SIGN_IN_REQUIRED: "AUTH_REQUIRED",
      READ_FAILED: "UNKNOWN", UNVERIFIED_READ: "UNKNOWN", INVALID_OBSERVATION: "UNKNOWN",
      PINNED_HTTP_200_MATCHED: "DIRECT_HTTP_READ_CONFIRMED",
    };
    if (typeof input.reasonCode !== "string" || reasonToStatus[input.reasonCode] !== input.status) invalid();
    reasonCode = input.reasonCode;
  } else {
    const comparison = input.comparison;
    if (!record(comparison) || Object.keys(comparison).sort().join(",") !==
        "account,createAllowed,fields,remoteId,visibility" || comparison.createAllowed !== false ||
        typeof comparison.account !== "string" ||
        !["MATCH", "DIFFERENT", "UNOBSERVED"].includes(comparison.account) ||
        typeof comparison.remoteId !== "string" ||
        !["MATCH", "DIFFERENT", "UNOBSERVED"].includes(comparison.remoteId) ||
        typeof comparison.visibility !== "string" ||
        !["PRIVATE_OBSERVED", "NOT_PRIVATE", "UNOBSERVED"].includes(comparison.visibility) ||
        !record(comparison.fields) || Object.keys(comparison.fields).length > FIELD_NAMES.size ||
        input.reasonCode !== null) invalid();
    for (const [key, value] of Object.entries(comparison.fields)) {
      if (!FIELD_NAMES.has(key) || typeof value !== "string" || !FIELD_RESULTS.has(value)) invalid();
      if ((value === "MATCH" || value === "DIFFERENT") &&
          (!Object.hasOwn(snapshot.expected, key) || snapshot.expected[key] === null)) invalid();
    }
    const classified = classify(comparison);
    if (input.status !== classified) invalid();
    comparisonJson = JSON.stringify({ account: comparison.account, remoteId: comparison.remoteId,
      visibility: comparison.visibility, createAllowed: false,
      fields: Object.fromEntries(Object.entries(comparison.fields).sort(([left], [right]) => left.localeCompare(right))) });
  }
  return {
    resultId: digest(`${job.requestId}\0${input.attemptId}`),
    requestId: job.requestId,
    attemptId: input.attemptId as string,
    inventoryId: job.inventoryId,
    shopId: job.shopId,
    remoteId: job.remoteId,
    status: input.status as string,
    comparisonJson,
    reasonCode,
    recordedAt,
  };
}

/** Storage boundary for the authenticated ADMIN PC bridge; only sanitized results are accepted. */
export async function acceptExistingReadResult(input: unknown, repo: ResultRepository,
  recordedAt = new Date().toISOString()): Promise<StoredReadResult> {
  if (!record(input) || typeof input.requestId !== "string" || !HASH.test(input.requestId)) invalid();
  let job: ExistingReadJob | null;
  try { job = await repo.getJob(input.requestId); }
  catch { throw new ResultAcceptanceError("STORAGE_UNAVAILABLE", "読取依頼を確認できません。"); }
  if (!job) throw new ResultAcceptanceError("IDENTITY_MISMATCH", "読取依頼が見つかりません。");
  let binding: ExistingProductBinding | null;
  try { binding = await repo.getBinding(job.inventoryId); }
  catch { throw new ResultAcceptanceError("STORAGE_UNAVAILABLE", "既存商品の紐付けを確認できません。"); }
  if (!binding) throw new ResultAcceptanceError("IDENTITY_MISMATCH", "既存商品の紐付けが見つかりません。");
  const result = normalizeExistingReadResult(job, binding, input, recordedAt);
  let existing: StoredReadResult | null;
  try { existing = await repo.getResult(result.resultId); }
  catch { throw new ResultAcceptanceError("STORAGE_UNAVAILABLE", "読取結果を確認できません。"); }
  if (!existing) {
    try { await repo.createResult(result); return result; }
    catch {
      try { existing = await repo.getResult(result.resultId); }
      catch { throw new ResultAcceptanceError("STORAGE_UNAVAILABLE", "読取結果を確認できません。"); }
      if (!existing) throw new ResultAcceptanceError("STORAGE_UNAVAILABLE", "読取結果を保存できません。");
    }
  }
  if (existing.requestId !== result.requestId || existing.attemptId !== result.attemptId ||
      existing.inventoryId !== result.inventoryId || existing.shopId !== result.shopId ||
      existing.remoteId !== result.remoteId || existing.status !== result.status ||
      existing.comparisonJson !== result.comparisonJson || existing.reasonCode !== result.reasonCode) {
    throw new ResultAcceptanceError("RESULT_CONFLICT", "同じ読取試行に異なる結果が保存されています。");
  }
  return existing;
}
