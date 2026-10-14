import test from "node:test";
import assert from "node:assert/strict";
import { openMercariWebHttpReadOnly, openMercariWebHttpCookieReadOnly } from "./webHttpReadOnlyClient.ts";

const credentials = { idToken: "id+token/one", refreshToken: "refresh+two" };
const targetShop = "evkhihBFFNn5hukMS9s36H";
const draftIds = ["2JXsGZ7vdfvq7bwbM7dAw9", "2JXsGZ5tqLr5Z5SMBXSVUe"];
const cookie = "id_token=opaque; Path=/; Secure; HttpOnly; Max-Age=60";
const response = (body, status = 200, setCookie = null) => {
  const headers = new Headers();
  if (setCookie) headers.append("set-cookie", setCookie);
  return new Response(JSON.stringify(body), { status, headers });
};

test("an existing HTTP session verifies Self without logging in or writing", async () => {
  const calls = [];
  let expired = false;
  const fetchPort = async (url, init) => {
    assert.equal(url, "https://mercari-shops.com/graphql");
    assert.equal(init.redirect, "manual");
    const request = JSON.parse(init.body);
    calls.push(request.operationName);
    if (request.operationName === "Self") return response({ data: { self: {} } });
    if (request.operationName === "OwnShops")
      return response({ data: { ownShops: [{ id: targetShop }] } });
    if (request.operationName === "EditProductPage") {
      assert.equal(request.variables.id, "Product123");
      return expired ? new Response(null, { status: 401 }) :
        response({ data: { ownShops: [{ id: targetShop }], shopProduct: null } });
    }
    throw Error("Unexpected operation");
  };
  const session = { cookieHeader: "id_token=private-cookie; __cf_bm=other-cookie",
    expiresAtMs: 100_000 };
  const opened = await openMercariWebHttpCookieReadOnly(session, { fetchPort, clock: () => 1_000 });
  assert.equal(opened.status, "READY");
  assert.equal((await opened.client.readProduct("Product123")).status, "UNKNOWN");
  await opened.client.verifyTargetShop();
  assert.deepEqual(await opened.client.readProduct("Product123"), { status: "UNKNOWN", product: null });
  expired = true;
  assert.deepEqual(await opened.client.readProduct("Product123"), { status: "AUTH_REQUIRED", product: null });
  assert.deepEqual(calls, ["Self", "OwnShops", "EditProductPage", "EditProductPage"]);
  assert.ok(!JSON.stringify(opened).includes("private-cookie"));
  let attempts = 0;
  for (const input of [
    { cookieHeader: "id_token=secret\r\nInjected: bad", expiresAtMs: null },
    { cookieHeader: "id_token=a; id_token=b", expiresAtMs: null },
    { cookieHeader: "unrelated=a", expiresAtMs: null },
    { cookieHeader: "id_token=a", expiresAtMs: 1_000 },
  ]) {
    const rejected = await openMercariWebHttpCookieReadOnly(input,
      { fetchPort: async () => { attempts++; throw Error("No send"); }, clock: () => 1_000 });
    assert.equal(rejected.status, "AUTH_REQUIRED");
  }
  assert.equal(attempts, 0);
});
function mockSession({ shopId = targetShop, cookieHeader = cookie,
  firstDraftId = draftIds[0] } = {}) {
  const calls = [];
  const fetchPort = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/auth/signin/idp"))
      return response({}, 200, cookieHeader);
    const body = JSON.parse(init.body);
    if (body.operationName === "Self")
      return response({ data: { self: { accountId: "private" } } });
    if (body.operationName === "OwnShops")
      return response({ data: { ownShops: [{ id: shopId }] } });
    if (body.operationName === "GetProductDraft")
      return response({ data: { productDraft: {
        id: body.variables.id === draftIds[0] ? firstDraftId : draftIds[1]
      } } });
    throw Error("Unexpected operation");
  };
  return { calls, fetchPort };
}

