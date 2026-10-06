import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { preparePrivateCreateOnce, PRIVATE_CREATE_SHOP_ID } from
  "../src/privateCreatePreparation.mjs";
import { claimFutureCreateObservationOnce,
  recordFutureCreateObservationOnce } from "../src/futureCreateObservationAttempt.mjs";
import { observeFutureCreateTraffic, safeFutureCreateTrafficSummary } from
  "../src/futureCreateTrafficObservation.mjs";
import { openFutureCreateTrafficObservationSession } from "../src/session.mjs";

const inventoryId = "bd4850de-9156-4890-a821-cae75da5c8f7";
const runFile = promisify(execFile);
const input = { schemaVersion: 1, kind: "BELLO_PRIVATE_CREATE_PREPARATION",
  shopId: PRIVATE_CREATE_SHOP_ID, inventoryId, inventoryCode: "B009999",
  draftId: "e5da4384-16c9-4e63-bc2b-19280856b7de",
  draftUpdatedAt: "2026-10-06T12:00:00.000Z", title: "Reviewed item",
  description: "Reviewed condition and shipping description", priceYen: 45000,
  quantity: 1, condition: "NO_NOTABLE_DAMAGE", shippingMethod: "KAZAI",
  imageRefs: [{ source: "INVENTORY", storageKey: "inventory/photo.jpg",
    sortOrder: 0, photoAssetId: null }] };
const privateTestId = "dd273c1e-9b2a-4013-acc6-c445a481fab8";
const privateTest = {
  schemaVersion: 2, kind: "BELLO_SEPARATE_PRIVATE_TEST_PREPARATION",
  shopId: PRIVATE_CREATE_SHOP_ID, inventoryId: privateTestId,
  sourceInventoryCode: "B005659", sourcePriceYen: 54200,
  testManagementCode: "TEST_B005659_E51E4F6B7B86DD150546",
  testPriceYen: 99999, visibility: "PRIVATE_ONLY",
  doNotModifyProductId: "2JWp7EJx6aqKfn6dTXc5Q9",
  contentEvidence: "BELLO_SAVED_DRAFT_ONLY",
  draftId: input.draftId, draftUpdatedAt: input.draftUpdatedAt,
  title: input.title, description: input.description, quantity: 1,
  condition: "NO_NOTABLE_DAMAGE", shippingMethod: "KAZAI",
  imageRefs: input.imageRefs,
};

