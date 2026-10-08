import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildWebHttpDraftJob } from "./webHttpDraftJob.ts";
import { initialWebHttpExecutionState, transitionWebHttpExecution,
  WEB_HTTP_MIN_SEND_INTERVAL_MS } from "./webHttpExecutionGate.ts";

const inventoryId = "1fa6d72b-306f-4af8-bfc8-a4bd4435eb33";
const shipping = { method: "METHOD_TYPE_UNDECIDED", payer: "PAYER_TYPE_SELLER",
  origin: "jp11", duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" };
const pack = { schemaVersion: 1, kind: "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK",
  shopId: "evkhihBFFNn5hukMS9s36H", inventoryId,
  draftId: "0d76fb56-41f8-4dd3-ae18-a660a5e97ae1",
  draftUpdatedAt: "2026-10-08T01:02:03.000Z", title: "Fixture sofa",
  description: "Fixture description", condition: "NO_NOTABLE_DAMAGE",
  imageRefs: [{ source: "INVENTORY", storageKey: "inventory/front.jpg",
    sortOrder: 0, photoAssetId: null }], priceYen: 46900, quantity: 1,
  categoryId: "furniture_sofa", categoryPath: "家具・インテリア > ソファ",
  brandId: null, brandName: null,
  managementCode: `BELLO_${inventoryId.replaceAll("-", "").toUpperCase()}`,
  shipping, status: "PREPARED_NO_SEND" };
const evidence = { sourceInventoryCode: "B009001", sourcePriceYen: 45000,
  sourceQuantity: 1, sourceShippingMethod: "SAGAWA", selectedQuantity: 1,
  selectedCategoryId: pack.categoryId, selectedCategoryPath: pack.categoryPath,
  categoryEvidence: "ADMIN_SELECTED_MASTER", shopsShipping: shipping,
  imageCount: 1, imageEvidence: "SAVED_REFERENCES_ONLY",
  shippingReviewRequired: true, status: "REVIEW_REQUIRED_NO_SEND" };
const job = buildWebHttpDraftJob(pack, evidence, "admin@example.com",
  "2026-10-08T01:02:04.000Z");
const checks = { auth: "VALID", writeContractVerified: true,
  remoteDuplicate: "ABSENT", existingBinding: false,
  globalSendHistoryKnown: true, lastGlobalSendAtMs: 100_000 };
const attemptId = "fef2b7ee-cf21-429f-99bf-9439eafab3af";
const initial = () => initialWebHttpExecutionState(job);

test("the Web job starts prepared and rejects a mismatched snapshot", () => {
  assert.equal(initial()?.phase, "PREPARED");
  assert.equal(initial()?.attemptId, null);
  assert.equal(initialWebHttpExecutionState({ ...job,
    snapshotFingerprint: "0".repeat(64) }), null);
  assert.equal(initialWebHttpExecutionState({ ...job, shopId: "other" }), null);
  const tampered = JSON.parse(job.snapshotJson);
  tampered.pack.priceYen = 1;
  const snapshotJson = JSON.stringify(tampered);
  assert.equal(initialWebHttpExecutionState({ ...job, snapshotJson,
    snapshotFingerprint: createHash("sha256").update(snapshotJson)
      .digest("hex") }), null);
});

test("a send may begin only after the full 30-second global interval", () => {
  assert.equal(WEB_HTTP_MIN_SEND_INTERVAL_MS, 30_000);
  const early = transitionWebHttpExecution(initial(), {
    type: "BEGIN", nowMs: 129_999, checks, attemptId });
  assert.equal(early.phase, "WAIT_INTERVAL");
  assert.equal(early.nextEligibleAtMs, 130_000);
  assert.equal(early.attemptId, null);
  const onTime = transitionWebHttpExecution(early, {
    type: "BEGIN", nowMs: 130_000, checks, attemptId });
  assert.equal(onTime.phase, "IN_FLIGHT");
  assert.equal(onTime.attemptId, attemptId);
  assert.equal(onTime.attemptedAtMs, 130_000);
});

test("expired authentication stops before send; expiry after start needs verification", () => {
  const expired = transitionWebHttpExecution(initial(), { type: "BEGIN",
    nowMs: 130_000, checks: { ...checks, auth: "EXPIRED" }, attemptId });
  assert.equal(expired.phase, "AUTH_REQUIRED");
  assert.equal(expired.attemptId, null);
  assert.deepEqual(transitionWebHttpExecution(expired, {
    type: "BEGIN", nowMs: 130_000, checks, attemptId }), expired);
  assert.deepEqual(transitionWebHttpExecution(expired, {
    type: "USER_REAUTHENTICATED", verifiedByUser: false,
    reauthenticatedAtMs: 130_001 }), expired);
  const afterUserLogin = transitionWebHttpExecution(expired, {
    type: "USER_REAUTHENTICATED", verifiedByUser: true,
    reauthenticatedAtMs: 130_001 });
  assert.equal(afterUserLogin.phase, "PREPARED");
  const started = transitionWebHttpExecution(initial(), {
    type: "BEGIN", nowMs: 130_000, checks, attemptId });
  const afterExpiry = transitionWebHttpExecution(started, { type: "AUTH_EXPIRED" });
  assert.equal(afterExpiry.phase, "VERIFY_REQUIRED");
  assert.deepEqual(transitionWebHttpExecution(afterExpiry, {
    type: "BEGIN", nowMs: 160_000, checks, attemptId }), afterExpiry);
});

test("unknown outcome never makes the same job sendable again", () => {
  const started = transitionWebHttpExecution(initial(), {
    type: "BEGIN", nowMs: 130_000, checks, attemptId });
  const unknown = transitionWebHttpExecution(started, {
    type: "RESULT_UNKNOWN", attemptId });
  assert.equal(unknown.phase, "VERIFY_REQUIRED");
  assert.equal(unknown.attemptId, attemptId);
  assert.deepEqual(transitionWebHttpExecution(unknown, {
    type: "BEGIN", nowMs: 500_000,
    checks: { ...checks, lastGlobalSendAtMs: 130_000 }, attemptId }), unknown);
});

test("existing linkage or a found remote duplicate blocks new creation", () => {
  for (const unsafe of [{ existingBinding: true },
    { remoteDuplicate: "FOUND" }]) {
    const blocked = transitionWebHttpExecution(initial(), {
      type: "BEGIN", nowMs: 130_000, checks: { ...checks, ...unsafe },
      attemptId });
    assert.equal(blocked.phase, "BLOCKED_EXISTING_LINK");
    assert.equal(blocked.attemptId, null);
    assert.deepEqual(transitionWebHttpExecution(blocked, { type: "BEGIN",
      nowMs: 999_999, checks, attemptId }), blocked);
  }
});

test("missing contract, duplicate check, or global attempt history fails closed", () => {
  for (const unsafe of [{ writeContractVerified: false },
    { remoteDuplicate: "UNKNOWN" }, { globalSendHistoryKnown: false },
    { lastGlobalSendAtMs: 130_001 }]) {
    const state = transitionWebHttpExecution(initial(), {
      type: "BEGIN", nowMs: 130_000, checks: { ...checks, ...unsafe },
      attemptId });
    assert.equal(state.phase, "PREPARED");
    assert.equal(state.attemptId, null);
  }
});