test("fixed read-only route verifies Self, shop and the two known drafts", async () => {
  const { calls, fetchPort } = mockSession();
  const opened = await openMercariWebHttpReadOnly(credentials, { fetchPort,
    clock: () => 1_000 });
  assert.equal(opened.status, "READY");
  assert.equal(opened.cookieExpiryKnown, true);
  assert.deepEqual(await opened.client.readKnownB005396Drafts(), {
    status: "SHOP_MISMATCH", correctDraftMatched: false,
    emptyDraftMatched: false });
  assert.deepEqual(await opened.client.verifyTargetShop(), {
    status: "VERIFIED", shopMatched: true });
  assert.deepEqual(await opened.client.readKnownB005396Drafts(), {
    status: "VERIFIED", correctDraftMatched: true,
    emptyDraftMatched: true });
  assert.deepEqual(calls.map(call => call.url), [
    "https://mercari-shops.com/auth/signin/idp",
    ...Array(4).fill("https://mercari-shops.com/graphql")]);
  assert.ok(calls.every(call => call.init.method === "POST" &&
    call.init.redirect === "manual"));
  assert.equal(new URLSearchParams(calls[0].init.body).get("idToken"),
    encodeURIComponent(credentials.idToken));
  assert.deepEqual(calls.slice(1).map(call =>
    JSON.parse(call.init.body).operationName),
    ["Self", "OwnShops", "GetProductDraft", "GetProductDraft"]);
  assert.deepEqual(calls.slice(3).map(call =>
    JSON.parse(call.init.body).variables.id), draftIds);
  assert.ok(!JSON.stringify(opened).includes(credentials.idToken));
  assert.ok(!JSON.stringify(opened).includes("opaque"));
});

test("unknown shop and draft mismatch stop further reads", async () => {
  const wrong = mockSession({ shopId: "another-shop" });
  const opened = await openMercariWebHttpReadOnly(credentials,
    { fetchPort: wrong.fetchPort });
  assert.equal((await opened.client.verifyTargetShop()).status,
    "SHOP_MISMATCH");
  assert.equal((await opened.client.readKnownB005396Drafts()).status,
    "SHOP_MISMATCH");
  assert.equal(wrong.calls.length, 3);

  const draft = mockSession({ firstDraftId: "other-draft" });
  const other = await openMercariWebHttpReadOnly(credentials,
    { fetchPort: draft.fetchPort });
  await other.client.verifyTargetShop();
  assert.equal((await other.client.readKnownB005396Drafts()).status,
    "REMOTE_UNVERIFIED");
  assert.equal(draft.calls.length, 4);
});

test("created draft readback requires verified shop and one SKU variant", async () => {
  const id = "Draft123456";
  const calls = [];
  let variant = { skuCode: "BELLO_123" };
  const fetchPort = async (url, init) => {
    if (url.endsWith("/auth/signin/idp"))
      return response({}, 200, cookie);
    const request = JSON.parse(init.body);
    calls.push(request.operationName);
    if (request.operationName === "Self")
      return response({ data: { self: { accountId: "private" } } });
    if (request.operationName === "OwnShops")
      return response({ data: { ownShops: [{ id: targetShop }] } });
    if (request.operationName === "GetProductDraft")
      return response({ data: { productDraft: { id: request.variables.id,
        name: "Fixture sofa", description: "Fixture description",
        variants: [variant] } } });
    throw Error("Unexpected operation");
  };
  const opened = await openMercariWebHttpReadOnly(credentials, { fetchPort });
  assert.equal((await opened.client.readVerifiedCreatedDraft(id)).status,
    "UNKNOWN");
  assert.deepEqual(calls, ["Self"]);
  assert.equal((await opened.client.verifyTargetShop()).status, "VERIFIED");
  assert.deepEqual(await opened.client.readVerifiedCreatedDraft(id), {
    status: "VERIFIED", shopId: targetShop, draftId: id,
    skuCode: "BELLO_123", name: "Fixture sofa",
    description: "Fixture description" });
  variant = { skuCode: null };
  assert.equal((await opened.client.readVerifiedCreatedDraft(id)).status,
    "UNKNOWN");
});

