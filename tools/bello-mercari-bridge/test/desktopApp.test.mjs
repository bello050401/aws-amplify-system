import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { startDesktopApp } from "../src/desktopApp.mjs";
import { BridgeBoundaryError } from "../src/cloudConnector.mjs";
import { claimManualSaveOnce } from "../src/manualSaveAttempt.mjs";
import { claimManualImageOnce } from "../src/manualImageAttempt.mjs";
import { claimPrivateImageWorkflow } from "../src/privateImageWorkflowAttempt.mjs";
import { saveReadTrafficEvidence } from "../src/trafficEvidence.mjs";
import { PINNED_READ_QUERY_SHA256, runPinnedDirectReadProbeOnce } from
  "../src/directReadProbe.mjs";
import { CREATE_TEST_TARGET, readCreateTestObservation } from
  "../src/createTestAttempt.mjs";

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

test("fixed control port refuses a second desktop process", async () => {
  const first = await startDesktopApp(config(), { openBrowser: null });
  try {
    const port = Number(new URL(first.url).port);
    await assert.rejects(startDesktopApp({ ...config(), controlPort: port }, {
      openBrowser: null,
    }), { code: "EADDRINUSE" });
  } finally { await first.close(); }
});

test("isolated private-create page claims before image work and records one UI observation", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "bello-desktop-create-"));
  let opened = 0;
  let armed = 0;
  let browser;
  let localPage;
  const createConfig = { ...config(), dataDir, createTestObservationEnabled: true };
  try {
    await assert.rejects(startDesktopApp({ ...createConfig,
      createTestSkuAbsentConfirmed: true }, { openBrowser: null }));
    await assert.rejects(startDesktopApp({ ...createConfig,
      manualObservation: { shopId: "shop1" } }, { openBrowser: null }));
    const start = () => startDesktopApp(createConfig, { openBrowser: null,
      openCreateList: async ({ shopId }) => {
        opened++;
        assert.equal(shopId, CREATE_TEST_TARGET.shopId);
        assert.equal((await readCreateTestObservation(join(dataDir, "Queue"))).claim.claimed,
          true, "claim must exist before opening the Shops browser");
        browser = context();
        let currentUrl =
          `https://mercari-shops.com/seller/shops/${shopId}/products/2JXdS6R5NNQPJadMexKmTr/edit`;
        localPage = { url: () => currentUrl, setUrl: value => { currentUrl = value; } };
        browser.pages = () => [localPage];
        return { context: browser, page: localPage, state: "LIST_OPEN" };
      },
      observeCreate: (_browser, { target }) => {
        assert.equal(target.skuCode, CREATE_TEST_TARGET.skuCode);
        assert.equal(target.priceYen, 98000);
        return { arm: () => { armed++; }, finish: async () => ({
          status: "MATCHED", reason: "MATCHED", expectedKind: "CREATE_PRODUCT",
          observedKind: "CREATE_PRODUCT", operationName: "CreateProduct",
          newRemoteId: "newPrivateProduct", httpStatus: 200,
          requestTargetMatch: "MATCH", responseTargetMatch: "MATCH",
        }), stop: () => ({ reason: "STOPPED", expectedKind: "CREATE_PRODUCT" }) };
      },
    });
    let app = await start();
    try {
      const csrf = await token(app.url);
      let content = await (await fetch(app.url)).text();
      assert.match(content, /B005757-TEST-20261004-caf445ac6e676343/);
      assert.match(content, /Shops内の全商品に同じ管理コードがないことまでは確認していません/);
      assert.match(content, /98,000円/);
      assert.equal(content.includes("既存商品を非公開で1回保存"), false);
      assert.equal((await post(app.url, csrf, "read")).status, 303);
      assert.equal((await post(app.url, csrf, "create-test-open")).status, 303);
      assert.equal((await post(app.url, csrf, "create-test-open")).status, 303);
      assert.equal(opened, 1);
      assert.equal((await readCreateTestObservation(join(dataDir, "Queue"))).claim.claimed, true);
      assert.equal((await post(app.url, csrf, "create-test-arm")).status, 303);
      assert.equal(armed, 0, "existing product edit page must be rejected");
      localPage.setUrl(`https://mercari-shops.com/seller/shops/${CREATE_TEST_TARGET.shopId}/products/create`);
      assert.equal((await post(app.url, csrf, "create-test-arm")).status, 303);
      assert.equal(armed, 1);
      assert.equal((await post(app.url, csrf, "create-test-finish")).status, 303);
      content = await (await fetch(app.url)).text();
      assert.match(content, /OBSERVED_PRIVATE_CREATE_RESPONSE/);
      assert.match(content, /newPrivateProduct/);
      assert.match(content, /出品完了や公開を判定しません/);
      assert.equal((await readCreateTestObservation(join(dataDir, "Queue"))).result
        .listingConfirmed, false);
      assert.equal((await post(app.url, csrf, "shutdown")).status, 303);
      await assert.rejects(app.close(), /Close the dedicated Shops browser manually/);
      assert.equal(browser.listenerCount("close"), 1);
    } finally {
      if (browser) { await browser.close(); await new Promise(setImmediate); }
      await app.close();
    }
    app = await start();
    try {
      const content = await (await fetch(app.url)).text();
      assert.match(content, /<button disabled>1回限りの登録準備を開始<\/button>/);
      assert.equal(opened, 1);
    } finally { await app.close(); }
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("unknown private-create result retains the browser until the operator closes it", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "bello-desktop-create-unknown-"));
  let browser;
  const createConfig = { ...config(), dataDir, createTestObservationEnabled: true };
  const app = await startDesktopApp(createConfig, { openBrowser: null,
    openCreateList: async ({ shopId }) => {
      browser = context();
      const page = { url: () =>
        `https://mercari-shops.com/seller/shops/${shopId}/products/create` };
      browser.pages = () => [page];
      return { context: browser, page, state: "LIST_OPEN" };
    },
    observeCreate: () => ({ arm() {}, finish: async () => ({
      status: "UNVERIFIED", reason: "TIMEOUT", expectedKind: "CREATE_PRODUCT",
    }), stop: () => ({ reason: "STOPPED", expectedKind: "CREATE_PRODUCT" }) }),
  });
  try {
    const csrf = await token(app.url);
    await post(app.url, csrf, "create-test-open");
    await post(app.url, csrf, "create-test-arm");
    await post(app.url, csrf, "create-test-finish");
    assert.equal((await readCreateTestObservation(join(dataDir, "Queue"))).result.outcome,
      "UNVERIFIED");
    assert.equal((await post(app.url, csrf, "shutdown")).status, 303);
    await assert.rejects(app.close(), /Close the dedicated Shops browser manually/);
    assert.equal(browser.listenerCount("close"), 1);
  } finally {
    if (browser) { await browser.close(); await new Promise(setImmediate); }
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("visible login steps use separate profiles; one explicit read binds the configured ID", async () => {
  const calls = [];
  const app = await startDesktopApp(config(), { openBrowser: async () => {},
    openBello: async (options) => { calls.push(["bello", options]); return context(); },
    openShops: async (options) => { calls.push(["shops", options]); return context(); },
    runRead: async (options) => { calls.push(["read", options]); return { status: "INCOMPLETE" }; } });
  try {
    const csrf = await token(app.url);
    assert.match(await (await fetch(app.url)).text(), /LEGACY_NOT_PERSISTED/);
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
    assert.match(content, /STORE_STATUS_UNCONFIRMED/);
    assert.match(content, /直接送信には使いません/);
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

test("a restarted desktop restores only saved safe traffic metadata", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "bello-desktop-traffic-"));
  try {
    await saveReadTrafficEvidence(join(dataDir, "Queue"), config().requestId,
      "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", [{ host: "mercari-shops.com",
        method: "POST", type: "fetch", path: "/graphql", status: 200, count: 1,
        cookie: "private-cookie" }]);
    const app = await startDesktopApp({ ...config(), dataDir }, { openBrowser: null });
    try {
      const content = await (await fetch(app.url)).text();
      assert.match(content, /通信概要の保存状態: <code>OBSERVED<\/code>/);
      assert.match(content, /POST mercari-shops.com\/graphql/);
      assert.equal(content.includes("private-cookie"), false);
    } finally { await app.close(); }
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("PC exposes one pinned HTTP read proof only after exact evidence and disables it after use", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "bello-desktop-direct-read-"));
  const target = { shopId: "shop1", remoteId: "2JXePE4ke8UCBTj6mxc4cf",
    inventoryCode: "B005795", priceYen: 90000, quantity: 0 };
  try {
    await saveReadTrafficEvidence(join(dataDir, "Queue"), config().requestId,
      "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", [], [{
        method: "POST", host: "mercari-shops.com", path: "/graphql",
        operationType: "query", operationName: "EditProductPage",
        querySha256: PINNED_READ_QUERY_SHA256,
        variableFields: [{ field: "id", type: "string" }], variableShapeComplete: true,
        requestProductMatch: "MATCH", requestShopMatch: "UNOBSERVED",
        responseProductMatch: "MATCH", responseShopMatch: "MATCH",
        graphqlErrors: "NONE", httpStatus: 200, authPresenceObserved: true,
        authPresence: { authorization: false, cookie: true, csrf: false },
      }]);
    let calls = 0;
    const start = () => startDesktopApp({ ...config(), dataDir, manualObservation: target }, {
      openBrowser: null,
      runDirectReadProbe: options => {
        calls++;
        return runPinnedDirectReadProbeOnce({ ...options, probeWaitMs: 20,
          launchPersistentContext: async () => {
            const browser = context();
            const page = { goto: async () => {},
              url: () => `https://mercari-shops.com/seller/shops/${target.shopId}/products/${target.remoteId}/edit` };
            browser.pages = () => [page];
            browser.request = { post: async () => { throw Error("must not send"); } };
            return browser;
          } });
      },
    });
    let app = await start();
    try {
      const csrf = await token(app.url);
      assert.match(await (await fetch(app.url)).text(),
        /<button >既存商品をHTTPで1回読取検証<\/button>/);
      assert.equal((await post(app.url, csrf, "probe-direct-read-once")).status, 303);
      assert.equal((await post(app.url, csrf, "probe-direct-read-once")).status, 303);
      assert.equal(calls, 1);
      assert.match(await (await fetch(app.url)).text(),
        /<button disabled>既存商品をHTTPで1回読取検証<\/button>/);
    } finally { await app.close(); }
    app = await start();
    try {
      assert.match(await (await fetch(app.url)).text(),
        /<button disabled>既存商品をHTTPで1回読取検証<\/button>/);
      assert.equal(calls, 1);
    } finally { await app.close(); }
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("B005757 read-only target exposes HTTP probe without private-save controls", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "bello-desktop-b005757-read-"));
  const requestId = "7ecb7f7837d93390fe5f701abdc62e9acfaf5b35b4b751789c4183a2a376e825";
  const directReadTarget = { shopId: "evkhihBFFNn5hukMS9s36H",
    remoteId: "2JXjWPRVBxjZ2K2vgTGNqy", inventoryCode: "B005757" };
  try {
    await saveReadTrafficEvidence(join(dataDir, "Queue"), requestId,
      "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", [], [{
        method: "POST", host: "mercari-shops.com", path: "/graphql",
        operationType: "query", operationName: "EditProductPage",
        querySha256: PINNED_READ_QUERY_SHA256,
        variableFields: [{ field: "id", type: "string" }], variableShapeComplete: true,
        requestProductMatch: "MATCH", requestShopMatch: "UNOBSERVED",
        responseProductMatch: "MATCH", responseShopMatch: "MATCH",
        graphqlErrors: "NONE", httpStatus: 200, authPresenceObserved: true,
        authPresence: { authorization: false, cookie: true, csrf: false },
      }]);
    const options = { ...config(), dataDir, requestId, directReadTarget };
    await assert.rejects(startDesktopApp({ ...options,
      directReadTarget: { ...directReadTarget, priceYen: 98000 } },
    { openBrowser: null }));
    const app = await startDesktopApp(options, { openBrowser: null });
    try {
      const content = await (await fetch(app.url)).text();
      assert.match(content, /<button >既存商品をHTTPで1回読取検証<\/button>/);
      assert.equal(content.includes("既存商品の通信観測"), false);
      assert.equal(content.includes("既存商品を非公開で1回保存"), false);
      assert.equal(content.includes("既存商品に画像を1枚追加して観測"), false);
    } finally { await app.close(); }
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("B005757 private-image controls require its exact saved SKU and request", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "bello-desktop-b005757-image-"));
  const requestId = "7ecb7f7837d93390fe5f701abdc62e9acfaf5b35b4b751789c4183a2a376e825";
  const manualObservation = { shopId: "evkhihBFFNn5hukMS9s36H",
    remoteId: "2JXjWPRVBxjZ2K2vgTGNqy", inventoryCode: "B005757",
    skuCode: CREATE_TEST_TARGET.skuCode, priceYen: 98000, quantity: 1 };
  const sha256 = "a".repeat(64);
  const imageProof = { sha256,
    path: join(dataDir, "ImageProof", `B005757-${sha256.slice(0, 16)}.jpg`) };
  const options = { ...config(), dataDir, requestId, manualObservation,
    imageProof, imageWorkflowEnabled: true };
  try {
    for (const invalid of [
      { manualObservation: { ...manualObservation, skuCode: "B005757" } },
      { manualObservation: { ...manualObservation, priceYen: 97000 } },
      { manualObservation: { ...manualObservation, quantity: 0 } },
      { requestId: "a".repeat(64) },
      { directReadTarget: { shopId: manualObservation.shopId,
        remoteId: manualObservation.remoteId, inventoryCode: "B005757" } },
    ]) await assert.rejects(startDesktopApp({ ...options, ...invalid }, { openBrowser: null }));
    const app = await startDesktopApp(options, { openBrowser: null,
      runImagePreflight: async () => ({ status: "READY",
        reasonCode: "EXACT_PRIVATE_PRODUCT_READY" }) });
    try {
      const content = await (await fetch(app.url)).text();
      assert.match(content, /画像1枚を追加して非公開保存・確認/);
      assert.match(content, /<button disabled>画像1枚を追加して非公開保存・確認<\/button>/);
      assert.equal(content.includes('value="add-image-once"'), false);
      assert.equal(content.includes('value="save-private-once"'), false);
      const csrf = await token(app.url);
      assert.equal((await post(app.url, csrf, "complete-image-private")).status, 303);
      assert.equal((await post(app.url, csrf, "inspect-image-preflight")).status, 303);
      assert.match(await (await fetch(app.url)).text(),
        /<button >画像1枚を追加して非公開保存・確認<\/button>/);
    } finally { await app.close(); }
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("saved matched HTTP proof has a separate report button and never reruns Shops read", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "bello-desktop-direct-report-"));
  const target = { shopId: "shop1", remoteId: "2JXePE4ke8UCBTj6mxc4cf",
    inventoryCode: "B005795", priceYen: 90000, quantity: 0 };
  const attemptId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const key = createHash("sha256").update(`${target.shopId}:${target.remoteId}`).digest("hex");
  const proofDir = join(dataDir, "Queue", "direct-read-probe-once");
  try {
    await saveReadTrafficEvidence(join(dataDir, "Queue"), config().requestId,
      "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", [], [{
        method: "POST", host: "mercari-shops.com", path: "/graphql",
        operationType: "query", operationName: "EditProductPage",
        querySha256: PINNED_READ_QUERY_SHA256,
        variableFields: [{ field: "id", type: "string" }], variableShapeComplete: true,
        requestProductMatch: "MATCH", requestShopMatch: "UNOBSERVED",
        responseProductMatch: "MATCH", responseShopMatch: "MATCH",
        graphqlErrors: "NONE", httpStatus: 200, authPresenceObserved: true,
        authPresence: { authorization: false, cookie: true, csrf: false },
      }]);
    await mkdir(proofDir, { recursive: true });
    await writeFile(join(proofDir, `${key}.json`), JSON.stringify({ schemaVersion: 1,
      operation: "EXACT_READ_HTTP_PROBE_ONCE", attemptId,
      querySha256: PINNED_READ_QUERY_SHA256, claimedAt: "2026-10-04T11:36:28.164Z" }));
    await writeFile(join(proofDir, `${key}.result.json`), JSON.stringify({ schemaVersion: 1,
      attemptId, outcome: "MATCHED", httpStatus: 200,
      recordedAt: "2026-10-04T11:36:30.506Z" }));
    let reports = 0;
    const app = await startDesktopApp({ ...config(), dataDir, manualObservation: target }, {
      openBrowser: null,
      runDirectReadProbe: async () => { throw Error("must not read Shops"); },
      reportDirectRead: async ({ target: reported }) => {
        assert.deepEqual(reported, target);
        reports++;
        return { listingConfirmed: false };
      },
    });
    try {
      const csrf = await token(app.url);
      assert.match(await (await fetch(app.url)).text(), /保存済みHTTP読取結果をBELLOへ報告/);
      const download = await post(app.url, csrf, "download-direct-read-proof");
      assert.equal(download.status, 200);
      assert.equal(download.headers.get("content-disposition"),
        'attachment; filename="bello-direct-read-proof.json"');
      const exported = await download.json();
      assert.deepEqual(exported, { schemaVersion: 1, kind: "BELLO_PINNED_DIRECT_READ_PROOF",
        requestId: config().requestId, attemptId, accountReference: target.shopId,
        remoteId: target.remoteId, inventoryCode: target.inventoryCode,
        status: "DIRECT_HTTP_READ_CONFIRMED", reasonCode: "PINNED_HTTP_200_MATCHED",
        listingConfirmed: false });
      assert.equal(reports, 0);
      assert.equal((await post(app.url, csrf, "report-direct-read-proof")).status, 303);
      const content = await (await fetch(app.url)).text();
      assert.match(content, /<button disabled>保存済みHTTP読取結果をBELLOへ報告<\/button>/);
      assert.match(content, /出品や書込の確認ではありません/);
      assert.equal((await post(app.url, csrf, "report-direct-read-proof")).status, 303);
      assert.equal(reports, 1);
    } finally { await app.close(); }
  } finally { await rm(dataDir, { recursive: true, force: true }); }
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

test("one PC image button uses the pinned file and stays disabled across restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "bello-desktop-image-"));
  const target = { shopId: "shop1", remoteId: "existing1", inventoryCode: "B005795",
    priceYen: 90000, quantity: 0 };
  const sha256 = "a".repeat(64);
  const imageProof = { sha256, path: join(dataDir, "ImageProof", `B005795-${sha256.slice(0, 16)}.jpg`) };
  let calls = 0;
  let inspections = 0;
  const imageContext = context();
  const imageObserver = { snapshot: () => [], stop: async () => [] };
  const start = () => startDesktopApp({ ...config(), dataDir,
    manualObservation: target, imageProof }, { openBrowser: async () => {},
    inspectImage: async (session, givenTarget) => {
      inspections++;
      assert.equal(session.context, imageContext);
      assert.deepEqual(givenTarget, target);
      return "ORIGINAL_AND_ONE_ADDITION_VISIBLE";
    },
    runImageAdd: async options => {
      calls++;
      assert.deepEqual(options.target, target);
      assert.equal(options.imagePath, imageProof.path);
      assert.equal(options.imageSha256, imageProof.sha256);
      await claimManualImageOnce(options.root, target, sha256);
      return { status: "UNKNOWN", diagnostic: "FILE_SELECT_RETURNED", metadata: [],
        retainedSession: { context: imageContext, observer: imageObserver,
          onClose: callback => imageContext.once("close", callback) } };
    } });
  try {
    let app = await start();
    try {
      const csrf = await token(app.url);
      assert.match(await (await fetch(app.url)).text(), /既存商品に画像を1枚追加して観測/);
      assert.equal((await post(app.url, csrf, "add-image-once")).status, 303);
      assert.equal((await post(app.url, csrf, "add-image-once")).status, 303);
      assert.equal(calls, 1);
      const content = await (await fetch(app.url)).text();
      assert.match(content, /<button disabled>既存商品に画像を1枚追加して観測<\/button>/);
      assert.match(content, /FILE_SELECT_RETURNED/);
      assert.match(content, /<button disabled>このアプリを終了<\/button>/);
      assert.equal((await post(app.url, csrf, "refresh-image-observation")).status, 303);
      assert.equal((await post(app.url, csrf, "inspect-retained-image")).status, 303);
      assert.equal(inspections, 1);
      assert.match(await (await fetch(app.url)).text(),
        /ORIGINAL_AND_ONE_ADDITION_VISIBLE/);
      await imageContext.close();
    } finally { await app.close(); }
    app = await start();
    try {
      assert.match(await (await fetch(app.url)).text(),
        /<button disabled>既存商品に画像を1枚追加して観測<\/button>/);
      assert.equal(calls, 1);
    } finally { await app.close(); }
  } finally {
    assert.equal(resolve(dataDir).startsWith(resolve(tmpdir()) + "\\"), true);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("unified private-image action is explicit and old attempts disable it", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "bello-desktop-unified-"));
  const target = { shopId: "shop1", remoteId: "existing1", inventoryCode: "B005795",
    priceYen: 90000, quantity: 0 };
  const sha256 = "a".repeat(64);
  const imageProof = { sha256, path: join(dataDir, "ImageProof", `B005795-${sha256.slice(0, 16)}.jpg`) };
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const start = () => startDesktopApp({ ...config(), dataDir, manualObservation: target,
    imageProof, imageWorkflowEnabled: true }, { openBrowser: async () => {},
    runWorkflow: async options => {
      calls++;
      assert.deepEqual(options.target, target);
      await claimPrivateImageWorkflow(options.root, target, sha256);
      options.onStage("SAVE_CLAIMED");
      await gate;
      return { status: "UNKNOWN", stage: "SAVE_ACK_UNVERIFIED" };
    } });
  try {
    const app = await start();
    try {
      const csrf = await token(app.url);
      const before = await (await fetch(app.url)).text();
      assert.match(before, /画像1枚を追加して非公開保存・確認/);
      assert.equal(before.includes('value="add-image-once"'), false);
      assert.equal(before.includes('value="save-private-once"'), false);
      assert.equal((await post(app.url, csrf, "complete-image-private")).status, 303);
      let during = "";
      for (let attempt = 0; attempt < 20; attempt++) {
        during = await (await fetch(app.url)).text();
        if (during.includes("SAVE_CLAIMED")) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.match(during, /http-equiv="refresh" content="2"/);
      assert.match(during, /SAVE_CLAIMED/);
      assert.equal((await post(app.url, csrf, "complete-image-private")).status, 403);
      release();
      for (let attempt = 0; attempt < 20; attempt++) {
        const content = await (await fetch(app.url)).text();
        if (content.includes("SAVE_ACK_UNVERIFIED") &&
            !content.includes('http-equiv="refresh"')) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal((await post(app.url, csrf, "complete-image-private")).status, 303);
      assert.equal(calls, 1);
      const after = await (await fetch(app.url)).text();
      assert.match(after, /SAVE_ACK_UNVERIFIED/);
      assert.match(after, /<button disabled>画像1枚を追加して非公開保存・確認<\/button>/);
    } finally { release(); await app.close(); }
    const restarted = await start();
    try {
      const after = await (await fetch(restarted.url)).text();
      assert.match(after, /<button disabled>画像1枚を追加して非公開保存・確認<\/button>/);
      assert.equal(calls, 1);
    } finally { await restarted.close(); }
  } finally {
    assert.equal(resolve(dataDir).startsWith(resolve(tmpdir()) + "\\"), true);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("pre-claim failures remain visible and cannot be repeated in one PC session", async () => {
  for (const status of ["AUTH_REQUIRED", "PREFLIGHT_BLOCKED"]) {
    const dataDir = await mkdtemp(join(tmpdir(), "bello-desktop-preclaim-"));
    const target = { shopId: "shop1", remoteId: "existing1", inventoryCode: "B005795",
      priceYen: 90000, quantity: 0 };
    const sha256 = "a".repeat(64);
    const imageProof = { sha256,
      path: join(dataDir, "ImageProof", `B005795-${sha256.slice(0, 16)}.jpg`) };
    let runs = 0;
    const app = await startDesktopApp({ ...config(), dataDir, manualObservation: target,
      imageProof, imageWorkflowEnabled: true }, {
      openBrowser: async () => {},
      runImagePreflight: async () => ({ status, reasonCode: status === "AUTH_REQUIRED" ?
        "LOGIN_REQUIRED" : "FIELDS_UNVERIFIED" }),
      runWorkflow: async () => { runs++; return { status }; },
    });
    try {
      const csrf = await token(app.url);
      assert.equal((await post(app.url, csrf, "inspect-image-preflight")).status, 303);
      assert.match(await (await fetch(app.url)).text(),
        new RegExp(`事前確認: <strong>${status}</strong>`));
      assert.equal((await post(app.url, csrf, "complete-image-private")).status, 303);
      let content = "";
      for (let attempt = 0; attempt < 20; attempt++) {
        content = await (await fetch(app.url)).text();
        if (content.includes("PRECLAIM")) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.match(content, new RegExp(`結果: <strong>${status}</strong> / 段階: <code>PRECLAIM`));
      assert.match(content, /<button disabled>画像1枚を追加して非公開保存・確認<\/button>/);
      assert.equal((await post(app.url, csrf, "complete-image-private")).status, 303);
      assert.equal(runs, 1);
    } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
  }
});

test("existing attempts expose a separate read-only confirmation with prior outcome codes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "bello-desktop-readback-"));
  const target = { shopId: "shop1", remoteId: "existing1", inventoryCode: "B005795",
    priceYen: 90000, quantity: 0 };
  const sha256 = "a".repeat(64);
  const imageProof = { sha256,
    path: join(dataDir, "ImageProof", `B005795-${sha256.slice(0, 16)}.jpg`) };
  let reads = 0;
  try {
    const root = join(dataDir, "Queue");
    await claimManualImageOnce(root, target, sha256);
    await claimManualSaveOnce(root, target);
    const app = await startDesktopApp({ ...config(), dataDir,
      manualObservation: target, imageProof }, { openBrowser: async () => {},
      runSavedProductReadback: async options => {
        reads++;
        assert.deepEqual(options.target, target);
        return { status: "OBSERVED_PRIVATE_TWO_IMAGES", imageOutcome: "UNKNOWN",
          saveOutcome: "BLOCKED_BEFORE_CLICK" };
      } });
    try {
      const csrf = await token(app.url);
      const before = await (await fetch(app.url)).text();
      assert.match(before, /既存商品を読取で再確認/);
      assert.match(before, /<button disabled>既存商品を非公開で1回保存<\/button>/);
      assert.equal((await post(app.url, csrf, "verify-saved-product-readonly")).status, 303);
      assert.equal(reads, 1);
      const after = await (await fetch(app.url)).text();
      assert.match(after, /OBSERVED_PRIVATE_TWO_IMAGES/);
      assert.match(after, /BLOCKED_BEFORE_CLICK/);
      assert.match(after, /過去の保存要求が成功した証明ではありません/);
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
