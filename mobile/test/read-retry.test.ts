import assert from "node:assert/strict";
import { test } from "node:test";
import { readJson, ReadHttpError } from "../src/runtime/readJson";

test("a temporary list failure retries one fresh GET and returns the new data", async () => {
  const calls: RequestInit[] = [];
  const value = await readJson("https://example.invalid/inventory", { credentials: "same-origin" }, { retry: true, retryDelayMs: 0,
    fetcher: (async (_url, init) => { calls.push(init!); return calls.length === 1 ? new Response("", { status: 503 }) : Response.json({ items: ["latest"] }); }) as typeof fetch });
  assert.deepEqual(value, { items: ["latest"] }); assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.method === "GET" && call.cache === "no-store" && call.credentials === "same-origin"));
});
test("permanent failure stops after two attempts; authorization failures never retry", async () => {
  for (const status of [400, 401, 403, 404, 503]) {
    let calls = 0;
    await assert.rejects(readJson("https://example.invalid/inventory", {}, { retry: true, retryDelayMs: 0,
      fetcher: (async () => { calls++; return new Response("", { status }); }) as typeof fetch }), (error: unknown) => error instanceof ReadHttpError && error.status === status);
    assert.equal(calls, status === 503 ? 2 : 1);
  }
});
test("a network error retries but failed reads are never converted into an empty list", async () => {
  let calls = 0;
  await assert.rejects(readJson("https://example.invalid/inventory", {}, { retry: true, retryDelayMs: 0,
    fetcher: (async () => { calls++; throw new TypeError("Network request failed"); }) as typeof fetch }), TypeError);
  assert.equal(calls, 2);
});
test("a stalled read aborts and the retry can recover", async () => {
  let calls = 0;
  const value = await readJson("https://example.invalid/inventory", {}, { retry: true, retryDelayMs: 0, timeoutMs: 5,
    fetcher: ((_url, init) => { calls++; return calls === 1 ? new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")))) : Promise.resolve(Response.json({ items: [] })); }) as typeof fetch });
  assert.deepEqual(value, { items: [] }); assert.equal(calls, 2);
});