test("updated draft readback extracts all required saved fields", async () => {
  const id = "Draft123456";
  let changed = {};
  const fetchPort = async (url, init) => {
    if (url.endsWith("/auth/signin/idp"))
      return response({}, 200, cookie);
    const request = JSON.parse(init.body);
    if (request.operationName === "Self")
      return response({ data: { self: { accountId: "private" } } });
    if (request.operationName === "OwnShops")
      return response({ data: { ownShops: [{ id: targetShop }] } });
    if (request.operationName === "GetProductDraft")
      return response({ data: { productDraft: { id, name: "Fixture sofa",
        description: "Fixture description", price: 46900,
        variants: [{ skuCode: "BELLO_123", quantity: 1 }],
        categories: [{ category: [{ id: "furniture" },
          { id: "sofa" }, { id: "furniture_sofa" }] }],
        thumbnails: [{ id: "Asset123" }],
        brands: [],
        condition: { id: "CONDITION_CLEAN" },
        shippingMethodType: { id: "METHOD_TYPE_UNDECIDED" },
        shippingPayerType: { id: "PAYER_TYPE_SELLER" },
        shippingDurationType: { id: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" },
        shippingFromState: { id: "jp11" }, ...changed } } });
    throw Error("Unexpected operation");
  };
  const opened = await openMercariWebHttpReadOnly(credentials, { fetchPort });
  assert.equal((await opened.client.readVerifiedUpdatedDraft(id)).status,
    "UNKNOWN");
  await opened.client.verifyTargetShop();
  assert.deepEqual(await opened.client.readVerifiedUpdatedDraft(id), {
    status: "VERIFIED", shopId: targetShop, draftId: id,
    skuCode: "BELLO_123", name: "Fixture sofa",
    description: "Fixture description", price: 46900, quantity: 1,
    categoryId: "furniture_sofa", conditionId: "CONDITION_CLEAN",
    imageAssetIds: ["Asset123"], brandIds: [],
    shippingMethodId: "METHOD_TYPE_UNDECIDED",
    shippingPayerId: "PAYER_TYPE_SELLER",
    shippingDurationId: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS",
    shippingFromStateId: "jp11" });
  changed = { thumbnails: [{ id: null }] };
  assert.equal((await opened.client.readVerifiedUpdatedDraft(id)).status,
    "UNKNOWN");
  changed = { brands: [{ id: "Brand1" }], condition: { id: "CONDITION_DIRTY" } };
  const branded = await opened.client.readVerifiedUpdatedDraft(id);
  assert.equal(branded.status, "VERIFIED");
  assert.deepEqual(branded.brandIds, ["Brand1"]);
  assert.equal(branded.conditionId, "CONDITION_DIRTY");
  for (const brands of [undefined, null, [{}], [{ id: null }], [{ id: "Brand1" }, { id: "Brand2" }]]) {
    changed = { brands };
    assert.equal((await opened.client.readVerifiedUpdatedDraft(id)).status, "UNKNOWN");
  }
  for (const categories of [[], [{ category: [] }],
    [{ category: { id: "furniture_sofa" } }],
    [{ category: [{ id: "furniture" }, { id: null }] }],
    [{ category: [{ id: "same" }, { id: "same" }] }],
    [{ category: [{ id: "first" }] }, { category: [{ id: "second" }] }]]) {
    changed = { categories };
    assert.equal((await opened.client.readVerifiedUpdatedDraft(id)).status,
      "UNKNOWN");
  }
});

test("redirect, missing or expired cookie, and expired session fail closed", async () => {
  const redirected = [];
  const redirectResult = await openMercariWebHttpReadOnly(credentials, {
    fetchPort: async (url, init) => {
      redirected.push({ url, init });
      return new Response(null, { status: 302,
        headers: { location: "https://example.net/other" } });
    }
  });
  assert.equal(redirectResult.status, "REMOTE_UNVERIFIED");
  assert.equal(redirectResult.failureStage, "IDP_HTTP");
  assert.equal(redirectResult.httpStatus, 302);
  assert.equal(redirected.length, 1);
  assert.equal(redirected[0].init.redirect, "manual");
  for (const badCookie of [null,
    "id_token=opaque; Path=/; Secure; Max-Age=0",
    "id_token=opaque; Path=/auth; Secure; Max-Age=60",
    "id_token=opaque; Path=/; Secure; Domain=example.net"]) {
    const { calls, fetchPort } = mockSession({ cookieHeader: badCookie });
    const result = await openMercariWebHttpReadOnly(credentials,
      { fetchPort, clock: () => 1_000 });
    assert.equal(result.status, "COOKIE_UNVERIFIED");
    assert.equal(result.failureStage, "IDP_COOKIE");
    assert.ok(result.cookieIssue);
    assert.equal(calls.length, 1);
  }
  const noSecure = mockSession({ cookieHeader:
    "id_token=opaque; Path=/; HttpOnly; Max-Age=60" });
  assert.equal((await openMercariWebHttpReadOnly(credentials,
    { fetchPort: noSecure.fetchPort })).status, "READY");
  const duplicateHeaders = new Headers();
  duplicateHeaders.append("set-cookie", cookie);
  duplicateHeaders.append("set-cookie", cookie);
  const duplicate = await openMercariWebHttpReadOnly(credentials, {
    fetchPort: async () => new Response("{}", {
      status: 200, headers: duplicateHeaders }) });
  assert.equal(duplicate.cookieIssue, "ID_COOKIE_DUPLICATE");
  let now = 1_000;
  const expiry = mockSession({ cookieHeader:
    "id_token=opaque; Path=/; Secure; Max-Age=2" });
  const opened = await openMercariWebHttpReadOnly(credentials, {
    fetchPort: expiry.fetchPort, clock: () => now });
  assert.equal(opened.status, "READY");
  now = 3_000;
  assert.equal((await opened.client.verifyTargetShop()).status,
    "REMOTE_UNVERIFIED");
  assert.equal(expiry.calls.length, 2);
});

test("401/403 with empty or HTML bodies retain AUTH_REQUIRED at each read", async () => {
  for (const operation of ["Self", "OwnShops", "GetProductDraft"]) {
    for (const status of [401, 403]) {
      const calls = [];
      const fetchPort = async (url, init) => {
        if (url.endsWith("/auth/signin/idp"))
          return response({}, 200, cookie);
        const request = JSON.parse(init.body);
        calls.push(request.operationName);
        if (request.operationName === operation)
          return new Response(status === 401 ? null : "<html>sign in</html>",
            { status, headers: status === 403 ?
              { "Content-Type": "text/html" } : {} });
        if (request.operationName === "Self")
          return response({ data: { self: { accountId: "private" } } });
        if (request.operationName === "OwnShops")
          return response({ data: { ownShops: [{ id: targetShop }] } });
        throw Error("Unexpected read");
      };
      const opened = await openMercariWebHttpReadOnly(credentials,
        { fetchPort });
      if (operation === "Self") {
        assert.equal(opened.status, "AUTH_REQUIRED");
        assert.equal(opened.failureStage, "SELF_READ");
        assert.equal(opened.httpStatus, status);
        assert.deepEqual(calls, ["Self"]);
      } else if (operation === "OwnShops") {
        assert.equal((await opened.client.verifyTargetShop()).status,
          "AUTH_REQUIRED");
        assert.deepEqual(calls, ["Self", "OwnShops"]);
      } else {
        assert.equal((await opened.client.verifyTargetShop()).status,
          "VERIFIED");
        assert.equal((await opened.client.readKnownB005396Drafts()).status,
          "AUTH_REQUIRED");
        assert.deepEqual(calls, ["Self", "OwnShops", "GetProductDraft"]);
      }
    }
  }
});

test("GraphQL 200 auth errors require reauthentication at every read", async () => {
  for (const operation of ["Self", "OwnShops", "GetProductDraft"]) {
    const calls = [];
    const fetchPort = async (url, init) => {
      if (url.endsWith("/auth/signin/idp"))
        return response({}, 200, cookie);
      const request = JSON.parse(init.body);
      calls.push(request.operationName);
      if (request.operationName === operation)
        return response({ errors: [{ extensions: {
          code: "UNAUTHENTICATED" } }] });
      if (request.operationName === "Self")
        return response({ data: { self: { accountId: "private" } } });
      if (request.operationName === "OwnShops")
        return response({ data: { ownShops: [{ id: targetShop }] } });
      throw Error("Unexpected read");
    };
    const opened = await openMercariWebHttpReadOnly(credentials,
      { fetchPort });
    if (operation === "Self") {
      assert.equal(opened.status, "AUTH_REQUIRED");
      assert.equal(opened.failureStage, "SELF_READ");
      assert.equal(opened.httpStatus, 200);
      assert.deepEqual(calls, ["Self"]);
    } else if (operation === "OwnShops") {
      assert.equal((await opened.client.verifyTargetShop()).status,
        "AUTH_REQUIRED");
      assert.deepEqual(calls, ["Self", "OwnShops"]);
    } else {
      assert.equal((await opened.client.verifyTargetShop()).status,
        "VERIFIED");
      assert.equal((await opened.client.readKnownB005396Drafts()).status,
        "AUTH_REQUIRED");
      assert.deepEqual(calls, ["Self", "OwnShops", "GetProductDraft"]);
    }
  }
});

test("login diagnostics expose only stage and HTTP status", async () => {
  const network = await openMercariWebHttpReadOnly(credentials, {
    fetchPort: async () => { throw Error("secret-bearing network failure"); }
  });
  assert.equal(network.status, "REMOTE_UNVERIFIED");
  assert.equal(network.failureStage, "IDP_NETWORK");
  assert.equal(network.httpStatus, null);
  assert.equal(network.client, null);
  const bad = await openMercariWebHttpReadOnly(credentials, {
    fetchPort: async () => new Response(null, { status: 503 }) });
  assert.equal(bad.failureStage, "IDP_HTTP");
  assert.equal(bad.httpStatus, 503);
  assert.ok(!JSON.stringify(bad).includes(credentials.idToken));
  assert.ok(!JSON.stringify(bad).includes(credentials.refreshToken));
});
