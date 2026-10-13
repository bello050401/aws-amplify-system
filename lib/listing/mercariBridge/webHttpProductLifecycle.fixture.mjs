import assert from "node:assert/strict";
import { WEB_HTTP_SHOP_ID } from "./webHttpDraftJob.ts";
export const inventoryId = "1fa6d72b-306f-4af8-bfc8-a4bd4435eb33";
export const admin = "admin@example.com";
export const binding = { inventoryId, shopId: WEB_HTTP_SHOP_ID,
  remoteProductId: "FixtureProduct", managementCode: "BELLO_FIXTURE" };
export function fixture() {
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
    captureStarted: false, releaseSend: null, canReopen: true, changeStockAfterClaim: false };
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
      if (state.changeStockAfterClaim) state.canReopen = false;
    },
    verifyProductStop: async (id, attemptId, shopId, productId, fingerprint, _now, desiredStatus = "STATUS_UNOPENED") => {
      const attempt = attempts.get(id);
      if (state.saveFail || attempt?.status !== "SEND_CLAIMED_RESULT_UNKNOWN" ||
          attempt.attemptId !== attemptId || shopId !== WEB_HTTP_SHOP_ID ||
          productId !== binding.remoteProductId || attempt.productContentFingerprint !== fingerprint ||
          pending !== id) throw Error("save unavailable");
      attempt.status = desiredStatus === "STATUS_OPENED" ? "PRODUCT_REOPEN_VERIFIED" : "PRODUCT_STOP_VERIFIED"; pending = null;
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
    canReopen: async () => state.canReopen,
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
      product.status.id = body.variables.input.status; product.snapshotId = "revision-2";
      product.variants[0].stockSnapshotId = "stock-2";
      if (state.timeoutAfterCommit) throw Error("lost after commit fixture-secret");
      return response({ updateProductV2: { id: state.ackWrongId ? "Other" : product.id,
        status: { id: "STATUS_UNOPENED" } } });
    } };
  return { ports, repo, attempts, requests, state, clock: () => now,
    advance: value => { now += value; }, product: () => product,
    sends: () => requests.filter(r => r.operationName === "UpdateProductV2") };
}
