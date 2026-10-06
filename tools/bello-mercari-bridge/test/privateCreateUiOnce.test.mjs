import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { exactNewDraftId, exactPinnedPrivateCreateJob,
  exactPrivateCreateResponse, runPinnedPrivateCreateUiOnce } from
  "../src/privateCreateUiOnce.mjs";

const createUrl = "https://mercari-shops.com/seller/shops/evkhihBFFNn5hukMS9s36H/products/create";

test("new create URL rejects the old unattributed draft and extra query state", () => {
  assert.deepEqual(exactNewDraftId(createUrl), { valid: true, id: null });
  assert.deepEqual(exactNewDraftId(`${createUrl}?productDraftId=fresh123`),
    { valid: true, id: "fresh123" });
  assert.equal(exactNewDraftId(`${createUrl}?productDraftId=2JXmhh6wZFnKBnhwk8zV9c`).valid,
    false);
  assert.equal(exactNewDraftId(`${createUrl}?productDraftId=fresh123&x=1`).valid,
    false);
  assert.equal(exactNewDraftId(createUrl.replace("/create", "/2JWp7EJx6aqKfn6dTXc5Q9/edit")).valid,
    false);
});

test("only a unique private response without competing draft IDs may be promoted", () => {
  const event = { httpStatus: 200, resultId: "newProduct123",
    resultState: "UNOPENED" };
  const observed = { captureStatus: "UNVERIFIED", events: [event], draftIds: [] };
  assert.equal(exactPrivateCreateResponse(observed), "newProduct123");
  assert.equal(exactPrivateCreateResponse({ ...observed, captureStatus: "TRUNCATED" }), null);
  assert.equal(exactPrivateCreateResponse({ ...observed,
    events: [event, { ...event, resultId: "anotherProduct" }] }), null);
  assert.equal(exactPrivateCreateResponse({ ...observed,
    draftIds: [{ id: "draft1" }, { id: "draft2" }] }), null);
  assert.equal(exactPrivateCreateResponse({ ...observed,
    draftIds: [{ id: "2JXmhh6wZFnKBnhwk8zV9c" }] }), null);
  assert.equal(exactPrivateCreateResponse({ ...observed,
    events: [{ ...event, resultState: "OPENED" }] }), null);
  assert.equal(exactPrivateCreateResponse({ ...observed,
    events: [{ ...event, resultId: "2JWp7EJx6aqKfn6dTXc5Q9" }] }), null);
});

test("a prepared job cannot be replaced by a shaped but different snapshot", () => {
  assert.equal(exactPinnedPrivateCreateJob(null), null);
  assert.equal(exactPinnedPrivateCreateJob({ snapshotJson: "{}" }), null);
  assert.equal(exactPinnedPrivateCreateJob({ snapshotJson: "not json" }), null);
});

test("authentication uncertainty records UNKNOWN and never enters the create UI", async () => {
  let launches = 0;
  let observationWrites = 0;
  let saved = null;
  let closed = false;
  const session = { state: "AUTH_REQUIRED",
    page: { url: () => "https://mercari-shops.com/signin/seller" },
    claim: { attemptId: "test-attempt" },
    observer: { stop: async () => ({ captureStatus: "UNVERIFIED",
      events: [], draftIds: [] }) },
    context: { close: async () => { closed = true; } } };
  const result = await runPinnedPrivateCreateUiOnce({
    root: resolve("queue"), profileDir: resolve("profile"),
    playwrightModulePath: resolve("playwright"), imagePath: resolve("image.jpg"),
  }, {
    preflight: async () => ({ job: { snapshotFingerprint: "pinned" },
      snapshot: {}, imageBytes: Buffer.from("unused"), image: {} }),
    openSession: async () => { launches += 1; return session; },
    recordObservation: async () => { observationWrites += 1; },
    saveResult: async (_root, value) => { saved = value; },
  });
  assert.equal(launches, 1);
  assert.equal(observationWrites, 1);
  assert.equal(saved.outcome, "UNKNOWN");
  assert.equal(saved.remoteId, null);
  assert.equal(saved.listingConfirmed, false);
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.retainedSession, session);
  assert.equal(closed, false);
});

test("a consumed claim from a blocked restored browser is recorded UNKNOWN", async () => {
  let saved = null;
  const blocked = Error("FUTURE_CREATE_BROWSER_UNAVAILABLE");
  blocked.claim = { attemptId: "test-attempt",
    shopId: "evkhihBFFNn5hukMS9s36H" };
  const result = await runPinnedPrivateCreateUiOnce({
    root: resolve("queue"), profileDir: resolve("profile"),
    playwrightModulePath: resolve("playwright"), imagePath: resolve("image.jpg"),
  }, {
    preflight: async () => ({ job: { snapshotFingerprint: "pinned" },
      snapshot: {}, imageBytes: Buffer.from("unused"), image: {} }),
    openSession: async () => { throw blocked; },
    saveResult: async (_root, value) => { saved = value; },
  });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.retainedSession, null);
  assert.equal(saved.attemptId, "test-attempt");
  assert.equal(saved.diagnosticStage, "BROWSER_UNAVAILABLE");
  assert.equal(saved.listingConfirmed, false);
});
