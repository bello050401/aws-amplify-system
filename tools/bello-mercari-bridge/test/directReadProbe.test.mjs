import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { observeExactReadForDirectProbe } from "../src/directReadProbeObserver.mjs";
import { directReadProbeAvailable, PINNED_READ_QUERY_SHA256,
  readDirectReadProbeOutcome, runPinnedDirectReadProbeOnce } from "../src/directReadProbe.mjs";
import { saveReadTrafficEvidence } from "../src/trafficEvidence.mjs";

const query = "query EditProductPage($id: ID!) { product(id: $id) { id shopId } }";
const querySha256 = createHash("sha256").update(query).digest("hex");
const remoteId = "2JXePE4ke8UCBTj6mxc4cf";
const shopId = "shop1";

function normalTraffic(context, page, {
  readQuery = query, productId = remoteId, errors = [], requestId = remoteId,
} = {}) {
  const request = {
    frame: () => ({ page: () => page }), method: () => "POST", resourceType: () => "fetch",
    url: () => "https://mercari-shops.com/graphql",
    postDataBuffer: () => Buffer.from(JSON.stringify({ query: readQuery,
      operationName: "EditProductPage", variables: { id: requestId } })),
    headerValue: async name => {
      if (name !== "content-type") throw Error("Credential headers must not be read");
      return "application/json";
    },
  };
  const response = { request: () => request, status: () => 200,
    headerValue: async name => name === "content-type" ? "application/json" : null,
    body: async () => Buffer.from(JSON.stringify({ data: { product: {
      id: productId, shopId,
    } }, errors })),
  };
  context.emit("request", request);
  context.emit("response", response);
}

test("one pinned normal query permits one same-context HTTP read, without credential extraction", async () => {
  const context = new EventEmitter();
  const page = {};
  let sent = 0;
  let sentBuffer;
  context.request = { post: async (url, options) => {
    sent++;
    assert.equal(url, "https://mercari-shops.com/graphql");
    assert.equal(options.maxRedirects, 0);
    assert.deepEqual(Object.keys(options.headers), ["content-type"]);
    sentBuffer = options.data;
    assert.equal(JSON.parse(sentBuffer.toString()).variables.id, remoteId);
    return { status: () => 200, headers: () => ({ "content-type": "application/json" }),
      body: async () => Buffer.from(JSON.stringify({ data: { product: {
        id: remoteId, shopId,
      } } })),
    };
  } };
  const observer = observeExactReadForDirectProbe(context,
    { page, shopId, remoteId, querySha256, waitMs: 20 });
  normalTraffic(context, page);
  assert.deepEqual(await observer.probe(), { outcome: "MATCHED", httpStatus: 200 });
  assert.equal(sent, 1);
  assert.equal(sentBuffer.every(byte => byte === 0), true);
});

test("an unpinned query or mismatched normal response cannot send direct HTTP", async () => {
  for (const traffic of [
    { readQuery: "query EditProductPage { product { id } }" },
    { productId: "otherProduct" },
    { errors: [{ message: "do-not-store" }] },
    { requestId: "otherProduct" },
  ]) {
    const context = new EventEmitter();
    const page = {};
    let sent = 0;
    context.request = { post: async () => { sent++; throw Error("must not send"); } };
    const observer = observeExactReadForDirectProbe(context,
      { page, shopId, remoteId, querySha256, waitMs: 20 });
    normalTraffic(context, page, traffic);
    const result = await observer.probe();
    assert.notEqual(result.outcome, "MATCHED");
    assert.equal(sent, 0);
    assert.equal(JSON.stringify(result).includes("do-not-store"), false);
  }
});

test("direct HTTP 403 and wrong product are never reported as matched", async () => {
  for (const directResponse of [
    { status: 403, body: {} },
    { status: 200, body: { data: { product: { id: "otherProduct", shopId } } } },
  ]) {
    const context = new EventEmitter();
    const page = {};
    context.request = { post: async () => ({ status: () => directResponse.status,
      headers: () => ({ "content-type": "application/json" }),
      body: async () => Buffer.from(JSON.stringify(directResponse.body)) }) };
    const observer = observeExactReadForDirectProbe(context,
      { page, shopId, remoteId, querySha256, waitMs: 20 });
    normalTraffic(context, page);
    const result = await observer.probe();
    assert.equal(result.outcome, directResponse.status === 403 ?
      "DIRECT_AUTH_REQUIRED" : "DIRECT_RESPONSE_UNVERIFIED");
  }
});

