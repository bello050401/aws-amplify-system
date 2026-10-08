import test from "node:test";
import assert from "node:assert/strict";
import { buildWebHttpDraftJob } from "./webHttpDraftJob.ts";
import { reserveWebHttpSendStart } from "./webHttpSendReservation.ts";

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
const job = buildWebHttpDraftJob(pack, evidence, "admin@example.com");
const otherId = "e8cd7464-a442-4875-83e9-87dd4b175720";
const otherJob = buildWebHttpDraftJob({ ...pack, inventoryId: otherId,
  managementCode: `BELLO_${otherId.replaceAll("-", "").toUpperCase()}` },
  { ...evidence, sourceInventoryCode: "B009002" }, "admin@example.com");
const thirdId = "8050d343-4c5b-4d3b-9563-01c19ba17c75";
const thirdJob = buildWebHttpDraftJob({ ...pack, inventoryId: thirdId,
  managementCode: `BELLO_${thirdId.replaceAll("-", "").toUpperCase()}` },
  { ...evidence, sourceInventoryCode: "B009003" }, "admin@example.com");
const checks = { auth: "VALID", userReauthenticatedByHuman: true,
  writeContractVerified: true, remoteDuplicate: "ABSENT", existingBinding: false };
const a1 = "fef2b7ee-cf21-429f-99bf-9439eafab3af";
const a2 = "edbb1fe9-c09b-4cd6-ad24-85c3bb4291a4";

function memoryRepository() {
  let slot = null;
  const attempts = new Map();
  const repo = {
    getSlot: async () => slot && { ...slot },
    createSlot: async next => {
      if (slot) throw Error("conditional create conflict");
      slot = { ...next };
    },
    updateSlot: async (previous, next) => {
      if (!slot || slot.revision !== previous.revision ||
          slot.attemptId !== previous.attemptId)
        throw Error("conditional update conflict");
      slot = { ...next };
    },
    getAttempt: async requestId => attempts.get(requestId) ?? null,
    createAttempt: async attempt => {
      if (attempts.has(attempt.requestId)) throw Error("duplicate attempt");
      attempts.set(attempt.requestId, { ...attempt });
    },
  };
  return { repo, attempts, slot: () => slot };
}

test("a confirmed slot and one-time claim enforce 30 seconds across products", async () => {
  const state = memoryRepository();
  const first = await reserveWebHttpSendStart(job, checks, a1, state.repo, 100_000);
  assert.equal(first.ok, true);
  assert.equal(state.slot().revision, 1);
  assert.equal(state.attempts.size, 1);
  const early = await reserveWebHttpSendStart(otherJob, checks, a2,
    state.repo, 129_999);
  assert.deepEqual(early, { ok: false, code: "WAIT_INTERVAL",
    nextEligibleAtMs: 130_000 });
  assert.equal(state.attempts.size, 1);
  const onTime = await reserveWebHttpSendStart(otherJob, checks, a2,
    state.repo, 130_000);
  assert.equal(onTime.ok, true);
  assert.equal(state.slot().revision, 2);
  assert.equal(state.attempts.size, 2);
});

test("concurrent products cannot both reserve the same shop interval", async () => {
  const state = memoryRepository();
  let reads = 0;
  let release;
  const bothRead = new Promise(resolve => { release = resolve; });
  const repo = { ...state.repo, getSlot: async shopId => {
    const observed = await state.repo.getSlot(shopId);
    if (++reads === 2) release();
    await bothRead;
    return observed;
  } };
  const results = await Promise.all([
    reserveWebHttpSendStart(job, checks, a1, repo, 100_000),
    reserveWebHttpSendStart(otherJob, checks, a2, repo, 100_000),
  ]);
  assert.equal(results.filter(item => item.ok).length, 1);
  assert.equal(results.filter(item => item.code ===
    "RESERVATION_UNCONFIRMED_NO_SEND").length, 1);
  assert.equal(state.attempts.size, 1);
  assert.equal(state.slot().revision, 1);
});

test("conditional update also serializes concurrent reservations after 30 seconds", async () => {
  const state = memoryRepository();
  assert.equal((await reserveWebHttpSendStart(job, checks, a1,
    state.repo, 100_000)).ok, true);
  let reads = 0;
  let release;
  const bothRead = new Promise(resolve => { release = resolve; });
  const repo = { ...state.repo, getSlot: async shopId => {
    const observed = await state.repo.getSlot(shopId);
    if (++reads === 2) release();
    await bothRead;
    return observed;
  } };
  const results = await Promise.all([
    reserveWebHttpSendStart(otherJob, checks, a2, repo, 130_000),
    reserveWebHttpSendStart(thirdJob, checks,
      "9c399965-f68f-4119-993c-78ed70285e7f", repo, 130_000),
  ]);
  assert.equal(results.filter(item => item.ok).length, 1);
  assert.equal(results.filter(item => item.code ===
    "RESERVATION_UNCONFIRMED_NO_SEND").length, 1);
  assert.equal(state.slot().revision, 2);
  assert.equal(state.attempts.size, 2);
});

test("an ambiguous slot response never proceeds to the attempt claim", async () => {
  const state = memoryRepository();
  const repo = { ...state.repo, createSlot: async next => {
    await state.repo.createSlot(next);
    throw Error("response timeout after commit");
  } };
  const result = await reserveWebHttpSendStart(job, checks, a1, repo, 100_000);
  assert.equal(result.code, "RESERVATION_UNCONFIRMED_NO_SEND");
  assert.equal(state.slot().attemptId, a1);
  assert.equal(state.attempts.size, 0);
});

test("an ambiguous attempt response consumes the job and forbids later retry", async () => {
  const state = memoryRepository();
  const repo = { ...state.repo, createAttempt: async attempt => {
    await state.repo.createAttempt(attempt);
    throw Error("response timeout after commit");
  } };
  const first = await reserveWebHttpSendStart(job, checks, a1, repo, 100_000);
  assert.equal(first.code, "ATTEMPT_UNCONFIRMED_NO_SEND");
  assert.equal(state.attempts.size, 1);
  const retry = await reserveWebHttpSendStart(job, checks, a2,
    state.repo, 200_000);
  assert.equal(retry.code, "ALREADY_CLAIMED_NO_SEND");
  assert.equal(state.slot().revision, 1);
});

test("auth expiry and missing human reauthentication stop before storage writes", async () => {
  const state = memoryRepository();
  for (const unsafe of [{ auth: "EXPIRED" },
    { userReauthenticatedByHuman: false }]) {
    const result = await reserveWebHttpSendStart(job,
      { ...checks, ...unsafe }, a1, state.repo, 100_000);
    assert.equal(result.code, "AUTH_REQUIRED");
  }
  assert.equal(state.slot(), null);
  assert.equal(state.attempts.size, 0);
});

test("existing linkage and unverified write contract never reserve a slot", async () => {
  const state = memoryRepository();
  assert.equal((await reserveWebHttpSendStart(job,
    { ...checks, existingBinding: true }, a1, state.repo, 100_000)).code,
  "BLOCKED_EXISTING_LINK");
  assert.equal((await reserveWebHttpSendStart(job,
    { ...checks, remoteDuplicate: "UNKNOWN" }, a1,
    state.repo, 100_000)).code, "PRECHECK_NOT_READY");
  assert.equal((await reserveWebHttpSendStart(job,
    { ...checks, writeContractVerified: false }, a1,
    state.repo, 100_000)).code, "PRECHECK_NOT_READY");
  assert.equal(state.slot(), null);
});
