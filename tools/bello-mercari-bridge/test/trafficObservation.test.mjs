import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { observeShopsTraffic, safeShopsTrafficResponse, safeShopsTrafficSummary } from "../src/trafficObservation.mjs";

function response(url, status = 200) {
  return { url: () => url, status: () => status,
    request: () => ({ method: () => "GET", resourceType: () => "fetch",
      headers: () => { throw Error("headers must not be read"); },
      postData: () => { throw Error("body must not be read"); } }),
    body: () => { throw Error("response body must not be read"); } };
}

test("Shops traffic keeps only fixed path words and response metadata", () => {
  const raw = "https://api.mercari-shops.com/api/v1/seller/shops/secretShop/products/secretProduct?token=secretQuery";
  const safe = safeShopsTrafficResponse(response(raw));
  assert.deepEqual(safe, { host: "*.mercari-shops.com", method: "GET", type: "fetch",
    path: "/api/v1/seller/shops/:value/products/:value", status: 200 });
  assert.equal(JSON.stringify(safe).includes("secret"), false);
  assert.equal(safeShopsTrafficResponse(response("https://unrelated.example/api/secret")), null);
});

test("one visit aggregates in memory, detaches on stop, and rejects unsanitized display rows", () => {
  const context = new EventEmitter();
  const traffic = observeShopsTraffic(context);
  const raw = response("https://mercari-shops.com/api/v1/products/privateId?cookie=secret");
  context.emit("response", raw);
  context.emit("response", raw);
  assert.deepEqual(traffic.snapshot(), [{ host: "mercari-shops.com", method: "GET", type: "fetch",
    path: "/api/v1/products/:value", status: 200, count: 2 }]);
  assert.deepEqual(safeShopsTrafficSummary([{ ...traffic.snapshot()[0], secret: "raw body" },
    { ...traffic.snapshot()[0], path: "/api/secret" }]), [traffic.snapshot()[0]]);
  traffic.stop();
  context.emit("response", raw);
  assert.equal(traffic.snapshot()[0].count, 2);
});
