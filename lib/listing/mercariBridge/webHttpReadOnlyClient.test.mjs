import test from "node:test";
import assert from "node:assert/strict";
import { openMercariWebHttpReadOnly } from "./webHttpReadOnlyClient.ts";

const credentials = { idToken: "id+token/one", refreshToken: "refresh+two" };
const targetShop = "evkhihBFFNn5hukMS9s36H";
const draftIds = ["2JXsGZ7vdfvq7bwbM7dAw9", "2JXsGZ5tqLr5Z5SMBXSVUe"];
const cookie = "id_token=opaque; Path=/; Secure; HttpOnly; Max-Age=60";
const response = (body, status = 200, setCookie = null) => {
  const headers = new Headers();
  if (setCookie) headers.append("set-cookie", setCookie);
  return new Response(JSON.stringify(body), { status, headers });
};
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
  assert.equal(redirected.length, 1);
  assert.equal(redirected[0].init.redirect, "manual");
  for (const badCookie of [null,
    "id_token=opaque; Path=/; Secure; Max-Age=0",
    "id_token=opaque; Path=/; Max-Age=60",
    "id_token=opaque; Path=/; Secure; Domain=example.net"]) {
    const { calls, fetchPort } = mockSession({ cookieHeader: badCookie });
    const result = await openMercariWebHttpReadOnly(credentials,
      { fetchPort, clock: () => 1_000 });
    assert.equal(result.status, "COOKIE_UNVERIFIED");
    assert.equal(calls.length, 1);
  }
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
