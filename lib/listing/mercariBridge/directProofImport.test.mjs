import assert from "node:assert/strict";
import { test } from "node:test";
import { directProofReportFromExport, reportSavedDirectProofInTab } from "./directProofImport.ts";

const requestId = "a".repeat(64);
const attemptId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const proof = { schemaVersion: 1, kind: "BELLO_PINNED_DIRECT_READ_PROOF",
  requestId, attemptId, accountReference: "shop-one",
  remoteId: "2JXePE4ke8UCBTj6mxc4cf", inventoryCode: "B005795",
  status: "DIRECT_HTTP_READ_CONFIRMED", reasonCode: "PINNED_HTTP_200_MATCHED",
  listingConfirmed: false };
const dispatch = { requestId, operation: "READ_EXISTING", accountReference: "shop-one",
  remoteId: proof.remoteId, inventoryCode: proof.inventoryCode };

test("pinned proof export forms only the bounded result accepted by BELLO", () => {
  assert.deepEqual(directProofReportFromExport(proof, dispatch), {
    requestId, attemptId, accountReference: "shop-one", remoteId: proof.remoteId,
    status: "DIRECT_HTTP_READ_CONFIRMED", comparison: null,
    reasonCode: "PINNED_HTTP_200_MATCHED",
  });
});

test("proof import rejects another request, target, outcome, or extra fields", () => {
  for (const invalid of [
    { ...proof, requestId: "b".repeat(64) },
    { ...proof, remoteId: "another" },
    { ...proof, inventoryCode: "OTHER" },
    { ...proof, listingConfirmed: true },
    { ...proof, status: "CORE_FIELDS_MATCH" },
    { ...proof, secret: "must-not-send" },
  ]) assert.throws(() => directProofReportFromExport(invalid, dispatch));
  assert.throws(() => directProofReportFromExport(proof, { ...dispatch, accountReference: "other" }));
});

const file = { size: 398, text: async () => JSON.stringify(proof) };
const reply = value => Response.json(value);
const receipt = { ok: true, stored: true, requestId, attemptId,
  readStatus: "DIRECT_HTTP_READ_CONFIRMED", listingConfirmed: false };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("current request reports the bounded receipt and refreshes its results", async () => {
  const calls = [];
  const outcome = await reportSavedDirectProofInTab({ requestId, file,
    isCurrent: () => true, refresh: async () => { calls.push("refresh"); },
    fetchImpl: async (_path, options) => {
      calls.push(options.method);
      if (options.method === "GET") return reply({ ok: true, job: dispatch });
      assert.deepEqual(JSON.parse(options.body), directProofReportFromExport(proof, dispatch));
      return reply(receipt);
    } });
  assert.equal(outcome, "REPORTED");
  assert.deepEqual(calls, ["GET", "POST", "refresh"]);
});

test("switching request ID during owner GET prevents a stale proof POST", async () => {
  let current = true;
  let posts = 0;
  let refreshes = 0;
  const getStarted = deferred();
  const getResponse = deferred();
  const reporting = reportSavedDirectProofInTab({ requestId, file,
    isCurrent: () => current, refresh: async () => { refreshes++; },
    fetchImpl: async (_path, options) => {
      if (options.method === "POST") { posts++; return reply(receipt); }
      getStarted.resolve();
      return getResponse.promise;
    } });
  await getStarted.promise;
  current = false;
  getResponse.resolve(reply({ ok: true, job: dispatch }));
  assert.equal(await reporting, "STALE");
  assert.equal(posts, 0);
  assert.equal(refreshes, 0);
});

test("switching request ID after an accepted POST never refreshes the former request", async () => {
  let current = true;
  let refreshes = 0;
  const postStarted = deferred();
  const postResponse = deferred();
  const reporting = reportSavedDirectProofInTab({ requestId, file,
    isCurrent: () => current, refresh: async () => { refreshes++; },
    fetchImpl: async (_path, options) => {
      if (options.method === "GET") return reply({ ok: true, job: dispatch });
      postStarted.resolve();
      return postResponse.promise;
    } });
  await postStarted.promise;
  current = false;
  postResponse.resolve(reply(receipt));
  assert.equal(await reporting, "STALE");
  assert.equal(refreshes, 0);
});

test("switching request ID while results refresh suppresses old success", async () => {
  let current = true;
  const refreshStarted = deferred();
  const refreshDone = deferred();
  const reporting = reportSavedDirectProofInTab({ requestId, file,
    isCurrent: () => current,
    refresh: async () => { refreshStarted.resolve(); await refreshDone.promise; },
    fetchImpl: async (_path, options) => options.method === "GET" ?
      reply({ ok: true, job: dispatch }) : reply(receipt) });
  await refreshStarted.promise;
  current = false;
  refreshDone.resolve();
  assert.equal(await reporting, "STALE");
});
