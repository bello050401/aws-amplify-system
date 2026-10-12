import test from "node:test";
import assert from "node:assert/strict";
import { buildWebHttpDraftJob } from "./webHttpDraftJob.ts";
import { reserveWebHttpSendStart, webHttpSendPermitFresh,
  webHttpStageRequestId } from
  "./webHttpSendReservation.ts";

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
function product(id, code) {
  return buildWebHttpDraftJob({ ...pack, inventoryId: id,
    managementCode: `BELLO_${id.replaceAll("-", "").toUpperCase()}` },
  { ...evidence, sourceInventoryCode: code }, "admin@example.com");
}
const otherJob = product("e8cd7464-a442-4875-83e9-87dd4b175720", "B009002");
const thirdJob = product("8050d343-4c5b-4d3b-9563-01c19ba17c75", "B009003");
const checks = { auth: "VALID", userReauthenticatedByHuman: true,
  writeContractVerified: true, remoteDuplicate: "ABSENT", existingBinding: false };
const a1 = "fef2b7ee-cf21-429f-99bf-9439eafab3af";
const a2 = "edbb1fe9-c09b-4cd6-ad24-85c3bb4291a4";
const a3 = "9c399965-f68f-4119-993c-78ed70285e7f";

function memoryRepository() {
  let slot = null;
  const attempts = new Map();
  const repo = {
    getSlot: async () => slot && { ...slot },
    getAttempt: async requestId => attempts.get(requestId) ?? null,
    transactReserve: async (previous, next, attempt, nowIso) => {
      if (attempts.has(attempt.requestId)) throw Error("duplicate attempt");
      if (previous === null) {
        if (slot !== null) throw Error("conditional create conflict");
      } else if (!slot || slot.revision !== previous.revision ||
          slot.attemptId !== previous.attemptId ||
          slot.nextEligibleAt > nowIso) {
        throw Error("conditional update conflict");
      }
      slot = { ...next };
      attempts.set(attempt.requestId, { ...attempt });
    },
  };
  return { repo, attempts, slot: () => slot };
}
const reserve = (j, id, repo, time) =>
  reserveWebHttpSendStart(j, checks, id, repo, () => time);

test("shop interval includes the send deadline and thirty seconds", async () => {
  const state = memoryRepository();
  const first = await reserve(job, a1, state.repo, 100_000);
  assert.equal(first.ok, true);
  assert.equal(state.slot().revision, 1);
  assert.equal(state.attempts.size, 1);
  assert.deepEqual(await reserve(otherJob, a2, state.repo, 134_999),
    { ok: false, code: "WAIT_INTERVAL", nextEligibleAtMs: 135_000 });
  assert.equal((await reserve(otherJob, a2, state.repo, 135_000)).ok, true);
  assert.equal(state.slot().revision, 2);
  assert.equal(state.attempts.size, 2);
});

test("image, create and update have distinct one-use send claims", async () => {
  const state = memoryRepository();
  const image = { kind: "IMAGE_UPLOAD", preparedJpegSha256: "b".repeat(64) };
  const create = { kind: "DRAFT_CREATE" };
  const update = { kind: "DRAFT_UPDATE", draftId: "Draft123" };
  const keys = [image, create, update]
    .map(stage => webHttpStageRequestId(job, stage));
  assert.equal(new Set(keys).size, 3);
  assert.ok(keys.every(key => /^[a-f0-9]{64}$/.test(key)));
  const send = (stage, attemptId, now) => reserveWebHttpSendStart(
    job, checks, attemptId, state.repo, () => now, stage);
  const first = await send(image, a1, 100_000);
  assert.equal(first.requestId, keys[0]);
  assert.equal((await send(image, a2, 135_000)).code,
    "ALREADY_CLAIMED_NO_SEND");
  assert.equal((await send(create, a2, 134_999)).code,
    "WAIT_INTERVAL");
  assert.equal((await send(create, a2, 135_000)).requestId, keys[1]);
  assert.equal((await send(update, a3, 170_000)).requestId, keys[2]);
  assert.equal(state.attempts.size, 3);
  assert.equal(state.slot().revision, 3);
});

