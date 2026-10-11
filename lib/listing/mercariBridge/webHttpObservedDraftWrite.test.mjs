import test from "node:test";
import assert from "node:assert/strict";
import { buildWebHttpDraftJob } from "./webHttpDraftJob.ts";
import { reserveWebHttpSendStart } from "./webHttpSendReservation.ts";
import { executeObservedDraftWriteOnce } from
  "./webHttpObservedDraftWrite.ts";

const inventoryId = "7ad79e0c-3b49-49a2-9a4b-f379863028e1";
const shopId = "evkhihBFFNn5hukMS9s36H";
const shipping = { method: "METHOD_TYPE_UNDECIDED", payer: "PAYER_TYPE_SELLER",
  origin: "jp11", duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" };
const pack = { schemaVersion: 1, kind: "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK",
  shopId, inventoryId, draftId: "5011916b-65af-4b73-89e5-00b9474a4e8a",
  draftUpdatedAt: "2026-10-08T01:02:03.000Z", title: "Fixture sofa",
  description: "Fixture description", condition: "NO_NOTABLE_DAMAGE",
  imageRefs: [{ source: "INVENTORY", storageKey: "inventory/front.jpg",
    sortOrder: 0, photoAssetId: null }], priceYen: 99999, quantity: 1,
  categoryId: "furniture_sofa", categoryPath: "家具・インテリア > ソファ",
  brandId: null, brandName: null,
  managementCode: "BELLO_7AD79E0C3B4949A29A4BF379863028E1",
  shipping, status: "PREPARED_NO_SEND" };
const evidence = { sourceInventoryCode: "B009990", sourcePriceYen: 50000,
  sourceQuantity: 1, sourceShippingMethod: "KAZAI", selectedQuantity: 1,
  selectedCategoryId: pack.categoryId, selectedCategoryPath: pack.categoryPath,
  categoryEvidence: "ADMIN_SELECTED_MASTER", shopsShipping: shipping,
  imageCount: 1, imageEvidence: "SAVED_REFERENCES_ONLY",
  shippingReviewRequired: true, status: "REVIEW_REQUIRED_NO_SEND" };
const job = buildWebHttpDraftJob(pack, evidence, "admin@example.com");
const attemptId = "7444d0d8-4795-4448-b2cc-d731638462d5";
const draftId = "2JXsGZ7vdfvq7bwbM7dAw9";
const assetId = "Asset123456";
const assetProof = { status: "VERIFIED_SAME_IMAGE_BYTES", shopId,
  inventoryId, snapshotFingerprint: job.snapshotFingerprint,
  remoteAssetId: assetId, imageRefCount: 1 };
const mappingProof = { status: "OBSERVED_INPUT_MAPPING_VERIFIED",
  snapshotFingerprint: job.snapshotFingerprint };
const variant = { name: "default", quantity: 1,
  skuCode: pack.managementCode, janCode: "", catalogSkuId: null,
  maxQuantityPerOrder: null };
const baseInput = { name: pack.title, description: pack.description,
  price: null, assetIds: null, categoryIds: null, brandIds: null,
  condition: null, shippingFromStateId: null,
  shippingDurationType: null, shippingMethodType: null,
  shippingPayerType: "seller", countryRestrictionTemplateId: "country",
  isRefurbished: false, channelListingScope: "all",
  variants: [variant] };
const create = { kind: "CREATE", input: { ...baseInput, shopId },
  idempotencyKeySeed: 0.5 };
const update = { kind: "UPDATE", input: { ...baseInput, id: draftId,
  price: pack.priceYen, assetIds: [assetId],
  categoryIds: [pack.categoryId], condition: "used",
  shippingFromStateId: "state", shippingDurationType: "duration",
  shippingMethodType: "method", variants: [{ ...variant,
    catalogSkuId: "catalog", attributes: [] }] },
  targetDraftProof: { status: "VERIFIED_SAME_JOB_DRAFT", shopId,
    inventoryId, snapshotFingerprint: job.snapshotFingerprint, draftId } };
const checks = { auth: "VALID", userReauthenticatedByHuman: true,
  writeContractVerified: true, remoteDuplicate: "ABSENT", existingBinding: false };

async function scenario({ shopStatus = 200, writeStatus = 200,
  shopMatched = true, writeBody = null, duplicate = "ABSENT_COMPLETE",
  now = 100_000 } = {}) {
  let slot = null;
  let attempt = null;
  let claims = 0;
  const repository = {
    getSlot: async () => slot && { ...slot },
    getAttempt: async () => attempt && { ...attempt },
    transactReserve: async (_prior, next, item) => {
      slot = { ...next }; attempt = { ...item };
    },
    claimMutationStart: async (requestId, claimedId) => {
      if (attempt?.status !== "RESERVED_NO_SEND" ||
          attempt.requestId !== requestId || attempt.attemptId !== claimedId)
        throw Error("already claimed");
      claims += 1;
      attempt.status = "SEND_CLAIMED_RESULT_UNKNOWN";
    },
  };
  const reservation = await reserveWebHttpSendStart(job, checks,
    attemptId, repository, () => now);
  assert.equal(reservation.ok, true);
  const calls = [];
  const fetchPort = async (url, init) => {
    calls.push({ url, init });
    const request = JSON.parse(init.body);
    if (request.operationName === "OwnShops")
      return shopStatus === 200 ? Response.json({ data: {
        ownShops: [{ id: shopMatched ? shopId : "other" }] } }) :
        new Response(null, { status: shopStatus });
    if (writeStatus === 302) return new Response(null, { status: 302,
      headers: { location: "https://example.net/redirect" } });
    if (writeStatus === 401) return new Response(null, { status: 401 });
    return Response.json(writeBody ?? { data: {
      [request.operationName === "CreateProductDraft" ?
        "createProductDraft" : "updateProductDraft"]: { id: draftId } } },
    { status: writeStatus });
  };
  const readback = { verifyTargetShop: async () => ({ status: "VERIFIED",
    shopMatched: true }), listDraftCandidates: async () => ({ status: "OK",
    complete: true, candidates: [{ id: draftId, shopId,
      name: pack.title, description: pack.description,
      price: pack.priceYen, quantity: 1,
      skuCode: pack.managementCode, thumbnailCount: 1 }] }) };
  const ports = { cookieHeader: "id_token=super-secret",
    cookieExpiresAtMs: now + 60_000, fetchPort, repository,
    readCurrentInventory: async () => ({ id: inventoryId, sku: "B009990" }),
    hasExistingBinding: async () => false,
    duplicatePreflight: async () => duplicate, readback };
  return { reservation, ports, calls, claims: () => claims,
    slot: () => slot };
}
const run = (state, mutation = create, proof = assetProof,
  mapping = mappingProof, clock = () => 100_000) =>
  executeObservedDraftWriteOnce(job, state.reservation, mutation,
    proof, mapping, state.ports, clock);

test("one reservation sends one observed create to the fixed host", async () => {
  const state = await scenario();
  const first = await run(state);
  assert.equal(first.status, "CREATE_ACKNOWLEDGED_NEEDS_UPDATE");
  assert.equal(first.listingConfirmed, false);
  assert.equal(first.allowRetry, false);
  assert.equal(state.claims(), 1);
  assert.deepEqual(state.calls.map(call =>
    JSON.parse(call.init.body).operationName),
  ["OwnShops", "CreateProductDraft"]);
  assert.ok(state.calls.every(call =>
    call.url === "https://mercari-shops.com/graphql" &&
    call.init.redirect === "manual" && call.init.method === "POST"));
  assert.equal(JSON.stringify(first).includes("super-secret"), false);
  const second = await run(state);
  assert.equal(second.status, "RESERVATION_UNVERIFIED_NO_SEND");
  assert.equal(state.calls.length, 2);
});

test("concurrent callers sharing a reservation issue only one mutation", async () => {
  const state = await scenario();
  const results = await Promise.all([run(state), run(state)]);
  assert.equal(results.filter(item => item.status ===
    "CREATE_ACKNOWLEDGED_NEEDS_UPDATE").length, 1);
  assert.equal(state.claims(), 1);
  assert.equal(state.calls.filter(call =>
    JSON.parse(call.init.body).operationName === "CreateProductDraft").length,
  1);
});

test("one observed update request uses the confirmed asset and draft ID", async () => {
  const state = await scenario({ duplicate: {
    status: "TARGET_ONLY_COMPLETE", draftId } });
  const output = await run(state, update);
  assert.equal(output.status, "UPDATE_ACKNOWLEDGED_NEEDS_READBACK");
  const request = JSON.parse(state.calls[1].init.body);
  assert.equal(request.operationName, "UpdateProductDraft");
  assert.deepEqual(request.variables.input.assetIds, [assetId]);
  assert.equal(request.variables.input.id, draftId);
  assert.equal(state.claims(), 1);
});

test("unverified asset, mapping, duplicate, auth and expired permit stop before write", async () => {
  for (const change of [
    { proof: null, expected: "ASSET_UNVERIFIED_NO_SEND" },
    { mapping: null, expected: "MAPPING_UNVERIFIED_NO_SEND" },
    { mutation: { ...create, input: { ...create.input,
      shopId: "other" } }, expected: "MAPPING_UNVERIFIED_NO_SEND" },
    { mutation: { ...update, kind: "PUBLISH" },
      expected: "MAPPING_UNVERIFIED_NO_SEND" },
    { mutation: { ...update, targetDraftProof: null },
      expected: "MAPPING_UNVERIFIED_NO_SEND" },
  ]) {
    const state = await scenario();
    const output = await run(state, change.mutation ?? create,
      "proof" in change ? change.proof : assetProof,
      "mapping" in change ? change.mapping : mappingProof);
    assert.equal(output.status, change.expected);
    assert.equal(state.calls.length, 0);
    assert.equal(state.claims(), 0);
  }
  const duplicate = await scenario({ duplicate: "FOUND" });
  assert.equal((await run(duplicate)).status,
    "DUPLICATE_OR_READ_UNVERIFIED_NO_SEND");
  assert.equal(duplicate.calls.length, 1);
  assert.equal(duplicate.claims(), 0);
  const auth = await scenario({ shopStatus: 401 });
  assert.equal((await run(auth)).status, "AUTH_REQUIRED_NO_SEND");
  assert.equal(auth.calls.length, 1);
  assert.equal(auth.claims(), 0);
  const unknownExpiry = await scenario();
  unknownExpiry.ports.cookieExpiresAtMs = null;
  assert.equal((await run(unknownExpiry)).status,
    "AUTH_REQUIRED_NO_SEND");
  assert.equal(unknownExpiry.calls.length, 0);
  const expired = await scenario();
  assert.equal((await run(expired, create, assetProof, mappingProof,
    () => 104_000)).status, "RESERVATION_UNVERIFIED_NO_SEND");
  assert.equal(expired.calls.length, 0);
});

test("current BELLO inventory UUID and SKU must match the frozen job", async () => {
  for (const current of [
    { id: "5b0f3587-cbbb-4c09-ae78-595b2b3e353f", sku: "B005413" },
    { id: "c9ee4ea7-070f-491c-bd4c-c1547cb73436", sku: "B005757" },
    { id: inventoryId, sku: "B005396" },
    { id: inventoryId, sku: "B005413" },
    null,
  ]) {
    const state = await scenario();
    state.ports.readCurrentInventory = async () => current;
    assert.equal((await run(state)).status,
      "INVENTORY_MISMATCH_NO_SEND");
    assert.equal(state.calls.length, 0);
    assert.equal(state.claims(), 0);
  }
});

test("unknown HTTP result reads back but never resends", async () => {
  const state = await scenario({ writeStatus: 302 });
  const output = await run(state);
  assert.equal(output.status, "RESULT_UNKNOWN_NO_RESEND");
  assert.equal(output.readbackStatus,
    "MATCHING_DRAFT_OBSERVED_NO_RESEND");
  assert.equal(state.calls[1].init.redirect, "manual");
  assert.equal(state.claims(), 1);
  assert.equal((await run(state)).status,
    "RESERVATION_UNVERIFIED_NO_SEND");
  assert.equal(state.calls.length, 2);
});

test("shop mismatch, short slot interval and ambiguous claim cannot write", async () => {
  const wrongShop = await scenario({ shopMatched: false });
  assert.equal((await run(wrongShop)).status, "SHOP_UNVERIFIED_NO_SEND");
  assert.equal(wrongShop.calls.length, 1);
  assert.equal(wrongShop.claims(), 0);

  const shortSlot = await scenario();
  shortSlot.slot().nextEligibleAt = new Date(133_000).toISOString();
  assert.equal((await run(shortSlot)).status,
    "RESERVATION_UNVERIFIED_NO_SEND");
  assert.equal(shortSlot.calls.length, 0);

  const ambiguous = await scenario();
  const claim = ambiguous.ports.repository.claimMutationStart;
  ambiguous.ports.repository.claimMutationStart = async (...args) => {
    await claim(...args);
    throw Error("response lost after claim");
  };
  assert.equal((await run(ambiguous)).status,
    "RESERVATION_UNVERIFIED_NO_SEND");
  assert.equal(ambiguous.claims(), 1);
  assert.equal(ambiguous.calls.length, 1);
  assert.equal((await run(ambiguous)).status,
    "RESERVATION_UNVERIFIED_NO_SEND");

  const elapsed = await scenario();
  let time = 100_000;
  const originalClaim = elapsed.ports.repository.claimMutationStart;
  elapsed.ports.repository.claimMutationStart = async (...args) => {
    await originalClaim(...args);
    time = 104_000;
  };
  const delayed = await run(elapsed, create, assetProof, mappingProof,
    () => time);
  assert.equal(delayed.status, "RESULT_UNKNOWN_NO_RESEND");
  assert.equal(delayed.readbackStatus,
    "MATCHING_DRAFT_OBSERVED_NO_RESEND");
  assert.equal(elapsed.calls.length, 1);
});

test("401 after a claimed mutation requires auth and never retries", async () => {
  const state = await scenario({ writeStatus: 401 });
  assert.equal((await run(state)).status, "AUTH_REQUIRED_NO_RESEND");
  assert.equal(state.claims(), 1);
  assert.equal(state.calls.length, 2);
  assert.equal((await run(state)).status,
    "RESERVATION_UNVERIFIED_NO_SEND");
  assert.equal(state.calls.length, 2);
  const graphqlAuth = await scenario({ writeBody: { errors: [{
    extensions: { code: "UNAUTHENTICATED" } }] } });
  assert.equal((await run(graphqlAuth)).status,
    "AUTH_REQUIRED_NO_RESEND");
  assert.equal(graphqlAuth.claims(), 1);
  assert.equal(graphqlAuth.calls.length, 2);
});
