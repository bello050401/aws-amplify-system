import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openBelloAdminContext } from "../src/belloSession.mjs";
import { BridgeBoundaryError, reportPinnedDirectReadProofOnce,
  reportSavedReadResultOnce, runBelloCloudReadOnce } from "../src/cloudConnector.mjs";
import { PINNED_READ_QUERY_SHA256 } from "../src/directReadProbe.mjs";
import { enqueueExistingRead, saveReadResult } from "../src/queue.mjs";
import { latestReadTrafficEvidence, saveReadTrafficEvidence } from "../src/trafficEvidence.mjs";

const origin = "https://bello.example.test";
const requestId = "a".repeat(64);
const dispatch = { requestId, operation: "READ_EXISTING", accountReference: "shopABCDEFGH",
  remoteId: "productABCDEFGH", inventoryCode: "B005795",
  expectedFields: { title: "Private QA title", description: "No actual stock", priceYen: 90000, quantity: 0 } };

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "bello-cloud-bridge-test-"));
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("separate BELLO profile opens only the regular login and rejects another origin", async () => withRoot(async root => {
  const visited = [];
  const context = { pages: () => [], newPage: async () => ({ goto: async url => visited.push(url) }),
    close: async () => {} };
  await openBelloAdminContext({ origin, profileDir: join(root, "bello-profile"),
    navigateToLogin: true, launchPersistentContext: async (path, options) => {
      assert.equal(path, join(root, "bello-profile"));
      assert.deepEqual(options, { channel: "chrome", headless: false });
      return context;
    } });
  assert.deepEqual(visited, [`${origin}/inventory/login`]);
  await assert.rejects(openBelloAdminContext({ origin: "https://another.example.test",
    profileDir: join(root, "bello-profile"), launchPersistentContext: async () => context }));
  const existing = join(root, "existing-profile");
  await mkdir(existing);
  await writeFile(join(existing, "Cookies"), "existing browser data");
  await assert.rejects(openBelloAdminContext({ origin, profileDir: existing,
    launchPersistentContext: async () => context }));
}));

test("signed-in ADMIN context fetches exact read and reports only a sanitized attempt", async () => withRoot(async root => {
  const calls = [];
  let closed = false;
  const context = { request: {
    async get(url, options) {
      calls.push({ method: "GET", url, options });
      return { ok: () => true, json: async () => ({ ok: true, job: dispatch }) };
    },
    async post(url, options) {
      calls.push({ method: "POST", url, options });
      const body = JSON.parse(options.data);
      assert.deepEqual(Object.keys(body).sort(), ["accountReference", "attemptId", "comparison",
        "reasonCode", "remoteId", "requestId", "status"]);
      assert.equal(body.requestId, requestId);
      assert.equal(body.status, "AUTH_REQUIRED");
      assert.equal(body.comparison, null);
      return { ok: () => true, json: async () => ({ ok: true, stored: true,
        requestId, attemptId: body.attemptId, readStatus: body.status, listingConfirmed: false }) };
    },
  }, close: async () => { closed = true; } };
  let localRun;
  let evidenceStatus;
  const result = await runBelloCloudReadOnce({ origin, requestId, root: join(root, "queue"),
    belloProfileDir: join(root, "bello-profile"), shopsProfileDir: join(root, "shops-profile"),
    browserRead: true, launchBelloContext: async () => context,
    onTrafficEvidenceStatus: status => { evidenceStatus = status; },
    runLocalRead: async (path, account, jobId, reader) => {
      localRun = { path, account, jobId, reader };
      return { attemptId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
        accountReference: account, remoteId: dispatch.remoteId, status: "AUTH_REQUIRED",
        comparison: null, reasonCode: "SIGN_IN_REQUIRED" };
    } });
  assert.equal(result.listingConfirmed, false);
  assert.equal(localRun.account, dispatch.accountReference);
  assert.equal(typeof localRun.reader.readExactProduct, "function");
  assert.equal(evidenceStatus, "NOT_CAPTURED");
  assert.equal((await latestReadTrafficEvidence(join(root, "queue"), requestId)).directHttpAllowed, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.maxRedirects, 0);
  assert.equal(calls[1].options.maxRedirects, 0);
  assert.equal(calls[1].options.headers.Origin, origin);
  assert.equal(calls[1].options.headers["x-bello-mercari-bridge"], "READ_EXISTING");
  assert.equal(closed, true);
}));

