import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { observeBoundedShopsWrite, safeWriteContractSummary } from
  "../src/writeContractObservation.mjs";

const updateTarget = { kind: "UPDATE_PRODUCT", shopId: "shop1",
  remoteId: "product1", inventoryCode: "ITEM_1", skuCode: null };
const createTarget = { kind: "CREATE_PRODUCT", shopId: "shop1",
  remoteId: null, inventoryCode: "ITEM_2", skuCode: "ITEM_2-TEST",
  excludedRemoteId: "existing1", expectedName: "Side Table", priceYen: 98000 };
const imageTarget = { kind: "IMAGE_ASSET", shopId: "shop1",
  remoteId: "product1", inventoryCode: "ITEM_1", skuCode: null };
const updateQuery = "mutation SaveProduct($input: SaveInput!) { updateProduct(input: $input) { product { id shopId status } } }";
const createQuery = "mutation AddProduct($input: AddInput!) { createProduct(input: $input) { product { id shopId status variants { skuCode } } } }";
const graphUrl = "https://mercari-shops.com/graphql";

function harness(target = updateTarget, options = {}) {
  const context = new EventEmitter();
  const page = { url: () => `https://mercari-shops.com/seller/shops/shop1/products/${target.kind === "CREATE_PRODUCT" ? "create" : "new"}` };
  const observer = observeBoundedShopsWrite(context,
    { page, target, timeoutMs: 80, ...options });
  return { context, page, observer };
}

function request(page, query, input, extras = {}) {
  const body = { operationName: extras.operationName ?? (
    query.startsWith("mutation SaveProduct") ? "SaveProduct" :
      query.startsWith("mutation AddProduct") ? "AddProduct" : "Other"),
    query, variables: extras.variables ?? { input } };
  const bytes = extras.bytes ?? Buffer.from(JSON.stringify(body));
  return { frame: () => ({ page: () => page }), method: () => "POST",
    resourceType: () => "fetch", url: () => graphUrl,
    postDataBuffer: () => bytes,
    headerValue: () => { throw Error("Credential headers must not be read"); } };
}

function response(req, product, status = 200, extras = {}) {
  const field = extras.field ?? "updateProduct";
  return { request: () => req, status: () => status,
    body: async () => Buffer.from(JSON.stringify(extras.body ?? {
      data: { [field]: { product } }, errors: [],
    })) };
}

test("one exact private update is correlated to its own response without retaining values", async () => {
  const { context, page, observer } = harness();
  observer.arm();
  const req = request(page, updateQuery, { id: "product1", shopId: "shop1",
    status: "UNOPENED", description: "do-not-store", variants: [{ skuCode: "ITEM_1" }] });
  context.emit("request", req);
  context.emit("response", response(req, { id: "product1", shopId: "shop1",
    status: "UNOPENED" }));
  const result = await observer.finish();
  assert.equal(result.status, "MATCHED");
  assert.equal(result.reason, "MATCHED");
  assert.equal(result.expectedKind, "UPDATE_PRODUCT");
  assert.equal(result.observedKind, "UPDATE_PRODUCT");
  assert.equal(result.operationName, "SaveProduct");
  assert.match(result.querySha256, /^[a-f0-9]{64}$/);
  assert.equal(result.requestTargetMatch, "MATCH");
  assert.equal(result.responseTargetMatch, "MATCH");
  assert.equal(result.httpStatus, 200);
  assert.equal(result.variableFields.some(item => item.field === "input.status"), true);
  const serialized = JSON.stringify(result);
  for (const secret of ["do-not-store", "product1", "shop1", "ITEM_1", updateQuery])
    assert.equal(serialized.includes(secret), false);
});

test("one private creation is separate from update and requires the exact SKU in the response", async () => {
  const { context, page, observer } = harness(createTarget);
  observer.arm();
  const req = request(page, createQuery, { shopId: "shop1", status: "UNOPENED",
    name: "Side Table", price: 98000,
    variants: [{ skuCode: "ITEM_2-TEST" }] });
  context.emit("request", req);
  context.emit("response", response(req, { id: "newProduct", shopId: "shop1",
    status: "UNOPENED", variants: [{ skuCode: "ITEM_2-TEST" }] }, 200,
  { field: "createProduct" }));
  const result = await observer.finish();
  assert.equal(result.status, "MATCHED");
  assert.equal(result.observedKind, "CREATE_PRODUCT");
  assert.equal(result.newRemoteId, "newProduct");
});

