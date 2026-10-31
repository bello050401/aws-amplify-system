import test from "node:test";
import assert from "node:assert/strict";
import { buildWebHttpDraftJob } from "./webHttpDraftJob.ts";
import { B005396_CORRECT_DRAFT_ID } from
  "./webHttpObservedDraftRead.ts";
import { checkWebHttpReadiness } from "./webHttpReadiness.ts";

const shopId = "evkhihBFFNn5hukMS9s36H";
const knownId = "2c53f36a-7a60-4e34-801d-8abc24f6cfc0";
const targetId = "1fa6d72b-306f-4af8-bfc8-a4bd4435eb33";
const shipping = { method: "METHOD_TYPE_UNDECIDED", payer: "PAYER_TYPE_SELLER",
  origin: "jp11", duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" };
function makeJob(inventoryId, code, priceYen) {
  const pack = { schemaVersion: 1, kind: "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK",
    shopId, inventoryId, draftId: "0d76fb56-41f8-4dd3-ae18-a660a5e97ae1",
    draftUpdatedAt: "2026-10-08T01:02:03.000Z", title: "Fixture sofa",
    description: "Fixture description", condition: "NO_NOTABLE_DAMAGE",
    imageRefs: [{ source: "INVENTORY", storageKey: "inventory/front.jpg",
      sortOrder: 0, photoAssetId: null }], priceYen, quantity: 1,
    categoryId: "furniture_sofa", categoryPath: "家具・インテリア > ソファ",
    brandId: null, brandName: null,
    managementCode: `BELLO_${inventoryId.replaceAll("-", "").toUpperCase()}`,
    shipping, status: "PREPARED_NO_SEND" };
  const evidence = { sourceInventoryCode: code, sourcePriceYen: 50000,
    sourceQuantity: 1, sourceShippingMethod: "KAZAI", selectedQuantity: 1,
    selectedCategoryId: pack.categoryId, selectedCategoryPath: pack.categoryPath,
    categoryEvidence: "ADMIN_SELECTED_MASTER", shopsShipping: shipping,
    imageCount: 1, imageEvidence: "SAVED_REFERENCES_ONLY",
    shippingReviewRequired: true, status: "REVIEW_REQUIRED_NO_SEND" };
  return buildWebHttpDraftJob(pack, evidence, "admin@example.com",
    "2026-10-08T01:02:04.000Z");
}
const knownJob = makeJob(knownId, "B005396", 99999);
const targetJob = makeJob(targetId, "B009001", 46900);
const nowMs = Date.parse("2026-10-09T00:01:00.000Z");
const sessionStore = { read: async () => ({ schemaVersion: 1, shopId,
  ownerSub: "owner_123", sessionId: "fef2b7ee-cf21-429f-99bf-9439eafab3af",
  authenticatedAt: "2026-10-09T00:00:00.000Z", expiresAt: null,
  opaqueMaterial: "mock-secret-never-returned" }), write: async () => {} };
const draftResponse = id => ({ status: 200, body: { data: { productDraft:
  id === B005396_CORRECT_DRAFT_ID ? { id, name: "Fixture sofa",
    description: "Fixture description", price: 99999,
    variants: [{ quantity: 1, skuCode: knownJob.managementCode }],
    thumbnails: [{ id: "asset" }] } :
    { id, name: "Fixture sofa", price: 0, thumbnails: [] } } } });
function ports(overrides = {}) {
  return { sessionStore,
    transportForSession: () => ({ post: async request =>
      draftResponse(request.variables.id) }),
    readTargetPreflight: async job => ({ requestId: job.requestId,
      snapshotFingerprint: job.snapshotFingerprint, observedAtMs: nowMs,
      checks: { writeContractVerified: true, remoteDuplicate: "ABSENT",
        existingBinding: false, globalSendHistoryKnown: true,
        lastGlobalSendAtMs: null } }), ...overrides };
}
const check = (job, injected) => checkWebHttpReadiness(job, knownJob,
  "owner_123", ports(injected), () => nowMs);

test("fresh known-draft read and complete target evidence reach reservation only", async () => {
  let reads = 0;
  const actual = await check(targetJob, {
    transportForSession: () => ({ post: async request => {
      reads++;
      return draftResponse(request.variables.id);
    } }),
  });
  assert.equal(reads, 4); // Two known drafts, checked before and after target preflight.
  assert.deepEqual(actual, { status: "READY_FOR_RESERVATION",
    allowHttpWrite: false, reauthenticationRequired: false });
});

test("the known item stays blocked even if target evidence claims no duplicate", async () => {
  let targetReads = 0;
  const actual = await check(knownJob, { readTargetPreflight: async () => {
    targetReads++;
    throw Error("must not run");
  } });
  assert.equal(actual.status, "BLOCKED_EXISTING_DRAFT");
  assert.equal(actual.allowHttpWrite, false);
  assert.equal(targetReads, 0);
});

test("401 and trusted additional auth stop before target checks", async () => {
  for (const [response, status] of [
    [{ status: 401, body: "secret response" }, "AUTH_REQUIRED"],
    [{ status: 200, body: {}, additionalAuthRequired: true },
      "ADDITIONAL_AUTH_REQUIRED"],
  ]) {
    let targetReads = 0;
    const actual = await check(targetJob, {
      transportForSession: () => ({ post: async () => response }),
      readTargetPreflight: async () => { targetReads++; return null; },
    });
    assert.equal(actual.status, status);
    assert.equal(actual.reauthenticationRequired, true);
    assert.equal(targetReads, 0);
    assert.equal(JSON.stringify(actual).includes("secret"), false);
  }
});

test("authentication expiring during target preflight cannot reach reservation", async () => {
  for (const status of ["AUTH_REQUIRED", "ADDITIONAL_AUTH_REQUIRED",
    "UNKNOWN"]) {
    const actual = await check(targetJob, {
      readTargetPreflight: async () => ({ status }),
    });
    assert.equal(actual.status, status === "UNKNOWN" ?
      "PREFLIGHT_UNVERIFIED" : status);
    assert.equal(actual.allowHttpWrite, false);
  }
});

test("a session expiring while the target read runs cannot reach reservation", async () => {
  let currentMs = nowMs;
  const stored = await sessionStore.read();
  const expiringStore = { read: async () => ({ ...stored,
    expiresAt: new Date(nowMs + 5_000).toISOString() }),
    write: async () => {} };
  const actual = await checkWebHttpReadiness(targetJob, knownJob,
    "owner_123", ports({ sessionStore: expiringStore,
      readTargetPreflight: async job => {
        currentMs += 6_000;
        return { requestId: job.requestId,
          snapshotFingerprint: job.snapshotFingerprint,
          observedAtMs: currentMs,
          checks: { writeContractVerified: true,
            remoteDuplicate: "ABSENT", existingBinding: false,
            globalSendHistoryKnown: true, lastGlobalSendAtMs: null } };
      },
    }), () => currentMs);
  assert.equal(actual.status, "AUTH_REQUIRED");
  assert.equal(actual.reauthenticationRequired, true);
  assert.equal(actual.allowHttpWrite, false);
});

test("a slow final auth read makes target evidence stale", async () => {
  let currentMs = nowMs;
  let draftReads = 0;
  const actual = await checkWebHttpReadiness(targetJob, knownJob,
    "owner_123", ports({
      transportForSession: () => ({ post: async request => {
        draftReads++;
        if (draftReads === 3) currentMs += 30_001;
        return draftResponse(request.variables.id);
      } }),
    }), () => currentMs);
  assert.equal(draftReads, 4);
  assert.equal(actual.status, "PREFLIGHT_UNVERIFIED");
  assert.equal(actual.allowHttpWrite, false);
});

test("known expiry reached at the final decision time requires login", async () => {
  const stored = await sessionStore.read();
  const expiringStore = { read: async () => ({ ...stored,
    expiresAt: new Date(nowMs + 5_000).toISOString() }),
    write: async () => {} };
  let calls = 0;
  const actual = await checkWebHttpReadiness(targetJob, knownJob,
    "owner_123", ports({ sessionStore: expiringStore }), () => {
      calls++;
      return calls >= 7 ? nowMs + 6_000 : nowMs;
    });
  assert.equal(actual.status, "AUTH_REQUIRED");
  assert.equal(actual.reauthenticationRequired, true);
  assert.equal(actual.allowHttpWrite, false);
});

test("unknown reads, failures, stale or misbound target evidence stop", async () => {
  const unknown = await check(targetJob, {
    transportForSession: () => ({ post: async () => {
      throw Error("secret-like error");
    } }),
  });
  assert.equal(unknown.status, "AUTH_UNVERIFIED");
  assert.equal(unknown.reauthenticationRequired, false);
  assert.equal(JSON.stringify(unknown).includes("secret"), false);
  for (const patch of [
    { requestId: "wrong" }, { observedAtMs: nowMs - 30_001 },
    { checks: { writeContractVerified: true, remoteDuplicate: "UNKNOWN",
      existingBinding: false, globalSendHistoryKnown: true,
      lastGlobalSendAtMs: null } },
  ]) {
    const actual = await check(targetJob, { readTargetPreflight: async job => ({
      requestId: job.requestId, snapshotFingerprint: job.snapshotFingerprint,
      observedAtMs: nowMs, checks: { writeContractVerified: true,
        remoteDuplicate: "ABSENT", existingBinding: false,
        globalSendHistoryKnown: true, lastGlobalSendAtMs: null }, ...patch,
    }) });
    assert.equal(actual.status, "PREFLIGHT_UNVERIFIED");
    assert.equal(actual.allowHttpWrite, false);
  }
});
