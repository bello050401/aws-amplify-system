import assert from "node:assert/strict";
import test from "node:test";
import { CONTROL_URL, OPEN_URI, openPcControlOnce, probeControl } from "../src/desktopLauncher.mjs";

test("protocol opens only the verified fixed local control page", async () => {
  const calls = [];
  const result = await openPcControlOnce(OPEN_URI, {
    probe: async () => "AVAILABLE",
    findRunning: async () => { calls.push("find"); return false; },
    start: async () => calls.push("start"),
    open: async () => calls.push("open"),
  });
  assert.equal(result, "EXISTING");
  assert.deepEqual(calls, ["open"]);
  await assert.rejects(openPcControlOnce(`${OPEN_URI}?requestId=secret`, {
    open: async () => calls.push("bad-open"),
  }), { code: "INVALID_URI" });
  assert.deepEqual(calls, ["open"]);
  assert.equal(CONTROL_URL, "http://127.0.0.1:56210/");
});

test("launcher refuses an unknown service, a running legacy app, and failed process detection", async () => {
  let started = false;
  await assert.rejects(openPcControlOnce(OPEN_URI, {
    probe: async () => "OTHER_SERVICE", start: async () => { started = true; },
  }), { code: "PORT_OCCUPIED" });
  await assert.rejects(openPcControlOnce(OPEN_URI, {
    probe: async () => "ABSENT", findRunning: async () => true,
    start: async () => { started = true; },
  }), { code: "ALREADY_RUNNING" });
  await assert.rejects(openPcControlOnce(OPEN_URI, {
    probe: async () => "ABSENT", findRunning: async () => { throw Error("CIM unavailable"); },
    start: async () => { started = true; },
  }), { code: "PROCESS_CHECK_FAILED" });
  assert.equal(started, false);
});

test("launcher waits for fixed port readiness before opening the UI", async () => {
  const calls = [];
  const states = ["ABSENT", "ABSENT", "AVAILABLE"];
  const result = await openPcControlOnce(OPEN_URI, {
    probe: async () => states.shift(),
    findRunning: async () => false,
    start: async () => calls.push("start"),
    wait: async () => calls.push("wait"),
    open: async () => calls.push("open"),
  });
  assert.equal(result, "STARTED");
  assert.deepEqual(calls, ["start", "wait", "wait", "open"]);
});

test("probe accepts BELLO title and rejects redirects or lookalike pages", async () => {
  assert.equal(await probeControl(async () => new Response("", { status: 302,
    headers: { Location: "https://example.com" } })), "OTHER_SERVICE");
  assert.equal(await probeControl(async () => new Response("<title>other</title>", {
    headers: { "content-type": "text/html" } })), "OTHER_SERVICE");
  assert.equal(await probeControl(async () => new Response("<title>BELLO メルカリ照合</title>", {
    headers: { "content-type": "text/html; charset=utf-8" } })), "OTHER_SERVICE");
  assert.equal(await probeControl(async () => new Response(
    '<title>BELLO メルカリ照合</title><h1>BELLO メルカリShops既存商品照合</h1><input name="csrf">', {
    headers: { "content-type": "text/html; charset=utf-8" } })), "AVAILABLE");
  assert.equal(await probeControl(async () => { throw Error("connection refused"); }), "ABSENT");
});
