import test from "node:test";
import assert from "node:assert/strict";
import { WEB_HTTP_SHOP_ID } from "./webHttpDraftJob.ts";
import { stopObservedWebHttpProductOnce, reconcileObservedWebHttpProductStop } from
  "./webHttpProductStop.ts";

const inventoryId = "1fa6d72b-306f-4af8-bfc8-a4bd4435eb33";
const admin = "admin@example.com";
const binding = { inventoryId, shopId: WEB_HTTP_SHOP_ID,
  remoteProductId: "FixtureProduct", managementCode: "BELLO_FIXTURE" };
function fixture() {
  let now = 100_000, slot = null, pending = null;
  let product = { id: binding.remoteProductId, name: "Fixture chair", description: "Description",
    snapshotId: "revision-1", inStock: true, shop: { id: WEB_HTTP_SHOP_ID },
    status: { id: "STATUS_OPENED" }, price: 99999, condition: { id: "CONDITION_BAD" },
    brands: [], categories: [{ category: [{ id: "root" }, { id: "leaf" }] }],
    thumbnails: [{ id: "Front" }, { id: "Back" }],
    variants: [{ id: "Variant", name: "", quantity: 1, stockSnapshotId: "stock-1",
      skuCode: binding.managementCode, janCode: "", catalogSkuId: null, attributes: [],
      maxQuantityPerOrderConfig: { configuredValue: null, actualValue: 1 },
      optionTypes: [{ id: "Type", options: [{ id: "Option", name: "" }] }] }],
    shippingMethodType: { id: "METHOD_MERCARI_SHIPPING_YAMATO" },
    shippingPayerType: { id: "PAYER_TYPE_SELLER" },
    shippingDurationType: { id: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" },
    shippingFromState: { id: "jp11" }, currentDualPrice: null,
    shippingConfiguration: null, mercaribinForBusinessSetting: null, preOrder: null,
    auction: null, countryRestrictionTemplateId: null, isRefurbished: false,
    channelListingScope: "CHANNEL_LISTING_SCOPE_ALL_CHANNELS" };
  const attempts = new Map(), requests = [];
  const state = { readCount: 0, timeoutAfterCommit: false, timeoutBeforeCommit: false,
    authAfterSend: false, readFailsAfterSend: false, ackWrongId: false,
    validationFail: false, saveFail: false, changeBeforeClaim: false, claimExpiry: false,
    captureStarted: false, releaseSend: null };
  const response = data => new Response(JSON.stringify({ data }), {
    status: 200, headers: { "Content-Type": "application/json" } });
  const repo = {
    getSlot: async () => slot && { ...slot },
    getAttempt: async id => structuredClone(attempts.get(id) ?? null),
    getPendingProductStop: async () => pending,
    transactReserve: async (previous, next, attempt, time) => {
      const old = attempts.get(attempt.requestId);
      if (pending || old && old.status !== "CANCELLED_NO_SEND" ||
          (slot ? slot.revision !== previous?.revision || slot.nextEligibleAt > time : previous))
        throw Error("conflict");
      slot = { ...next }; attempts.set(attempt.requestId, { ...attempt }); pending = attempt.requestId;
    },
    claimMutationStart: async (id, attemptId) => {
      const attempt = attempts.get(id);
      if (attempt?.status !== "RESERVED_NO_SEND" || attempt.attemptId !== attemptId) throw Error("conflict");
      attempt.status = "SEND_CLAIMED_RESULT_UNKNOWN";
      if (state.claimExpiry) now += 50_000;
    },
    verifyProductStop: async (id, attemptId, shopId, productId, fingerprint) => {
      const attempt = attempts.get(id);
      if (state.saveFail || attempt?.status !== "SEND_CLAIMED_RESULT_UNKNOWN" ||
          attempt.attemptId !== attemptId || shopId !== WEB_HTTP_SHOP_ID ||
          productId !== binding.remoteProductId || attempt.productContentFingerprint !== fingerprint ||
          pending !== id) throw Error("save unavailable");
      attempt.status = "PRODUCT_STOP_VERIFIED"; pending = null;
    },
    cancelUnclaimedProductStop: async attempt => {
      const stored = attempts.get(attempt.requestId);
      if (stored?.status !== "RESERVED_NO_SEND" || stored.attemptId !== attempt.attemptId ||
          pending !== attempt.requestId) throw Error("conflict");
      stored.status = "CANCELLED_NO_SEND"; pending = null;
    },
  };
  const ports = { session: { cookieHeader: "id_token=fixture-secret", expiresAtMs: 1_000_000 },
    readBinding: async () => ({ ...binding }), repository: repo,
    fetchPort: async (url, init) => {
      assert.equal(url, "https://mercari-shops.com/graphql");
      assert.equal(init.redirect, "manual");
      assert.equal(init.credentials, "omit");
      assert.equal(init.headers.Cookie, ports.session.cookieHeader);
      const body = JSON.parse(init.body); requests.push(body);
      if (body.operationName === "Self") return response({ self: { accountId: "fixture-owner" } });
      if (body.operationName === "OwnShops") return response({ ownShops: [{ id: WEB_HTTP_SHOP_ID }] });
      if (body.operationName === "EditProductPage") {
        state.readCount++;
        if (state.captureStarted && state.authAfterSend) return new Response("", { status: 401 });
        if (state.captureStarted && state.readFailsAfterSend) throw Error("network fixture-secret");
        if (state.changeBeforeClaim && state.readCount === 2) product.variants[0].quantity = 0;
        return response({ ownShops: [{ id: WEB_HTTP_SHOP_ID }], shopProduct: structuredClone(product) });
      }
      if (body.operationName === "ValidateProductInfo")
        return response({ validateProductInfo: { result: !state.validationFail } });
      assert.equal(body.operationName, "UpdateProductV2");
      state.captureStarted = true;
      if (state.timeoutBeforeCommit) throw Error("lost before commit");
      product.status.id = "STATUS_UNOPENED"; product.snapshotId = "revision-2";
      product.variants[0].stockSnapshotId = "stock-2";
      if (state.timeoutAfterCommit) throw Error("lost after commit fixture-secret");
      return response({ updateProductV2: { id: state.ackWrongId ? "Other" : product.id,
        status: { id: "STATUS_UNOPENED" } } });
    } };
  return { ports, repo, attempts, requests, state, clock: () => now,
    advance: value => { now += value; }, product: () => product,
    sends: () => requests.filter(r => r.operationName === "UpdateProductV2") };
}
const run = f => stopObservedWebHttpProductOnce(inventoryId, admin, f.ports, f.clock);
const reconcile = (f, requestId) => reconcileObservedWebHttpProductStop(requestId, admin, f.ports, f.clock);

test("HTTPS stop is stored only after a matching readback; preserves quantity and images", async () => {
  const f = fixture();
  const output = await run(f);
  assert.equal(output.status, "STOP_VERIFIED");
  assert.equal(output.stopConfirmed, true);
  assert.equal(f.sends().length, 1);
  assert.equal(f.attempts.get(output.requestId).status, "PRODUCT_STOP_VERIFIED");
  assert.deepEqual(f.sends()[0].variables.input.assetIds, ["Front", "Back"]);
  assert.equal(f.sends()[0].variables.input.variants[0].quantity, 1);
  assert.equal(f.sends()[0].variables.input.productSnapshotId, "revision-1");
  assert.equal(f.sends()[0].variables.input.variants[0].stockSnapshotId, "stock-1");
  assert.equal(JSON.stringify(output).includes("fixture-secret"), false);
  assert.equal((await run(f)).status, "ALREADY_STOPPED");
  assert.equal(f.sends().length, 1);
});

test("lost mutation response is resolved by readback without a second update", async () => {
  const f = fixture(); f.state.timeoutAfterCommit = true;
  const output = await run(f);
  assert.equal(output.status, "STOP_VERIFIED");
  assert.equal((await reconcile(f, output.requestId)).status, "STOP_VERIFIED");
  assert.equal(f.sends().length, 1);
});

test("unknown result retains product guard across changed revisions and process-style resume", async () => {
  const f = fixture(); f.state.timeoutBeforeCommit = true;
  const output = await run(f);
  assert.equal(output.status, "RESULT_UNKNOWN_NO_RESEND");
  f.product().snapshotId = "external-revision";
  f.advance(120_000);
  const retried = await run(f);
  assert.equal(retried.requestId, output.requestId);
  assert.equal(retried.allowAutomaticResend, false);
  assert.equal(f.sends().length, 1);
});

test("read failure after ACK never confirms stopping or deletion; later read resumes", async () => {
  const f = fixture(); f.state.readFailsAfterSend = true;
  const output = await run(f);
  assert.equal(output.status, "RESULT_UNKNOWN_NO_RESEND");
  assert.equal(output.stopConfirmed, false);
  f.state.readFailsAfterSend = false;
  assert.equal((await reconcile(f, output.requestId)).status, "STOP_VERIFIED");
  assert.equal(f.sends().length, 1);
});

test("authentication expiry after send waits for reauthentication and then reads only", async () => {
  const f = fixture(); f.state.authAfterSend = true;
  const output = await run(f);
  assert.equal(output.status, "AUTH_REQUIRED");
  assert.equal(output.stopConfirmed, false);
  f.state.authAfterSend = false;
  assert.equal((await reconcile(f, output.requestId)).status, "STOP_VERIFIED");
  assert.equal(f.sends().length, 1);
});

test("durable save failure does not report success; reconciliation saves without resending", async () => {
  const f = fixture(); f.state.saveFail = true;
  const output = await run(f);
  assert.equal(output.status, "STORAGE_UNAVAILABLE");
  assert.equal(output.stopConfirmed, false);
  f.state.saveFail = false;
  assert.equal((await reconcile(f, output.requestId)).status, "STOP_VERIFIED");
  assert.equal(f.sends().length, 1);
});

test("changed quantity before claim is never overwritten; expired unclaimed reservation can be released", async () => {
  const f = fixture(); f.state.changeBeforeClaim = true;
  const output = await run(f);
  assert.equal(output.status, "TARGET_CHANGED");
  assert.equal(f.sends().length, 0);
  f.advance(61_000);
  await reconcile(f, output.requestId);
  assert.equal(f.attempts.get(output.requestId).status, "CANCELLED_NO_SEND");
  f.state.changeBeforeClaim = false;
  assert.equal((await run(f)).status, "STOP_VERIFIED");
  assert.equal(f.sends().length, 1);
});

test("expiry during the durable claim never sends", async () => {
  const f = fixture(); f.state.claimExpiry = true;
  assert.equal((await run(f)).status, "RESULT_UNKNOWN_NO_RESEND");
  assert.equal(f.sends().length, 0);
});

test("already stopped, missing link, unknown expiry and rejected validation never update", async () => {
  for (const modify of [
    f => { f.product().status.id = "STATUS_UNOPENED"; },
    f => { f.ports.readBinding = async () => null; },
    f => { f.ports.session.expiresAtMs = null; },
    f => { f.state.validationFail = true; },
    f => { f.product().variants[0].skuCode = "ANOTHER_ITEM"; },
  ]) {
    const f = fixture(); modify(f); await run(f);
    assert.equal(f.sends().length, 0);
    assert.equal(f.attempts.size, 0);
  }
});

test("concurrent clicks perform at most one mutation", async () => {
  const f = fixture();
  await Promise.all([run(f), run(f)]);
  assert.equal(f.sends().length, 1);
});

test("reopened product respects shared interval and uses its new snapshots", async () => {
  const f = fixture(); await run(f);
  f.product().status.id = "STATUS_OPENED"; f.product().snapshotId = "revision-3";
  assert.equal((await run(f)).status, "WAIT_INTERVAL");
  f.advance(61_000);
  assert.equal((await run(f)).status, "STOP_VERIFIED");
  assert.equal(f.sends().length, 2);
  assert.equal(f.sends()[1].variables.input.productSnapshotId, "revision-3");
});
