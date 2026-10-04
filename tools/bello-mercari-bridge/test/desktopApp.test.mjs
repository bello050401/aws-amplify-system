import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { startDesktopApp } from "../src/desktopApp.mjs";
import { BridgeBoundaryError } from "../src/cloudConnector.mjs";
import { claimManualSaveOnce } from "../src/manualSaveAttempt.mjs";

const config = () => ({ origin: "https://bello.example.test", requestId: "a".repeat(64),
  dataDir: join(tmpdir(), "bello-desktop-test") });
function context() {
  const events = new EventEmitter();
  events.close = async () => { events.emit("close"); };
  return events;
}
async function token(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return (await response.text()).match(/name="csrf" value="([a-f0-9]+)"/)[1];
}
const post = (url, csrf, action, origin = url) => fetch(`${url}/action`, {
  method: "POST", redirect: "manual", headers: { Origin: origin,
    "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ csrf, action }),
});

test("visible login steps use separate profiles; one explicit read binds the configured ID", async () => {
  const calls = [];
  const app = await startDesktopApp(config(), { openBrowser: async () => {},
    openBello: async (options) => { calls.push(["bello", options]); return context(); },
    openShops: async (options) => { calls.push(["shops", options]); return context(); },
    runRead: async (options) => { calls.push(["read", options]); return { status: "INCOMPLETE" }; } });
  try {
    const csrf = await token(app.url);
    assert.equal((await post(app.url, csrf, "read", "https://evil.example.test")).status, 403);
    assert.equal((await post(app.url, "wrong", "read")).status, 403);
    assert.equal((await post(app.url, csrf, "bello-login")).status, 303);
    assert.equal((await post(app.url, csrf, "shops-login")).status, 303);
    assert.equal((await post(app.url, csrf, "read")).status, 303);
    assert.equal(calls.length, 3);
    assert.notEqual(calls[0][1].profileDir, calls[1][1].profileDir);
    assert.equal(calls[2][1].requestId, config().requestId);
    assert.equal(calls[2][1].browserRead, true);
    const content = await (await fetch(app.url)).text();
    assert.match(content, /INCOMPLETE/);
    assert.match(content, /出品完了の確認ではありません/);
  } finally { await app.close(); }
});

test("a failed read never appears as a reported result", async () => {
  const app = await startDesktopApp(config(), { openBrowser: async () => {},
    runRead: async () => { throw Error("private cookie must not be shown"); } });
  try {
    const csrf = await token(app.url);
    assert.equal((await post(app.url, csrf, "read")).status, 303);
    const content = await (await fetch(app.url)).text();
    assert.match(content, /処理を完了できませんでした/);
    assert.equal(content.includes("private cookie"), false);
    assert.equal(content.includes("直近の結果"), false);
  } finally { await app.close(); }
});

test("local traffic summary displays only redacted metadata and is never part of the read receipt", async () => {
  const app = await startDesktopApp(config(), { openBrowser: async () => {},
    runRead: async ({ onShopsTraffic }) => {
      onShopsTraffic([{ host: "mercari-shops.com", method: "GET", type: "fetch",
        path: "/api/v1/products/:value", status: 200, count: 1 },
      { host: "mercari-shops.com", method: "GET", type: "fetch",
        path: "/api/secretToken", status: 200, count: 1 }]);
      return { status: "INCOMPLETE" };
    } });
  try {
    const csrf = await token(app.url);
    assert.equal((await post(app.url, csrf, "read")).status, 303);
    const content = await (await fetch(app.url)).text();
    assert.match(content, /Shops通信の概要/);
    assert.match(content, /\/api\/v1\/products\/:value/);
    assert.equal(content.includes("secretToken"), false);
  } finally { await app.close(); }
});

test("reader stage diagnostics show only fixed codes in local memory", async () => {
  const app = await startDesktopApp(config(), { openBrowser: async () => {},
    runRead: async ({ onReadDiagnostics }) => {
      onReadDiagnostics(["HEADING_TIMEOUT", "private product title", "https://secret.example"]);
      return { status: "UNKNOWN" };
    } });
  try {
    const csrf = await token(app.url);
    assert.equal((await post(app.url, csrf, "read")).status, 303);
    const content = await (await fetch(app.url)).text();
    assert.match(content, /HEADING_TIMEOUT/);
    assert.equal(content.includes("private product title"), false);
    assert.equal(content.includes("secret.example"), false);
  } finally { await app.close(); }
});

test("manual observation opens the pinned dedicated product and displays only sanitized metadata", async () => {
  const target = { shopId: "shop1", remoteId: "existing1", inventoryCode: "B005795",
    priceYen: 90000, quantity: 0 };
  const opened = [];
  let saves = 0;
  let browserClosed = false;
  const app = await startDesktopApp({ ...config(), manualObservation: target }, {
    openBrowser: async () => {},
    openManualObservation: async options => {
      opened.push(options);
      const browserContext = context();
      browserContext.close = async () => { browserClosed = true; browserContext.emit("close"); };
      return { context: browserContext, observer: { stop: async () => {
        assert.equal(browserClosed, false, "drain response before closing the browser");
        return [{
        order: 1, method: "POST", host: "mercari-shops.com", path: "/api/v1/products/:value",
        bodyType: "json", fields: [{ field: "input.status", type: "string" },
          { field: "input.secret", type: "string" }],
        auth: { authorization: false, cookie: true, csrf: true }, httpStatus: 200,
        id: "existing1", state: "UNOPENED", rawBody: "secret-value",
      }]; } } };
    },
    runRead: async () => { saves++; throw Error("observation must not start a read"); },
  });
  try {
    const csrf = await token(app.url);
    assert.equal((await post(app.url, csrf, "observe-start")).status, 303);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].shopId, target.shopId);
    assert.equal(opened[0].remoteId, target.remoteId);
    assert.equal(saves, 0);
    assert.equal((await post(app.url, csrf, "observe-stop")).status, 303);
    assert.equal(browserClosed, true);
    const content = await (await fetch(app.url)).text();
    assert.match(content, /既存商品の通信観測/);
    assert.match(content, /B005795/);
    assert.match(content, /90000/);
    assert.match(content, /UNOPENED/);
    assert.equal(content.includes("secret"), false);
  } finally { await app.close(); }
});

