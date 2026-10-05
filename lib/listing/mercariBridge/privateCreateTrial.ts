import { createHash } from "node:crypto";

const TARGET = Object.freeze({
  inventoryId: "c9ee4ea7-070f-491c-bd4c-c1547cb73436",
  inventoryCode: "B005757",
  shopId: "evkhihBFFNn5hukMS9s36H",
  skuCode: "B005757-TEST-20261004-caf445ac6e676343",
  priceYen: 98000,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TRIAL_KEY = createHash("sha256").update(
  `MERCARI_PRIVATE_CREATE_TEST\0${TARGET.shopId}\0${TARGET.skuCode}`).digest("hex");
const CLAIM_ID = `${TRIAL_KEY}:CLAIM`;
const RESULT_ID = `${TRIAL_KEY}:UI_RESULT`;
const RESULT_REASONS = ["NETWORK_NOT_OBSERVED", "DRAFT_AUTOSAVE_UI_OBSERVED"] as const;
type ResultReason = typeof RESULT_REASONS[number];
const CLAIM_FIELDS = ["attemptId", "claimedAt", "inventoryCode", "inventoryId",
  "kind", "listingConfirmed", "priceYen", "schemaVersion", "shopId", "skuCode"];
const RESULT_FIELDS = [...CLAIM_FIELDS, "outcome", "reasonCode"];
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export type PrivateCreateEvent = {
  eventId: string;
  trialKey: string;
  attemptId: string;
  claimedAt: string;
  kind: "CLAIM" | "UI_RESULT";
  inventoryId: string;
  shopId: string;
  skuCode: string;
  priceYen: number;
  status: "CLAIMED" | "UI_ATTEMPT_UNVERIFIED";
  reasonCode: string | null;
  requestedBy: string;
  recordedAt: string;
};
export type PrivateCreateEventRepository = {
  getEvent: (eventId: string) => Promise<PrivateCreateEvent | null>;
  createEvent: (event: PrivateCreateEvent) => Promise<void>;
};
export class PrivateCreateTrialError extends Error {
  readonly code: "INVALID_INPUT" | "OWNER_REQUIRED" | "RESULT_BEFORE_CLAIM" |
    "EVENT_CONFLICT" | "STORAGE_UNAVAILABLE";
  constructor(code: PrivateCreateTrialError["code"]) { super(code); this.code = code; }
}

function normalizedExport(input: unknown): { kind: "CLAIM" | "UI_RESULT";
  attemptId: string; claimedAt: string; reasonCode: ResultReason | null } {
  if (!object(input) || input.schemaVersion !== 1 ||
      typeof input.kind !== "string" ||
      !["BELLO_PRIVATE_CREATE_CLAIM", "BELLO_PRIVATE_CREATE_UI_ATTEMPT"].includes(input.kind) ||
      Object.keys(input).sort().join(",") !==
        (input.kind === "BELLO_PRIVATE_CREATE_CLAIM" ? CLAIM_FIELDS : RESULT_FIELDS)
          .sort().join(",") ||
      typeof input.attemptId !== "string" || !UUID.test(input.attemptId) ||
      typeof input.claimedAt !== "string" || !ISO.test(input.claimedAt) ||
      !Number.isFinite(Date.parse(input.claimedAt)) ||
      input.inventoryId !== TARGET.inventoryId ||
      input.inventoryCode !== TARGET.inventoryCode || input.shopId !== TARGET.shopId ||
      input.skuCode !== TARGET.skuCode || input.priceYen !== TARGET.priceYen ||
      input.listingConfirmed !== false)
    throw new PrivateCreateTrialError("INVALID_INPUT");
  if (input.kind === "BELLO_PRIVATE_CREATE_UI_ATTEMPT" &&
      (input.outcome !== "UNVERIFIED" || !RESULT_REASONS.includes(input.reasonCode as ResultReason)))
    throw new PrivateCreateTrialError("INVALID_INPUT");
  return { kind: input.kind === "BELLO_PRIVATE_CREATE_CLAIM" ? "CLAIM" : "UI_RESULT",
    attemptId: input.attemptId, claimedAt: input.claimedAt,
    reasonCode: input.kind === "BELLO_PRIVATE_CREATE_CLAIM" ? null :
      input.reasonCode as ResultReason };
}

function sameEvent(left: PrivateCreateEvent, right: PrivateCreateEvent) {
  return left.eventId === right.eventId && left.trialKey === right.trialKey &&
    left.attemptId === right.attemptId && left.claimedAt === right.claimedAt &&
    left.kind === right.kind &&
    left.inventoryId === right.inventoryId && left.shopId === right.shopId &&
    left.skuCode === right.skuCode && left.priceYen === right.priceYen &&
    left.status === right.status && left.reasonCode === right.reasonCode &&
    left.requestedBy === right.requestedBy;
}

async function storedOrCreate(row: PrivateCreateEvent, repo: PrivateCreateEventRepository) {
  let existing: PrivateCreateEvent | null;
  try { existing = await repo.getEvent(row.eventId); }
  catch { throw new PrivateCreateTrialError("STORAGE_UNAVAILABLE"); }
  if (!existing) {
    try { await repo.createEvent(row); return row; }
    catch {
      try { existing = await repo.getEvent(row.eventId); }
      catch { throw new PrivateCreateTrialError("STORAGE_UNAVAILABLE"); }
      if (!existing) throw new PrivateCreateTrialError("STORAGE_UNAVAILABLE");
    }
  }
  if (!sameEvent(existing, row)) throw new PrivateCreateTrialError("EVENT_CONFLICT");
  return existing;
}

/** Records owner-attested local files; neither event proves a Shops create response. */
export async function acceptPrivateCreateTrialEvent(input: unknown, principal: string | null,
  repo: PrivateCreateEventRepository, recordedAt = new Date().toISOString()) {
  if (!principal) throw new PrivateCreateTrialError("OWNER_REQUIRED");
  const exported = normalizedExport(input);
  if (!ISO.test(recordedAt) || !Number.isFinite(Date.parse(recordedAt)))
    throw new PrivateCreateTrialError("INVALID_INPUT");
  if (exported.kind === "UI_RESULT") {
    let claim: PrivateCreateEvent | null;
    try { claim = await repo.getEvent(CLAIM_ID); }
    catch { throw new PrivateCreateTrialError("STORAGE_UNAVAILABLE"); }
    if (!claim || claim.kind !== "CLAIM" || claim.status !== "CLAIMED" ||
        claim.requestedBy !== principal || claim.attemptId !== exported.attemptId ||
        claim.claimedAt !== exported.claimedAt ||
        claim.trialKey !== TRIAL_KEY || claim.inventoryId !== TARGET.inventoryId ||
        claim.shopId !== TARGET.shopId || claim.skuCode !== TARGET.skuCode ||
        claim.priceYen !== TARGET.priceYen)
      throw new PrivateCreateTrialError("RESULT_BEFORE_CLAIM");
  }
  const row: PrivateCreateEvent = {
    eventId: exported.kind === "CLAIM" ? CLAIM_ID : RESULT_ID,
    trialKey: TRIAL_KEY, attemptId: exported.attemptId, claimedAt: exported.claimedAt,
    kind: exported.kind, inventoryId: TARGET.inventoryId,
    shopId: TARGET.shopId, skuCode: TARGET.skuCode,
    priceYen: TARGET.priceYen,
    status: exported.kind === "CLAIM" ? "CLAIMED" : "UI_ATTEMPT_UNVERIFIED",
    reasonCode: exported.reasonCode,
    requestedBy: principal, recordedAt,
  };
  return storedOrCreate(row, repo);
}

export async function privateCreateTrialForOwner(principal: string | null,
  repo: PrivateCreateEventRepository) {
  if (!principal) throw new PrivateCreateTrialError("OWNER_REQUIRED");
  let claim: PrivateCreateEvent | null;
  let result: PrivateCreateEvent | null;
  try { [claim, result] = await Promise.all([repo.getEvent(CLAIM_ID), repo.getEvent(RESULT_ID)]); }
  catch { throw new PrivateCreateTrialError("STORAGE_UNAVAILABLE"); }
  if (!claim) {
    if (result) throw new PrivateCreateTrialError("EVENT_CONFLICT");
    return { claim: null, result: null };
  }
  if (claim.requestedBy !== principal || claim.trialKey !== TRIAL_KEY ||
      claim.eventId !== CLAIM_ID || claim.kind !== "CLAIM" ||
      claim.status !== "CLAIMED" || claim.inventoryId !== TARGET.inventoryId ||
      claim.shopId !== TARGET.shopId || claim.skuCode !== TARGET.skuCode ||
      claim.priceYen !== TARGET.priceYen || !UUID.test(claim.attemptId) ||
      !ISO.test(claim.claimedAt))
    throw new PrivateCreateTrialError("OWNER_REQUIRED");
  if (result && (result.requestedBy !== principal ||
      result.eventId !== RESULT_ID || result.trialKey !== TRIAL_KEY ||
      result.attemptId !== claim.attemptId || result.kind !== "UI_RESULT" ||
      result.claimedAt !== claim.claimedAt ||
      result.status !== "UI_ATTEMPT_UNVERIFIED" ||
      !RESULT_REASONS.includes(result.reasonCode as ResultReason) ||
      result.inventoryId !== TARGET.inventoryId || result.shopId !== TARGET.shopId ||
      result.skuCode !== TARGET.skuCode || result.priceYen !== TARGET.priceYen))
    throw new PrivateCreateTrialError("EVENT_CONFLICT");
  return { claim: { attemptId: claim.attemptId, recordedAt: claim.recordedAt },
    result: result ? { status: result.status, reasonCode: result.reasonCode,
      recordedAt: result.recordedAt } : null };
}

export const PINNED_PRIVATE_CREATE_TARGET = TARGET;