test("image multipart is classified separately and never proves an HTTP write contract", async () => {
  const { context, page, observer } = harness(imageTarget);
  observer.arm();
  const req = request(page, "", {}, { bytes: Buffer.from("multipart image bytes") });
  context.emit("request", req);
  context.emit("response", response(req, null, 200,
    { body: { data: { createImageAsset: { id: "asset1" } }, errors: [] } }));
  const result = await observer.finish();
  assert.equal(result.status, "UNVERIFIED");
  assert.equal(result.reason, "IMAGE_MULTIPART_UNSUPPORTED");
  assert.equal(result.expectedKind, "IMAGE_ASSET");
});

test("two mutation requests in one armed window cannot be promoted", async () => {
  const { context, page, observer } = harness();
  observer.arm();
  const input = { id: "product1", status: "UNOPENED" };
  const first = request(page, updateQuery, input);
  const second = request(page, updateQuery, input);
  context.emit("request", first);
  context.emit("request", second);
  const result = await observer.finish();
  assert.equal(result.status, "UNVERIFIED");
  assert.equal(result.reason, "MULTIPLE_REQUESTS");
});

test("wrong target, wrong operation, malformed multiple operations and authorization fail closed", async () => {
  const cases = [
    { query: updateQuery, input: { id: "other", status: "UNOPENED" },
      reason: "TARGET_MISMATCH" },
    { query: createQuery, input: { shopId: "shop1", status: "UNOPENED",
      name: "Side Table", price: 98000,
      variants: [{ skuCode: "ITEM_2-TEST" }] }, reason: "OPERATION_MISMATCH" },
    { query: updateQuery + " mutation Again { updateProduct { id } }",
      input: { id: "product1", status: "UNOPENED" }, reason: "REQUEST_UNVERIFIED" },
  ];
  for (const item of cases) {
    const { context, page, observer } = harness();
    observer.arm();
    const req = request(page, item.query, item.input,
      { operationName: item.query.startsWith("mutation AddProduct") ?
        "AddProduct" : "SaveProduct" });
    context.emit("request", req);
    context.emit("response", response(req,
      { id: "product1", shopId: "shop1", status: "UNOPENED" }));
    const result = await observer.finish();
    assert.equal(result.status, "UNVERIFIED");
    assert.equal(result.reason, item.reason);
  }
  const { context, page, observer } = harness();
  observer.arm();
  const req = request(page, updateQuery, { id: "product1", status: "UNOPENED" });
  context.emit("request", req);
  context.emit("response", response(req, null, 401));
  assert.equal((await observer.finish()).reason, "AUTH_REQUIRED");
});

test("a decoy input variable cannot certify a root mutation using another variable", async () => {
  const { context, page, observer } = harness();
  observer.arm();
  const query = "mutation SaveProduct($input: SaveInput!, $price: SaveInput!) { updateProduct(input: $price) { product { id shopId status } } }";
  const req = request(page, query, null, { operationName: "SaveProduct",
    variables: { input: { id: "product1", status: "UNOPENED" },
      price: { id: "other", status: "OPENED" } } });
  context.emit("request", req);
  context.emit("response", response(req, { id: "product1", shopId: "shop1",
    status: "UNOPENED" }));
  const result = await observer.finish();
  assert.equal(result.status, "UNVERIFIED");
  assert.equal(result.reason, "REQUEST_UNVERIFIED");
});

test("a creation cannot reuse the old SKU or old remote product ID", async () => {
  assert.throws(() => harness({ ...createTarget, skuCode: "B005795" }));
  assert.throws(() => harness({ ...createTarget, skuCode: "ITEM_2" }));
  const { context, page, observer } = harness(createTarget);
  observer.arm();
  const req = request(page, createQuery, { shopId: "shop1", status: "UNOPENED",
    name: "Side Table", price: 98000,
    variants: [{ skuCode: "ITEM_2-TEST" }] });
  context.emit("request", req);
  context.emit("response", response(req, { id: "2JXePE4ke8UCBTj6mxc4cf",
    shopId: "shop1", status: "UNOPENED", variants: [{ skuCode: "ITEM_2-TEST" }] },
  200, { field: "createProduct" }));
  const result = await observer.finish();
  assert.equal(result.status, "UNVERIFIED");
  assert.equal(result.reason, "RESPONSE_UNVERIFIED");
});