test("unowned request, wrong dispatch, or wrong receipt stops without success", async () => withRoot(async root => {
  for (const firstResponse of [
    { ok: () => false },
    { ok: () => true, json: async () => ({ ok: true, job: { ...dispatch, operation: "CREATE_PRODUCT" } }) },
  ]) {
    const context = { request: { get: async () => firstResponse,
      post: async () => { throw Error("must not post"); } }, close: async () => {} };
    await assert.rejects(runBelloCloudReadOnce({ origin, requestId, root: join(root, "queue"),
      belloProfileDir: join(root, "profile"), launchBelloContext: async () => context,
      runLocalRead: async () => { throw Error("must not read"); } }));
  }
  await assert.rejects(runBelloCloudReadOnce({ origin: "http://bello.example.test", requestId,
    root: join(root, "queue"), belloProfileDir: join(root, "profile") }));
}));

test("one saved attempt can be reported without another Shops read or a new attempt", async () => withRoot(async root => {
  const queueRoot = join(root, "queue");
  const job = await enqueueExistingRead(queueRoot, { accountReference: dispatch.accountReference,
    remoteId: dispatch.remoteId, inventoryCode: dispatch.inventoryCode,
    expectedFields: dispatch.expectedFields });
  const saved = await saveReadResult(queueRoot, job.jobId, { accountReference: dispatch.accountReference,
    remoteId: dispatch.remoteId, status: "UNKNOWN", comparison: null, reasonCode: "UNVERIFIED_READ" });
  const calls = [];
  const context = { request: {
    get: async () => { calls.push("GET"); return { ok: () => true,
      json: async () => ({ ok: true, job: dispatch }) }; },
    post: async (url, options) => {
      calls.push("POST");
      const report = JSON.parse(options.data);
      assert.equal(report.attemptId, saved.attemptId);
      assert.equal(report.status, "UNKNOWN");
      assert.equal(report.reasonCode, "UNVERIFIED_READ");
      assert.equal(report.comparison, null);
      return { ok: () => true, json: async () => ({ ok: true, stored: true,
        requestId, attemptId: saved.attemptId, readStatus: saved.status, listingConfirmed: false }) };
    },
  }, close: async () => {} };
  const result = await reportSavedReadResultOnce({ origin, requestId, root: queueRoot,
    belloProfileDir: join(root, "bello-profile"), jobId: job.jobId, attemptId: saved.attemptId,
    launchBelloContext: async () => context });
  assert.deepEqual(calls, ["GET", "POST"]);
  assert.deepEqual(result, { requestId, attemptId: saved.attemptId, status: "UNKNOWN", listingConfirmed: false });
}));

