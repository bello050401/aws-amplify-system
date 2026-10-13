import test from "node:test";
import assert from "node:assert/strict";
import { probeMercariWebHttpProductRead } from "./webHttpReadOnlyProbe.ts";
import { WEB_HTTP_SHOP_ID } from "./webHttpDraftJob.ts";

const session = { cookieHeader: "id_token=SECRET_NEVER_RETURN", expiresAtMs: 100_000 };
const json = data => new Response(JSON.stringify({ data }), {
  headers: { "content-type": "application/json" } });

test("probe uses only fixed HTTPS reads and returns no session or remote error text", async () => {
  const calls = [];
  const result = await probeMercariWebHttpProductRead(session, "Product123", {
    clock: () => 1_000, fetchPort: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body.operationName);
      assert.equal(url, "https://mercari-shops.com/graphql");
      assert.equal(init.redirect, "manual");
      assert.match(body.query, /^query\s/);
      if (body.operationName === "Self") return json({ self: { accountId: "private" } });
      if (body.operationName === "OwnShops") return json({ ownShops: [{ id: WEB_HTTP_SHOP_ID }] });
      return new Response(JSON.stringify({ errors: [{ message: "SECRET_REMOTE_ERROR" }] }));
    },
  });
  assert.deepEqual(calls, ["Self", "OwnShops", "EditProductPage"]);
  assert.equal(result.status, "READ_UNVERIFIED");
  assert.equal(result.stage, "PRODUCT");
  assert.equal(result.shopMatched, true);
  assert.equal(result.productVerified, false);
  assert.ok(!JSON.stringify(result).includes("SECRET"));
  assert.ok(!JSON.stringify(result).includes("private"));
});

test("cloud challenge is reported separately and never retried", async () => {
  let calls = 0;
  const result = await probeMercariWebHttpProductRead(session, "Product123", {
    clock: () => 1_000, fetchPort: async () => {
      calls++;
      return new Response("PRIVATE_CHALLENGE_BODY", { status: 403,
        headers: { "cf-mitigated": "challenge", "content-type": "text/html" } });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "REMOTE_CHALLENGE");
  assert.equal(result.requests[0].httpStatus, 403);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_CHALLENGE_BODY"));
});

test("known expired credentials, invalid targets, wrong shops and failed reads stop the probe", async () => {
  let calls = 0;
  const options = { clock: () => 100_000, fetchPort: async () => { calls++; throw Error("private"); } };
  assert.equal((await probeMercariWebHttpProductRead(session, "Product123", options)).status, "AUTH_REQUIRED");
  assert.equal((await probeMercariWebHttpProductRead(session, "https://other", options)).status, "INVALID_INPUT");
  assert.equal(calls, 0);
  const wrongShop = await probeMercariWebHttpProductRead(session, "Product123", {
    clock: () => 1_000, fetchPort: async (_url, init) => {
      const op = JSON.parse(init.body).operationName;
      return json(op === "Self" ? { self: {} } : { ownShops: [{ id: "different" }] });
    },
  });
  assert.equal(wrongShop.status, "SHOP_MISMATCH");
  assert.equal(wrongShop.requests.length, 2);
  const network = await probeMercariWebHttpProductRead(session, "Product123", { ...options, clock: () => 1_000 });
  assert.equal(network.status, "READ_UNVERIFIED");
  assert.ok(!JSON.stringify(network).includes("private"));
});