test("invalid image or draft stage creates no send claim", async () => {
  const state = memoryRepository();
  for (const stage of [
    { kind: "IMAGE_UPLOAD", preparedJpegSha256: "bad" },
    { kind: "DRAFT_UPDATE", draftId: "../../other" },
    { kind: "UNKNOWN" },
  ]) {
    assert.equal(webHttpStageRequestId(job, stage), null);
    assert.equal((await reserveWebHttpSendStart(job, checks, a1,
      state.repo, () => 100_000, stage)).code, "INVALID_JOB");
  }
  assert.equal(state.attempts.size, 0);
  assert.equal(state.slot(), null);
});

async function race(jobs, state, time) {
  let reads = 0;
  let release;
  const bothRead = new Promise(resolve => { release = resolve; });
  const repo = { ...state.repo, getSlot: async shopId => {
    const observed = await state.repo.getSlot(shopId);
    if (++reads === 2) release();
    await bothRead;
    return observed;
  } };
  return Promise.all(jobs.map(([j, id]) => reserve(j, id, repo, time)));
}

test("one atomic transaction wins concurrent initial reservations", async () => {
  const state = memoryRepository();
  const results = await race([[job, a1], [otherJob, a2]], state, 100_000);
  assert.equal(results.filter(item => item.ok).length, 1);
  assert.equal(results.filter(item => item.code ===
    "RESERVATION_UNCONFIRMED_NO_SEND").length, 1);
  assert.equal(state.attempts.size, 1);
  assert.equal(state.slot().revision, 1);
});

test("one atomic transaction wins concurrent later reservations", async () => {
  const state = memoryRepository();
  assert.equal((await reserve(job, a1, state.repo, 100_000)).ok, true);
  const results = await race([[otherJob, a2], [thirdJob, a3]], state, 135_000);
  assert.equal(results.filter(item => item.ok).length, 1);
  assert.equal(results.filter(item => item.code ===
    "RESERVATION_UNCONFIRMED_NO_SEND").length, 1);
  assert.equal(state.attempts.size, 2);
  assert.equal(state.slot().revision, 2);
});

test("A's delayed response cannot become sendable after B reserves", async () => {
  const state = memoryRepository();
  let current = 100_000;
  let releaseA;
  const delayedA = new Promise(resolve => { releaseA = resolve; });
  let committedA;
  const aCommitted = new Promise(resolve => { committedA = resolve; });
  const repoA = { ...state.repo, transactReserve: async (...args) => {
    await state.repo.transactReserve(...args);
    committedA();
    await delayedA;
  } };
  const pendingA = reserveWebHttpSendStart(job, checks, a1, repoA,
    () => current);
  await aCommitted;
  current = 135_000;
  const b = await reserveWebHttpSendStart(otherJob, checks, a2,
    state.repo, () => current);
  assert.equal(b.ok, true);
  current = 136_000;
  releaseA();
  const a = await pendingA;
  assert.deepEqual(a, { ok: false, code: "RESERVATION_EXPIRED_NO_SEND" });
  assert.equal(webHttpSendPermitFresh(a, current), false);
});

test("commit followed by timeout is no-send and consumes the request", async () => {
  const state = memoryRepository();
  const repo = { ...state.repo, transactReserve: async (...args) => {
    await state.repo.transactReserve(...args);
    throw Error("response timeout after commit");
  } };
  assert.equal((await reserve(job, a1, repo, 100_000)).code,
    "RESERVATION_UNCONFIRMED_NO_SEND");
  assert.equal(state.attempts.size, 1);
  assert.equal((await reserve(job, a2, state.repo, 200_000)).code,
    "ALREADY_CLAIMED_NO_SEND");
});

test("permit expires at the send deadline", async () => {
  const state = memoryRepository();
  const result = await reserve(job, a1, state.repo, 100_000);
  assert.equal(webHttpSendPermitFresh(result, 103_999), true);
  assert.equal(webHttpSendPermitFresh(result, 104_000), false);
});

test("failed auth or preflight never writes either record", async () => {
  const state = memoryRepository();
  for (const unsafe of [
    { auth: "EXPIRED" }, { userReauthenticatedByHuman: false },
    { existingBinding: true }, { remoteDuplicate: "UNKNOWN" },
    { writeContractVerified: false },
  ]) {
    const result = await reserveWebHttpSendStart(job,
      { ...checks, ...unsafe }, a1, state.repo, () => 100_000);
    assert.equal(result.ok, false);
  }
  assert.equal(state.slot(), null);
  assert.equal(state.attempts.size, 0);
});