test("saved result mismatch blocks POST and HTTP failure exposes only fixed diagnostics", async () => withRoot(async root => {
  const queueRoot = join(root, "queue");
  const job = await enqueueExistingRead(queueRoot, { accountReference: dispatch.accountReference,
    remoteId: dispatch.remoteId, inventoryCode: dispatch.inventoryCode,
    expectedFields: dispatch.expectedFields });
  const saved = await saveReadResult(queueRoot, job.jobId, { accountReference: dispatch.accountReference,
    remoteId: dispatch.remoteId, status: "UNKNOWN", comparison: null, reasonCode: "UNVERIFIED_READ" });
  const get = async () => ({ ok: () => true, json: async () => ({ ok: true, job: dispatch }) });
  const mismatched = { request: { get: async () => ({ ok: () => true,
    json: async () => ({ ok: true, job: { ...dispatch, expectedFields: { ...dispatch.expectedFields, title: "changed" } } }) }),
    post: async () => { throw Error("must not post"); } }, close: async () => {} };
  await assert.rejects(reportSavedReadResultOnce({ origin, requestId, root: queueRoot,
    belloProfileDir: join(root, "bello-profile"), jobId: job.jobId, attemptId: saved.attemptId,
    launchBelloContext: async () => mismatched }), error =>
    error instanceof BridgeBoundaryError && error.phase === "SAVED_RESULT_MISMATCH");
  const rejected = { request: { get, post: async () => ({ ok: () => false, status: () => 409,
    json: async () => ({ ok: false, code: "INVALID_RESULT", secret: "must not surface" }) }) }, close: async () => {} };
  await assert.rejects(reportSavedReadResultOnce({ origin, requestId, root: queueRoot,
    belloProfileDir: join(root, "bello-profile"), jobId: job.jobId, attemptId: saved.attemptId,
    launchBelloContext: async () => rejected }), error =>
    error instanceof BridgeBoundaryError && error.phase === "RESULT_POST_HTTP" &&
    error.httpStatus === 409 && error.serverCode === "INVALID_RESULT" &&
    !JSON.stringify(error).includes("must not surface"));
}));

test("an existing pinned HTTP 200 proof reports once without another Shops request", async () => withRoot(async root => {
  const queueRoot = join(root, "queue");
  const target = { shopId: dispatch.accountReference,
    remoteId: "2JXePE4ke8UCBTj6mxc4cf", inventoryCode: "B005795" };
  const exactDispatch = { ...dispatch, remoteId: target.remoteId };
  const attemptId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await saveReadTrafficEvidence(queueRoot, requestId,
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
  const key = createHash("sha256").update(`${target.shopId}:${target.remoteId}`).digest("hex");
  const proofDir = join(queueRoot, "direct-read-probe-once");
  await mkdir(proofDir);
  await writeFile(join(proofDir, `${key}.json`), JSON.stringify({ schemaVersion: 1,
    operation: "EXACT_READ_HTTP_PROBE_ONCE", attemptId,
    querySha256: PINNED_READ_QUERY_SHA256, claimedAt: "2026-10-04T11:36:28.164Z" }));
  await writeFile(join(proofDir, `${key}.result.json`), JSON.stringify({ schemaVersion: 1,
    attemptId, outcome: "MATCHED", httpStatus: 200,
    recordedAt: "2026-10-04T11:36:30.506Z" }));
  const calls = [];
  const context = { request: {
    get: async () => { calls.push("GET"); return { ok: () => true,
      json: async () => ({ ok: true, job: exactDispatch }) }; },
    post: async (_url, options) => {
      calls.push("POST");
      const report = JSON.parse(options.data);
      assert.deepEqual(report, { requestId, attemptId,
        accountReference: target.shopId, remoteId: target.remoteId,
        status: "DIRECT_HTTP_READ_CONFIRMED", comparison: null,
        reasonCode: "PINNED_HTTP_200_MATCHED" });
      return { ok: () => true, json: async () => ({ ok: true, stored: true,
        requestId, attemptId, readStatus: report.status, listingConfirmed: false }) };
    },
  }, close: async () => { calls.push("CLOSE"); } };
  const args = { origin, requestId, root: queueRoot, belloProfileDir: join(root, "BELLOChrome"),
    target, launchBelloContext: async () => context };
  assert.deepEqual(await reportPinnedDirectReadProofOnce(args), {
    requestId, attemptId, status: "DIRECT_HTTP_READ_CONFIRMED", listingConfirmed: false,
  });
  assert.deepEqual(calls, ["GET", "POST", "CLOSE"]);
  calls.length = 0;
  await assert.rejects(reportPinnedDirectReadProofOnce({ ...args,
    target: { ...target, inventoryCode: "WRONG" } }), error =>
    error instanceof BridgeBoundaryError && error.phase === "DIRECT_PROOF_TARGET_MISMATCH");
  assert.deepEqual(calls, ["GET", "CLOSE"]);
}));
