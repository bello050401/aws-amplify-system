import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { observeShopsReadQueries, safeReadQueryCandidates } from "../src/readQueryObservation.mjs";

test("one exact read query yields only operation, shape, identity matches and header presence", async () => {
  const context = new EventEmitter();
  const page = {};
  const request = {
    frame: () => ({ page: () => page }),
    method: () => "POST", resourceType: () => "fetch",
    url: () => "https://mercari-shops.com/graphql",
    postDataBuffer: () => Buffer.from(JSON.stringify({
      query: "query ProductEditQuery($productId: ID!) { product(id: $productId) { id } }",
      variables: { productId: "product1", shopId: "shop1", secretToken: "do-not-store" },
    })),
    headerValue: async name => ({ authorization: "Bearer do-not-store",
      cookie: "session=do-not-store", "x-csrf-token": "do-not-store" })[name] ?? null,
  };
  const response = { request: () => request, status: () => 200,
    headerValue: async name => name === "content-type" ? "application/json" : null,
    body: async () => Buffer.from(JSON.stringify({ data: { product: {
      id: "product1", shopId: "shop1", email: "do-not-store@example.com",
    } }, errors: [] })),
  };
  const observer = observeShopsReadQueries(context, { shopId: "shop1", remoteId: "product1", page });
  context.emit("request", request);
  context.emit("response", response);
  const entries = await observer.stop();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].operationName, "ProductEditQuery");
  assert.equal(entries[0].requestProductMatch, "MATCH");
  assert.equal(entries[0].requestShopMatch, "MATCH");
  assert.equal(entries[0].responseProductMatch, "MATCH");
  assert.equal(entries[0].responseShopMatch, "MATCH");
  assert.equal(entries[0].graphqlErrors, "NONE");
  assert.equal(entries[0].variableShapeComplete, false);
  assert.deepEqual(entries[0].authPresence,
    { authorization: true, cookie: true, csrf: true });
  assert.equal(entries[0].authPresenceObserved, true);
  assert.deepEqual(entries[0].variableFields,
    [{ field: "productId", type: "string" }, { field: "shopId", type: "string" }]);
  const stored = JSON.stringify(entries);
  assert.equal(stored.includes("do-not-store"), false);
  assert.equal(stored.includes("product1"), false);
  assert.equal(stored.includes("shop1"), false);
  assert.equal(stored.includes("query ProductEditQuery"), false);
});

test("mutation, external host and malformed candidate never become read evidence", async () => {
  const context = new EventEmitter();
  const page = {};
  const observer = observeShopsReadQueries(context, { shopId: "shop1", remoteId: "product1", page });
  const request = (url, query) => ({ method: () => "POST", resourceType: () => "fetch",
    frame: () => ({ page: () => page }),
    url: () => url, postDataBuffer: () => Buffer.from(JSON.stringify({ query })) });
  context.emit("request", request("https://mercari-shops.com/graphql", "mutation Save { save }"));
  context.emit("request", request("https://other.example/graphql", "query Product { product { id } }"));
  context.emit("request", { ...request("https://mercari-shops.com/graphql",
    "query Product { product { id } }"), frame: () => ({ page: () => ({}) }) });
  assert.deepEqual(await observer.stop(), []);
  assert.deepEqual(safeReadQueryCandidates([{ method: "POST", host: "mercari-shops.com",
    path: "/graphql", operationType: "mutation" }]), []);
});

test("selected mutation, multiple operations, name mismatch and other product are rejected", async () => {
  const context = new EventEmitter();
  const page = {};
  const observer = observeShopsReadQueries(context, { shopId: "shop1", remoteId: "product1", page });
  const send = (query, operationName, productId = "product1") => context.emit("request", {
    frame: () => ({ page: () => page }), method: () => "POST", resourceType: () => "fetch",
    url: () => "https://mercari-shops.com/graphql",
    postDataBuffer: () => Buffer.from(JSON.stringify({ query, operationName,
      variables: { productId, shopId: "shop1" } })),
    headerValue: async () => null,
  });
  send("query ReadProduct { product { id } } mutation UpdateProduct { updateProduct { id } }",
    "UpdateProduct");
  send("query ReadProduct { product { id } } query OtherProduct { product { id } }",
    "ReadProduct");
  send("query ReadProduct { product { id } }", "WrongName");
  send("query ReadProduct { product { id } }", "ReadProduct", "otherProduct");
  assert.deepEqual(await observer.stop(), []);
});

test("failed header observation remains unconfirmed and a matching response can identify a read", async () => {
  const context = new EventEmitter();
  const page = {};
  const request = {
    frame: () => ({ page: () => page }), method: () => "POST", resourceType: () => "fetch",
    url: () => "https://mercari-shops.com/graphql",
    postDataBuffer: () => Buffer.from(JSON.stringify({
      query: "query ReadProduct { product { id } }", variables: {},
    })),
    headerValue: async () => { throw Error("header unavailable"); },
  };
  const response = { request: () => request, status: () => 200,
    headerValue: async name => name === "content-type" ? "application/json" : null,
    body: async () => Buffer.from(JSON.stringify({ data: { product: { id: "product1" } } })),
  };
  const observer = observeShopsReadQueries(context, { shopId: "shop1", remoteId: "product1", page });
  context.emit("request", request);
  context.emit("response", response);
  const entries = await observer.stop();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].responseProductMatch, "MATCH");
  assert.equal(entries[0].authPresenceObserved, false);
  assert.deepEqual(entries[0].authPresence,
    { authorization: false, cookie: false, csrf: false });
});
