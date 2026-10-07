import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { observeDraftReadMetadata,
  classifyDraftReadRouteBlock } from "../src/draftReadMetadataObserver.mjs";

const shopId = "evkhihBFFNn5hukMS9s36H";
const listUrl = `https://mercari-shops.com/seller/shops/${shopId}/products?tab=draft`;
const detailUrl = `https://mercari-shops.com/seller/shops/${shopId}/products/create?productDraftId=draftABC`;
const secret = "secret-cookie-token-value";

function request(page, operationName = "DraftProductsPage", type = "query") {
  const payload = { operationName,
    query: `${type} ${operationName} { draftProducts { id title } }`,
    variables: { token: secret, id: "private-draft-id" } };
  return { method: () => "POST", resourceType: () => "fetch",
    url: () => "https://mercari-shops.com/graphql",
    frame: () => ({ page: () => page }),
    postDataBuffer: () => Buffer.from(JSON.stringify(payload)) };
}

function response(req, data = { draftProducts: [{ id: secret,
  title: secret, skuCode: secret }] }) {
  return { request: () => req, status: () => 200,
    headerValue: async () => "application/json; charset=utf-8",
    body: async () => Buffer.from(JSON.stringify({ data, errors: [] })) };
}

test("captures fixed query class and response structure without request or response values", async () => {
  const context = new EventEmitter();
  const page = { url: () => listUrl };
  const observer = observeDraftReadMetadata(context, { page, shopId });
  const req = request(page);
  context.emit("request", req);
  context.emit("response", response(req));
  const result = await observer.stop();
  assert.equal(result.status, "METADATA_ONLY");
  assert.equal(result.allowFinalCreate, false);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].pageKind, "DRAFT_LIST");
  assert.equal(result.observations[0].operationClass, "NAMED_QUERY");
  assert.equal(JSON.stringify(result).includes("DraftProductsPage"), false);
  assert.equal(result.observations[0].responseShape.typeCounts.array, 1);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes("private-draft-id"), false);
  assert.equal(context.listenerCount("request"), 0);
  assert.equal(context.listenerCount("response"), 0);
});

test("captures exact draft detail query and ignores mutations or another page", async () => {
  const context = new EventEmitter();
  let currentUrl = detailUrl;
  const page = { url: () => currentUrl };
  const observer = observeDraftReadMetadata(context, { page, shopId });
  const mutation = request(page, "SaveDraft", "mutation");
  context.emit("request", mutation);
  context.emit("response", response(mutation));
  currentUrl = `https://mercari-shops.com/seller/shops/${shopId}/products?tab=on_sale`;
  const wrongPage = request(page);
  context.emit("request", wrongPage);
  context.emit("response", response(wrongPage));
  currentUrl = detailUrl;
  const read = request(page, "EditProductPage");
  context.emit("request", read);
  context.emit("response", response(read, { productDraft: { id: secret,
    skuCode: secret } }));
  const result = await observer.stop();
  assert.deepEqual(result.observations.map(item =>
    [item.pageKind, item.operationClass]), [["DRAFT_DETAIL", "NAMED_QUERY"]]);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("unverified response shape remains advisory", async () => {
  const context = new EventEmitter();
  const page = { url: () => listUrl };
  const observer = observeDraftReadMetadata(context, { page, shopId });
  const req = request(page);
  context.emit("request", req);
  context.emit("response", { request: () => req, status: () => 503,
    headerValue: async () => "text/html",
    body: async () => { throw Error("Response body must not be read"); } });
  const result = await observer.stop();
  assert.deepEqual(result.observations[0], { pageKind: "DRAFT_LIST",
    operationClass: "NAMED_QUERY", httpStatus: 503,
    responseShape: null, hasErrors: null });
  assert.equal(result.allowFinalCreate, false);
});

test("response alias or dynamic map keys cannot expose an ID", async () => {
  const context = new EventEmitter();
  const page = { url: () => detailUrl };
  const observer = observeDraftReadMetadata(context, { page, shopId });
  const req = request(page, "EditProductPage");
  context.emit("request", req);
  context.emit("response", response(req, {
    PrivateDraftIdABC123: { TokenValueABC123: secret },
    dynamicSkuB005007: { title: secret },
  }));
  const result = await observer.stop();
  const serialized = JSON.stringify(result);
  for (const hidden of ["PrivateDraftIdABC123", "TokenValueABC123",
    "dynamicSkuB005007", secret]) assert.equal(serialized.includes(hidden), false);
  assert.equal(result.observations[0].responseShape.fieldCount, 2);
  assert.equal(result.allowFinalCreate, false);
});

test("alphabetic ID embedded in a query operation name is not returned", async () => {
  const context = new EventEmitter();
  const page = { url: () => listUrl };
  const observer = observeDraftReadMetadata(context, { page, shopId });
  const sensitiveOperation = "DraftAbcdefghijklmnopPage";
  const req = request(page, sensitiveOperation);
  context.emit("request", req);
  context.emit("response", response(req));
  const result = await observer.stop();
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].operationClass, "NAMED_QUERY");
  assert.equal(JSON.stringify(result).includes(sensitiveOperation), false);
  assert.equal(result.allowFinalCreate, false);
});

test("array operationName cannot be coerced into a read query", async () => {
  const context = new EventEmitter();
  const page = { url: () => listUrl };
  const observer = observeDraftReadMetadata(context, { page, shopId });
  const req = request(page);
  const payload = { operationName: ["DraftProductsPage"],
    query: "query DraftProductsPage { draftProducts { id } }" };
  req.postDataBuffer = () => Buffer.from(JSON.stringify(payload));
  context.emit("request", req);
  context.emit("response", response(req));
  const result = await observer.stop();
  assert.deepEqual(result.observations, []);
  assert.equal(result.allowFinalCreate, false);
});

test("blocked request reasons are fixed categories without request values", () => {
  const blocked = (method, url, payload, resource = "fetch") => ({
    method: () => method, url: () => url, resourceType: () => resource,
    postDataBuffer: () => Buffer.from(JSON.stringify(payload)),
  });
  const cases = [
    [blocked("DELETE", secret, {}), "NON_READ_METHOD"],
    [blocked("POST", secret, {}), "POST_OTHER_ENDPOINT"],
    [blocked("POST", "https://mercari-shops.com/graphql", {}, "document"),
      "GRAPHQL_RESOURCE_UNVERIFIED"],
    [blocked("POST", "https://mercari-shops.com/graphql", [{}]),
      "GRAPHQL_BATCH_UNVERIFIED"],
    [blocked("POST", "https://mercari-shops.com/graphql",
      { extensions: { persistedQuery: { sha256Hash: secret } } }),
      "GRAPHQL_PERSISTED_QUERY"],
    [blocked("POST", "https://mercari-shops.com/graphql",
      { operationName: "SaveDraft", query: "mutation SaveDraft { saveDraft { id } }" }),
      "GRAPHQL_WRITE_OPERATION"],
    [blocked("POST", "https://mercari-shops.com/graphql",
      { query: "query { draftProducts { id } }" }),
      "GRAPHQL_UNNAMED_QUERY"],
  ];
  for (const [req, expected] of cases) {
    const reason = classifyDraftReadRouteBlock(req);
    assert.equal(reason, expected);
    assert.equal(reason.includes(secret), false);
  }
  assert.equal(classifyDraftReadRouteBlock({ method: () => {
    throw Error(secret);
  } }), "GUARD_INSPECTION_FAILED");
});