test("pinned proof needs prior evidence and keeps one durable attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-direct-probe-"));
  const profileDir = join(root, "ShopsChrome");
  const requestId = "a".repeat(64);
  const target = { shopId, remoteId, inventoryCode: "B005795" };
  try {
    assert.equal(await directReadProbeAvailable(root, requestId, target), false);
    await saveReadTrafficEvidence(root, requestId,
      "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", [], [{
        method: "POST", host: "mercari-shops.com", path: "/graphql",
        operationType: "query", operationName: "EditProductPage",
        querySha256: PINNED_READ_QUERY_SHA256,
        variableFields: [{ field: "id", type: "string" }], variableShapeComplete: true,
        requestProductMatch: "MATCH", requestShopMatch: "UNOBSERVED",
        responseProductMatch: "MATCH", responseShopMatch: "MATCH",
        graphqlErrors: "NONE", httpStatus: 200, authPresenceObserved: true,
        authPresence: { authorization: false, cookie: true, csrf: false },
      }]);
    assert.equal(await directReadProbeAvailable(root, requestId, target), true);
    const launchPersistentContext = async () => {
      const context = new EventEmitter();
      const page = { url: () => `https://mercari-shops.com/seller/shops/${shopId}/products/${remoteId}/edit`,
        goto: async () => {},
      };
      context.pages = () => [page];
      context.close = async () => {};
      context.request = { post: async () => { throw Error("synthetic direct request blocked"); } };
      return context;
    };
    const result = await runPinnedDirectReadProbeOnce({ root, profileDir, requestId, target,
      launchPersistentContext, probeWaitMs: 20 });
    assert.equal(result.outcome, "NO_EXACT_NORMAL_READ");
    assert.deepEqual(await readDirectReadProbeOutcome(root, target),
      { claimed: true, outcome: "NO_EXACT_NORMAL_READ", httpStatus: null });
    assert.equal(await directReadProbeAvailable(root, requestId, target), false);
    await assert.rejects(runPinnedDirectReadProbeOnce({ root, profileDir, requestId, target,
      launchPersistentContext, probeWaitMs: 20 }), /EEXIST/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("B005757 has its own fixed request, evidence, and one-time read claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-b005757-direct-read-"));
  const requestId = "7ecb7f7837d93390fe5f701abdc62e9acfaf5b35b4b751789c4183a2a376e825";
  const target = { shopId: "evkhihBFFNn5hukMS9s36H",
    remoteId: "2JXjWPRVBxjZ2K2vgTGNqy", inventoryCode: "B005757" };
  try {
    assert.equal(await directReadProbeAvailable(root, requestId, target), false);
    await saveReadTrafficEvidence(root, requestId,
      "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", [], [{
        method: "POST", host: "mercari-shops.com", path: "/graphql",
        operationType: "query", operationName: "EditProductPage",
        querySha256: PINNED_READ_QUERY_SHA256,
        variableFields: [{ field: "id", type: "string" }], variableShapeComplete: true,
        requestProductMatch: "MATCH", requestShopMatch: "UNOBSERVED",
        responseProductMatch: "MATCH", responseShopMatch: "MATCH",
        graphqlErrors: "NONE", httpStatus: 200, authPresenceObserved: true,
        authPresence: { authorization: false, cookie: true, csrf: false },
      }]);
    assert.equal(await directReadProbeAvailable(root, requestId, target), true);
    await assert.rejects(directReadProbeAvailable(root, "a".repeat(64), target));
    await assert.rejects(directReadProbeAvailable(root, requestId,
      { ...target, shopId: "other-shop" }));
    await assert.rejects(directReadProbeAvailable(root, requestId,
      { ...target, inventoryCode: "B005795" }));
    const result = await runPinnedDirectReadProbeOnce({ root,
      profileDir: join(root, "ShopsChrome"), requestId, target, probeWaitMs: 20,
      launchPersistentContext: async () => {
        const context = new EventEmitter();
        context.pages = () => [{ goto: async () => {},
          url: () => `https://mercari-shops.com/seller/shops/${target.shopId}/products/${target.remoteId}/edit` }];
        context.close = async () => {};
        context.request = { post: async () => { throw Error("must not send"); } };
        return context;
      },
    });
    assert.deepEqual(result, { outcome: "NO_EXACT_NORMAL_READ", httpStatus: null });
    assert.equal(await directReadProbeAvailable(root, requestId, target), false);
    assert.deepEqual(await readDirectReadProbeOutcome(root, target),
      { claimed: true, outcome: "NO_EXACT_NORMAL_READ", httpStatus: null });
  } finally { await rm(root, { recursive: true, force: true }); }
});
