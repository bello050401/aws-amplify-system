import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { observeManualShopsMutation, safeManualMutationSummary } from "../src/manualMutationObservation.mjs";

const editUrl = "https://mercari-shops.com/seller/shops/shop1/products/existing1/edit";
const page = () => Object.assign(new EventEmitter(), { url: () => editUrl });
function request(url, body, contentType = "application/json") {
  return { url: () => url, method: () => "POST", resourceType: () => "fetch",
    headerValue: async name => ({ "content-type": contentType,
      authorization: "Bearer secret-auth", cookie: "private-session", "x-csrf-token": "secret-csrf" })[name] ?? null,
    postDataBuffer: () => Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
    postDataJSON: () => body };
}
function response(req, body) {
  return { request: () => req, status: () => 200,
    headerValue: async () => "application/json", json: async () => body };
}

test("manual metadata preserves request order, field types and response identity without values", async () => {
  const browser = page();
  const observer = observeManualShopsMutation(browser, editUrl, { drainMs: 50 });
  const first = request("https://mercari-shops.com/api/v1/seller/shops/private-shop/products?token=secret-query",
    { operationName: "SecretOperation", variables: { input: { name: "secret title",
      status: "UNOPENED", imageUrls: ["https://private.example/image.jpg"], token: "secret-token" } } });
  const second = request("https://private-bucket.example/signed/path?signature=secret-signature",
    { file: "secret-file-bytes" });
  browser.emit("request", first);
  browser.emit("request", second);
  browser.emit("response", response(first, { data: { createProduct: { product: {
    id: "existing1", status: "UNOPENED", token: "secret-response" } } } }));
  const entries = await observer.stop();
  assert.deepEqual(entries.map(item => item.order), [1, 2]);
  assert.deepEqual(entries[0].fields, [
    { field: "operationName", type: "string" },
    { field: "variables", type: "object" },
    { field: "variables.input", type: "object" },
    { field: "variables.input.name", type: "string" },
    { field: "variables.input.status", type: "string" },
    { field: "variables.input.imageUrls", type: "array" },
    { field: "variables.input.imageUrls[]", type: "string" },
  ]);
  assert.deepEqual(entries[0].auth, { authorization: true, cookie: true, csrf: true });
  assert.equal(entries[0].id, "existing1");
  assert.equal(entries[0].state, "UNOPENED");
  assert.deepEqual({ host: entries[1].host, path: entries[1].path },
    { host: "external-https", path: "/:value" });
  assert.equal(JSON.stringify(entries).includes("secret"), false);
});

test("multipart reports only allowlisted part names and file types", async () => {
  const browser = page();
  const observer = observeManualShopsMutation(browser, editUrl, { drainMs: 50 });
  const body = "--boundary123\r\nContent-Disposition: form-data; name=\"file\"; filename=\"secret.jpg\"\r\nContent-Type: image/jpeg\r\n\r\nprivate bytes\r\n--boundary123\r\nContent-Disposition: form-data; name=\"token\"\r\n\r\nsecret token\r\n--boundary123--\r\n";
  browser.emit("request", request("https://mercari-shops.com/api/v1/images/upload", body,
    "multipart/form-data; boundary=boundary123"));
  const entries = await observer.stop();
  assert.deepEqual(entries[0].fields, [{ field: "file", type: "file" }]);
  assert.equal(entries[0].bodyType, "multipart");
  assert.equal(JSON.stringify(entries).includes("secret"), false);
});

test("observer ignores other pages and stops without operating the browser", async () => {
  const browser = page();
  const observer = observeManualShopsMutation(browser, editUrl, { drainMs: 50 });
  browser.url = () => "https://mercari-shops.com/seller/shops/other/products/other/edit";
  browser.emit("request", request("https://mercari-shops.com/api/v1/products", { name: "private" }));
  assert.deepEqual(await observer.stop(), []);
  browser.url = () => editUrl;
  browser.emit("request", request("https://mercari-shops.com/api/v1/products", { name: "private" }));
  assert.equal(browser.listenerCount("request"), 0);
});

test("stop keeps a late response for an accepted request within a bounded drain", async () => {
  const browser = page();
  const observer = observeManualShopsMutation(browser, editUrl, { drainMs: 100 });
  const req = request("https://mercari-shops.com/api/v1/products", { status: "UNOPENED" });
  browser.emit("request", req);
  setTimeout(() => browser.emit("response", response(req, { data: { product: {
    id: "existing1", status: "UNOPENED" } } })), 10);
  const entries = await observer.stop();
  assert.equal(entries[0].httpStatus, 200);
  assert.equal(entries[0].id, "existing1");
  assert.equal(entries[0].state, "UNOPENED");
});

test("stop returns partial metadata if a JSON response never completes", async () => {
  const browser = page();
  const observer = observeManualShopsMutation(browser, editUrl, { drainMs: 30 });
  const req = request("https://mercari-shops.com/api/v1/products", { status: "UNOPENED" });
  browser.emit("request", req);
  browser.emit("response", { request: () => req, status: () => 200,
    headerValue: async () => "application/json", json: () => new Promise(() => {}) });
  const entries = await observer.stop();
  assert.equal(entries[0].httpStatus, 200);
  assert.equal(entries[0].state, undefined);
  assert.equal(browser.listenerCount("response"), 0);
});

test("local UI boundary drops raw URLs, unauthorized fields and extra values", () => {
  const item = { order: 1, method: "POST", host: "mercari-shops.com", path: "/api/v1/products/:value",
    bodyType: "json", fields: [{ field: "input.status", type: "string" },
      { field: "input.secretToken", type: "string" }],
    auth: { authorization: true, cookie: false, csrf: true }, httpStatus: 200,
    id: "existing1", state: "UNOPENED", rawBody: "secret-value" };
  const safe = safeManualMutationSummary([item, { ...item, path: "/api/secret" }]);
  assert.equal(safe.length, 1);
  assert.deepEqual(safe[0].fields, [{ field: "input.status", type: "string" }]);
  assert.equal(JSON.stringify(safe).includes("secret"), false);
});