test("the private create observation refuses wrong price, title, existing ID, or shop page", async () => {
  for (const input of [
    { shopId: "shop1", status: "UNOPENED", name: "Side Table", price: 26500,
      variants: [{ skuCode: "ITEM_2-TEST" }] },
    { shopId: "shop1", status: "UNOPENED", name: "Different title", price: 98000,
      variants: [{ skuCode: "ITEM_2-TEST" }] },
  ]) {
    const { context, page, observer } = harness(createTarget);
    observer.arm();
    const req = request(page, createQuery, input);
    context.emit("request", req);
    context.emit("response", response(req, { id: "newProduct", shopId: "shop1",
      status: "UNOPENED", variants: [{ skuCode: "ITEM_2-TEST" }] }, 200,
    { field: "createProduct" }));
    assert.equal((await observer.finish()).status, "UNVERIFIED");
  }
  const { context, page, observer } = harness(createTarget);
  observer.arm();
  const req = request(page, createQuery, { shopId: "shop1", status: "UNOPENED",
    name: "Side Table", price: 98000, variants: [{ skuCode: "ITEM_2-TEST" }] });
  context.emit("request", req);
  context.emit("response", response(req, { id: "existing1", shopId: "shop1",
    status: "UNOPENED", variants: [{ skuCode: "ITEM_2-TEST" }] }, 200,
  { field: "createProduct" }));
  assert.equal((await observer.finish()).reason, "RESPONSE_UNVERIFIED");

  const wrong = harness(createTarget);
  wrong.page.url = () => "https://mercari-shops.com/seller/shops/other/products/create";
  assert.throws(() => wrong.observer.arm());
  wrong.observer.stop();
  const edit = harness(createTarget);
  edit.page.url = () => "https://mercari-shops.com/seller/shops/shop1/products/existing1/edit";
  assert.throws(() => edit.observer.arm());
  edit.observer.stop();
});

test("GraphQL authentication errors and a failed request cannot become matched", async () => {
  const first = harness();
  first.observer.arm();
  const authRequest = request(first.page, updateQuery,
    { id: "product1", status: "UNOPENED" });
  first.context.emit("request", authRequest);
  first.context.emit("response", response(authRequest, null, 200, { body: {
    data: { updateProduct: null },
    errors: [{ extensions: { code: "UNAUTHENTICATED" }, message: "do-not-store" }],
  } }));
  assert.equal((await first.observer.finish()).reason, "AUTH_REQUIRED");

  const second = harness();
  second.observer.arm();
  const req = request(second.page, updateQuery,
    { id: "product1", status: "UNOPENED" });
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  second.context.emit("request", req);
  second.context.emit("response", { request: () => req, status: () => 200,
    body: async () => delayed });
  second.context.emit("requestfailed", req);
  release(Buffer.from(JSON.stringify({ data: { updateProduct: { product: {
    id: "product1", shopId: "shop1", status: "UNOPENED",
  } } }, errors: [] })));
  const result = await second.observer.finish();
  assert.equal(result.status, "UNVERIFIED");
  assert.equal(result.reason, "RESPONSE_UNVERIFIED");
});

test("no response times out, stop detaches, and old B005795 is excluded", async () => {
  const { context, page, observer } = harness();
  observer.arm();
  context.emit("request", request(page, updateQuery,
    { id: "product1", status: "UNOPENED" }));
  assert.equal((await observer.finish()).reason, "TIMEOUT");
  assert.equal(context.listenerCount("request"), 0);
  const second = harness();
  second.observer.arm();
  assert.equal(second.observer.stop().reason, "STOPPED");
  assert.equal(second.context.listenerCount("response"), 0);
  assert.throws(() => harness({ ...updateTarget, inventoryCode: "B005795" }));
  assert.throws(() => harness({ ...updateTarget, remoteId: "2JXePE4ke8UCBTj6mxc4cf" }));
  assert.throws(() => harness({ ...updateTarget, remoteId: undefined }));
  assert.throws(() => harness({ ...createTarget, skuCode: { toString: () => "ITEM_2" } }));
});

test("the persisted-summary boundary strips arbitrary values and contradictions", () => {
  const result = safeWriteContractSummary({ status: "MATCHED",
    reason: "REQUEST_UNVERIFIED", expectedKind: "UPDATE_PRODUCT",
    operationName: "secretToken", querySha256: "do-not-store",
    variableFields: [{ field: "input.secret", type: "string" }],
    rawBody: "do-not-store" });
  assert.equal(result.status, "UNVERIFIED");
  assert.equal(result.operationName, null);
  assert.deepEqual(result.variableFields, []);
  assert.equal(JSON.stringify(result).includes("do-not-store"), false);
});