test("manual observation refuses missing exact target identifiers", async () => {
  await assert.rejects(startDesktopApp({ ...config(), manualObservation: {
    priceYen: 90000, quantity: 0,
  } }, { openBrowser: async () => {} }), /Invalid exact-product observation target/);
});

test("one PC button invokes exact private save once and restart keeps it disabled", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "bello-desktop-save-"));
  const target = { shopId: "shop1", remoteId: "existing1", inventoryCode: "B005795",
    priceYen: 90000, quantity: 0 };
  let calls = 0;
  const saveContext = context();
  const saveObserver = { snapshot: () => [], stop: async () => [] };
  const start = () => startDesktopApp({ ...config(), dataDir, manualObservation: target }, {
    openBrowser: async () => {},
    runPrivateSave: async options => {
      calls++;
      assert.deepEqual(options.target, target);
      await claimManualSaveOnce(options.root, target);
      return { status: "UNKNOWN", listingConfirmed: false, postflightPrivate: false,
        metadata: [], retainedSession: { context: saveContext, observer: saveObserver,
          onClose: callback => saveContext.once("close", callback) } };
    },
  });
  try {
    let app = await start();
    try {
      const csrf = await token(app.url);
      assert.match(await (await fetch(app.url)).text(), /既存商品を非公開で1回保存/);
      assert.equal((await post(app.url, csrf, "save-private-once")).status, 303);
      assert.equal((await post(app.url, csrf, "save-private-once")).status, 303);
      assert.equal(calls, 1);
      const content = await (await fetch(app.url)).text();
      assert.match(content, /再実行はできません/);
      assert.match(content, /再実行できません/);
      assert.match(content, /専用Chromeを開いたままにしています/);
      assert.match(content, /<button disabled>このアプリを終了<\/button>/);
      assert.equal((await post(app.url, csrf, "refresh-save-observation")).status, 303);
      assert.match(content, /<button disabled>既存商品を非公開で1回保存<\/button>/);
      await saveContext.close();
    } finally { await app.close(); }
    app = await start();
    try {
      const content = await (await fetch(app.url)).text();
      assert.match(content, /<button disabled>既存商品を非公開で1回保存<\/button>/);
      assert.equal(calls, 1);
    } finally { await app.close(); }
  } finally {
    assert.equal(resolve(dataDir).startsWith(resolve(tmpdir()) + "\\"), true);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("failed default-browser dispatch keeps the loopback control page available", async () => {
  const app = await startDesktopApp(config(), { openBrowser: async () => {
    throw Error("synthetic browser launch failure");
  } });
  try {
    assert.equal(new URL(app.url).hostname, "127.0.0.1");
    const response = await fetch(app.url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /この読取依頼を照合する/);
  } finally { await app.close(); }
});

test("saved-attempt button reports without re-reading Shops and shows only fixed failure details", async () => {
  const recovery = { jobId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
    attemptId: "cccccccc-cccc-4ccc-cccc-cccccccccccc" };
  let reportCalls = 0;
  const app = await startDesktopApp({ ...config(), recovery }, { openBrowser: async () => {},
    runRead: async () => { throw Error("must not read Shops"); },
    reportRead: async (options) => {
      reportCalls++;
      assert.deepEqual({ jobId: options.jobId, attemptId: options.attemptId }, recovery);
      throw new BridgeBoundaryError("RESULT_POST_HTTP", 409, "INVALID_RESULT");
    } });
  try {
    const csrf = await token(app.url);
    assert.equal((await post(app.url, csrf, "retry-report")).status, 303);
    const content = await (await fetch(app.url)).text();
    assert.equal(reportCalls, 1);
    assert.match(content, /RESULT_POST_HTTP \/ HTTP 409 \/ INVALID_RESULT/);
    assert.match(content, /Shopsに再アクセスせず/);
    assert.equal(content.includes("must not read Shops"), false);
  } finally { await app.close(); }
});