async function withPrepared(run, preparedInput = input) {
  const root = await mkdtemp(join(tmpdir(), "bello-future-create-observer-"));
  try {
    await preparePrivateCreateOnce(root, preparedInput);
    return await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

function fakeTraffic() {
  const context = new EventEmitter();
  let current = `https://mercari-shops.com/seller/shops/${PRIVATE_CREATE_SHOP_ID}/products/create`;
  const page = { url: () => current };
  return { context, page, setUrl: value => { current = value; } };
}

test("passive create observer records only ordered allowlisted metadata and draft UNKNOWN", async () => {
  const { context, page, setUrl } = fakeTraffic();
  const observer = observeFutureCreateTraffic(context, { page, drainMs: 50 });
  const secret = "SYNTHETIC_SECRET_DO_NOT_RECORD_8371";
  const request = {
    method: () => "POST", resourceType: () => "fetch", frame: () => ({ page: () => page }),
    url: () => `https://mercari-shops.com/graphql?token=${secret}`,
    headerValue: async name => name === "content-type" ? "application/json" : secret,
    postDataBuffer: () => Buffer.from(JSON.stringify({ query: secret,
      variables: { input: { name: secret, price: 45000, csrf: secret } },
      authorization: secret })),
  };
  context.emit("request", request);
  const response = { request: () => request, status: () => 200,
    headerValue: async name => name === "content-type" ? "application/json" : "0",
    body: async () => Buffer.from(JSON.stringify({ data: { createProduct: { product: {
      id: "newPrivateProduct123", shopId: PRIVATE_CREATE_SHOP_ID,
      status: "UNOPENED", description: secret } } }, token: secret })) };
  context.emit("response", response);
  setUrl(`https://mercari-shops.com/seller/shops/${PRIVATE_CREATE_SHOP_ID}/products/create?productDraftId=unknownDraft123&token=${secret}`);
  const safe = await observer.stop();
  assert.equal(safe.captureStatus, "UNVERIFIED");
  assert.deepEqual(safe.draftIds, [{ id: "unknownDraft123", state: "UNKNOWN_UNATTRIBUTED" }]);
  assert.deepEqual(safe.events, [{ order: 1, method: "POST", host: "mercari-shops.com",
    path: "/graphql", requestJsonKeys: ["query", "variables", "variables.input",
      "variables.input.name", "variables.input.price"],
    responseJsonKeys: ["data", "data.createProduct", "data.createProduct.product",
      "data.createProduct.product.id", "data.createProduct.product.shopId",
      "data.createProduct.product.status", "data.createProduct.product.description"],
    httpStatus: 200, resultId: "newPrivateProduct123", resultState: "UNOPENED" }]);
  assert.equal(JSON.stringify(safe).includes(secret), false);
  assert.equal(safe.listingConfirmed, false);
});

test("sign-in, other shop, other host and multipart bytes cannot enter the record", async () => {
  const { context, page, setUrl } = fakeTraffic();
  const observer = observeFutureCreateTraffic(context, { page, drainMs: 0 });
  let bodyReads = 0;
  const request = { method: () => "POST", resourceType: () => "fetch",
    frame: () => ({ page: () => page }),
    url: () => "https://mercari-shops.com/graphql",
    headerValue: async name => name === "content-type" ? "multipart/form-data; boundary=secret" : null,
    postDataBuffer: () => { bodyReads++; throw Error("Image bytes must not be read"); } };
  setUrl("https://mercari-shops.com/signin/seller");
  context.emit("request", request);
  setUrl(`https://mercari-shops.com/seller/shops/${PRIVATE_CREATE_SHOP_ID}/products/create`);
  context.emit("request", { ...request, url: () => "https://evil.example/upload" });
  context.emit("request", request);
  const safe = await observer.stop();
  assert.equal(safe.events.length, 1);
  assert.deepEqual(safe.events[0].requestJsonKeys, []);
  assert.equal(bodyReads, 0);
});

test("an autosaved draft response remains UNKNOWN and cannot become a product result", async () => {
  const { context, page, setUrl } = fakeTraffic();
  const observer = observeFutureCreateTraffic(context, { page, drainMs: 50 });
  const request = { method: () => "POST", resourceType: () => "fetch",
    frame: () => ({ page: () => page }),
    url: () => "https://mercari-shops.com/graphql",
    headerValue: async () => "application/json",
    postDataBuffer: () => Buffer.from('{"variables":{"input":{"status":"DRAFT"}}}') };
  context.emit("request", request);
  context.emit("response", { request: () => request, status: () => 200,
    headerValue: async name => name === "content-type" ? "application/json" : "0",
    body: async () => Buffer.from(JSON.stringify({ data: { createProduct: { product: {
      id: "draftOnly123", shopId: PRIVATE_CREATE_SHOP_ID, status: "DRAFT" } } } })) });
  setUrl(`https://mercari-shops.com/seller/shops/${PRIVATE_CREATE_SHOP_ID}/products/create?productDraftId=draftOnly123`);
  const safe = await observer.stop();
  assert.equal(safe.events[0].resultId, null);
  assert.equal(safe.events[0].resultState, null);
  assert.deepEqual(safe.draftIds, [{ id: "draftOnly123", state: "UNKNOWN_UNATTRIBUTED" }]);
});

test("exactly 80 JSON keys are complete and the 81st marks request or response truncated", async () => {
  const names = ["query", "operationName", "variables", "input", "data",
    "createProduct", "updateProduct", "createProductDraft", "saveProductDraft",
    "product", "productDraft", "id", "productId", "productDraftId", "shopId",
    "name", "description", "price", "status", "condition"];
  const wide = count => Object.fromEntries(names.slice(0, count).map(name => [name, 1]));
  const body = count => ({ input: wide(20), product: wide(20),
    data: wide(20), variables: wide(count) });
  async function observe(requestBody, responseBody = {}) {
    const { context, page } = fakeTraffic();
    const observer = observeFutureCreateTraffic(context, { page, drainMs: 50 });
    const request = { method: () => "POST", resourceType: () => "fetch",
      frame: () => ({ page: () => page }), url: () => "https://mercari-shops.com/graphql",
      headerValue: async () => "application/json",
      postDataBuffer: () => Buffer.from(JSON.stringify(requestBody)) };
    context.emit("request", request);
    context.emit("response", { request: () => request, status: () => 200,
      headerValue: async name => name === "content-type" ? "application/json" : "0",
      body: async () => Buffer.from(JSON.stringify(responseBody)) });
    return observer.stop();
  }
  const exact = await observe(body(16));
  assert.equal(exact.events[0].requestJsonKeys.length, 80);
  assert.equal(exact.captureStatus, "UNVERIFIED");
  const requestOverflow = await observe(body(17));
  assert.equal(requestOverflow.events[0].requestJsonKeys.length, 80);
  assert.equal(requestOverflow.captureStatus, "TRUNCATED");
  const responseOverflow = await observe({}, body(17));
  assert.equal(responseOverflow.events[0].responseJsonKeys.length, 80);
  assert.equal(responseOverflow.captureStatus, "TRUNCATED");
});

test("JSON request and response over 128 KiB mark observation truncated", async () => {
  for (const side of ["request", "response"]) {
    const { context, page } = fakeTraffic();
    const observer = observeFutureCreateTraffic(context, { page, drainMs: 50 });
    const request = { method: () => "POST", resourceType: () => "fetch",
      frame: () => ({ page: () => page }), url: () => "https://mercari-shops.com/graphql",
      headerValue: async () => "application/json",
      postDataBuffer: () => side === "request" ? Buffer.alloc(128 * 1024 + 1, 65) :
        Buffer.from("{}") };
    context.emit("request", request);
    context.emit("response", { request: () => request, status: () => 200,
      headerValue: async name => name === "content-type" ? "application/json" :
        side === "response" ? String(128 * 1024 + 1) : "2",
      body: async () => Buffer.from("{}") });
    const safe = await observer.stop();
    assert.equal(safe.captureStatus, "TRUNCATED");
    assert.equal(safe.events.length, 1);
  }
});

test("one durable claim precedes browser navigation and retains unverified result only", () =>
  withPrepared(async root => {
    const context = new EventEmitter();
    let current = "about:blank";
    const page = { url: () => current, goto: async url => {
      const record = JSON.parse(await readFile(join(root,
        "future-private-create-observation-once",
        `${PRIVATE_CREATE_SHOP_ID}-once.claim.json`), "utf8"));
      assert.equal(record.outcome, "UNKNOWN");
      assert.equal(JSON.stringify(record).includes("B009999"), false);
      assert.equal(JSON.stringify(record).includes("45000"), false);
      assert.equal(context.listenerCount("request") > 0, true);
      current = url;
    } };
    context.pages = () => [];
    context.newPage = async () => page;
    context.close = async () => context.emit("close");
    const session = await openFutureCreateTrafficObservationSession({ root,
      profileDir: join(root, "dedicated-profile"), inventoryId,
      launchPersistentContext: async () => context });
    assert.equal(session.state, "LIST_OPEN");
    await assert.rejects(claimFutureCreateObservationOnce(root, inventoryId),
      /ALREADY_CLAIMED/);
    const receipt = await recordFutureCreateObservationOnce(root, inventoryId,
      session.claim.attemptId, await session.observer.stop());
    assert.equal(receipt.outcome, "OBSERVED_UNVERIFIED");
    assert.equal(receipt.listingConfirmed, false);
    const saved = JSON.parse(await readFile(join(root,
      "future-private-create-observation-once",
      `${PRIVATE_CREATE_SHOP_ID}-once.result.json`), "utf8"));
    assert.equal(saved.captureStatus, "UNVERIFIED");
    assert.equal(saved.listingConfirmed, false);
    await assert.rejects(recordFutureCreateObservationOnce(root, inventoryId,
      session.claim.attemptId, await session.observer.stop()), /ALREADY_RECORDED/);
  }));

test("B005659 private test can be claimed once without touching the existing product", () =>
  withPrepared(async root => {
    const claim = await claimFutureCreateObservationOnce(root, privateTestId);
    assert.equal(claim.shopId, PRIVATE_CREATE_SHOP_ID);
    assert.equal(claim.outcome, "UNKNOWN");
    assert.equal(claim.listingConfirmed, false);
    await assert.rejects(claimFutureCreateObservationOnce(root, privateTestId),
      /ALREADY_CLAIMED/);
    const stored = JSON.parse(await readFile(join(root,
      "future-private-create-observation-once",
      `${PRIVATE_CREATE_SHOP_ID}-once.claim.json`), "utf8"));
    assert.equal(JSON.stringify(stored).includes(privateTest.testManagementCode), false);
    assert.equal(JSON.stringify(stored).includes(privateTest.doNotModifyProductId), false);
  }, privateTest));

test("a restored remote draft blocks new navigation and keeps the claim UNKNOWN", () =>
  withPrepared(async root => {
    const context = new EventEmitter();
    let navigations = 0;
    context.pages = () => [{ url: () =>
      `https://mercari-shops.com/seller/shops/${PRIVATE_CREATE_SHOP_ID}/products/create?productDraftId=unknownOldDraft` }];
    context.newPage = async () => { navigations++; throw Error("No new page allowed"); };
    context.close = async () => {};
    await assert.rejects(openFutureCreateTrafficObservationSession({ root,
      profileDir: join(root, "dedicated-profile"), inventoryId,
      launchPersistentContext: async () => context }), /BROWSER_UNAVAILABLE/);
    assert.equal(navigations, 0);
    const claim = JSON.parse(await readFile(join(root,
      "future-private-create-observation-once",
      `${PRIVATE_CREATE_SHOP_ID}-once.claim.json`), "utf8"));
    assert.equal(claim.outcome, "UNKNOWN");
    assert.equal(claim.listingConfirmed, false);
  }));

test("blocked old inventory and extra traffic values never qualify", async () => {
  await withPrepared(async root => {
    await assert.rejects(claimFutureCreateObservationOnce(root,
      "c9ee4ea7-070f-491c-bd4c-c1547cb73436"));
  });
  await withPrepared(async root => {
    await assert.rejects(claimFutureCreateObservationOnce(root, inventoryId),
      /TARGET_BLOCKED/);
  }, { ...input, inventoryCode: "b005795" });
  assert.equal(safeFutureCreateTrafficSummary({ captureStatus: "UNVERIFIED",
    draftIds: [], events: [{ order: 1, method: "POST", host: "mercari-shops.com",
      path: "/graphql", requestJsonKeys: [], responseJsonKeys: [],
      httpStatus: 200, resultId: null, resultState: null, cookie: "secret" }] }), null);
});

test("uppercase protected inventory UUID is blocked before claim or browser launch", () =>
  withPrepared(async root => {
    let launched = 0;
    await assert.rejects(openFutureCreateTrafficObservationSession({ root,
      profileDir: join(root, "dedicated-profile"),
      inventoryId: "C9EE4EA7-070F-491C-BD4C-C1547CB73436",
      launchPersistentContext: async () => { launched++; throw Error("Must not launch"); } }),
    /TARGET_BLOCKED/);
    assert.equal(launched, 0);
    await assert.rejects(readFile(join(root, "future-private-create-observation-once",
      `${PRIVATE_CREATE_SHOP_ID}-once.claim.json`), "utf8"), { code: "ENOENT" });
  }, { ...input, inventoryId: "C9EE4EA7-070F-491C-BD4C-C1547CB73436" }));

test("future observer CLI errors have fixed text and never echo target values", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-future-create-cli-"));
  try {
    const secret = "SYNTHETIC_SECRET_DO_NOT_PRINT_0918";
    const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
    await assert.rejects(runFile(process.execPath, [cli,
      "observe-future-private-create-traffic", "--root", root,
      "--profile", join(root, "profile"), "--playwright", join(root, "playwright.js"),
      "--inventory", secret]), error => {
      assert.equal(error.stdout, "");
      assert.equal(error.stderr.trim(),
        "BELLO Mercari bridge: FUTURE_CREATE_OBSERVATION_UNAVAILABLE");
      assert.equal(error.stderr.includes(secret), false);
      assert.equal(error.stderr.includes(root), false);
      return true;
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
