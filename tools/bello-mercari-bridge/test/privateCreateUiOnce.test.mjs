import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { exactNewDraftId, exactPinnedPrivateCreateJob,
  exactPrivateCreateResponse, exactFormFieldReadback, sameUploadedAsset,
  classifyPrivateCreateListEntry, eligibleForPinnedPrivateCreateNotSent,
  runPinnedPrivateCreateUiOnce } from
  "../src/privateCreateUiOnce.mjs";

const listUrl = "https://mercari-shops.com/seller/shops/evkhihBFFNn5hukMS9s36H/products?tab=on_sale&visibility=unopened";

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
  for (const conflicting of [
    { ...event, resultId: "anotherPublic", resultState: "OPENED" },
    { ...event, resultId: "2JWp7EJx6aqKfn6dTXc5Q9", resultState: "OPENED" },
    { httpStatus: 500, resultId: null, resultState: null,
      responseJsonKeys: ["data", "data.createProduct"] },
  ]) {
    assert.equal(exactPrivateCreateResponse({ ...observed,
      events: [event, conflicting] }), null);
  }
});

test("title and description preserve whitespace while yen price alone is normalized", () => {
  assert.equal(exactFormFieldReadback("name", "A  B", "A  B"), true);
  assert.equal(exactFormFieldReadback("name", "A B", "A  B"), false);
  assert.equal(exactFormFieldReadback("description", "first\n\nsecond", "first\n\nsecond"), true);
  assert.equal(exactFormFieldReadback("description", "first second", "first\n\nsecond"), false);
  assert.equal(exactFormFieldReadback("price", "¥99,999", "99999"), true);
  assert.equal(exactFormFieldReadback("price", "9 9999", "99999"), false);
});

test("a saved image must match the selected asset path and size", () => {
  const selected = [{ pathHash: "a".repeat(64), width: 960, height: 960 }];
  assert.equal(sameUploadedAsset(selected, structuredClone(selected)), true);
  assert.equal(sameUploadedAsset(selected,
    [{ ...selected[0], pathHash: "b".repeat(64) }]), false);
  assert.equal(sameUploadedAsset(selected,
    [{ ...selected[0], width: 100 }]), false);
  assert.equal(sameUploadedAsset(selected, []), false);
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
  assert.equal(saved.entryDiagnostic, "AUTH_REQUIRED");
  assert.equal(saved.reasonCode, "LIST_UNAVAILABLE");
  assert.deepEqual(saved.attempted, { createClick: false, fieldsOrFile: false,
    privateSaveClick: false });
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.retainedSession, session);
  assert.equal(closed, false);
});

test("fixed list classification omits raw URLs and secret query values", () => {
  assert.equal(classifyPrivateCreateListEntry("UNKNOWN", listUrl), "EXACT_LIST");
  assert.equal(classifyPrivateCreateListEntry("UNKNOWN", `${listUrl}&token=secret`),
    "LIST_FILTER_CHANGED");
  assert.equal(classifyPrivateCreateListEntry("UNKNOWN", "https://mercari-shops.com/signin/seller?token=secret"),
    "SIGN_IN");
  assert.equal(classifyPrivateCreateListEntry("UNKNOWN", "https://example.com/?token=secret"),
    "OTHER_ORIGIN");
});

test("late list navigation is rechecked before the single create-link click", async () => {
  let url = "about:blank";
  let clicked = 0;
  let saved;
  const createLink = { waitFor: async () => {}, count: async () => 1,
    isEnabled: async () => true,
    click: async () => { clicked += 1; throw Error("simulated uncertain click"); } };
  const session = { state: "UNKNOWN",
    page: { url: () => url, waitForURL: async expected => {
      assert.equal(expected, listUrl); url = listUrl;
    }, getByRole: () => createLink },
    claim: { attemptId: "test-attempt" },
    observer: { stop: async () => ({ captureStatus: "UNVERIFIED",
      events: [], draftIds: [] }) } };
  const result = await runPinnedPrivateCreateUiOnce({
    root: resolve("queue"), profileDir: resolve("profile"),
    playwrightModulePath: resolve("playwright"), imagePath: resolve("image.jpg"),
  }, {
    preflight: async () => ({ job: { snapshotFingerprint: "pinned" },
      snapshot: {}, imageBytes: Buffer.from("unused"), image: {} }),
    openSession: async () => session,
    recordObservation: async () => {},
    saveResult: async (_root, value) => { saved = value; },
  });
  assert.equal(clicked, 1);
  assert.equal(saved.entryDiagnostic, "EXACT_LIST");
  assert.equal(saved.diagnosticStage, "CREATE_PAGE_UNCERTAIN");
  assert.equal(saved.attempted.createClick, true);
  assert.equal(result.status, "UNKNOWN");
});

test("a missing create link records a fixed pre-click reason", async () => {
  let saved;
  const session = { state: "LIST_OPEN",
    page: { url: () => listUrl, getByRole: () => ({
      waitFor: async () => { throw Error("not rendered"); },
    }) }, claim: { attemptId: "test-attempt" },
    observer: { stop: async () => ({ captureStatus: "UNVERIFIED",
      events: [], draftIds: [] }) } };
  await runPinnedPrivateCreateUiOnce({
    root: resolve("queue"), profileDir: resolve("profile"),
    playwrightModulePath: resolve("playwright"), imagePath: resolve("image.jpg"),
  }, {
    preflight: async () => ({ job: { snapshotFingerprint: "pinned" },
      snapshot: {}, imageBytes: Buffer.from("unused"), image: {} }),
    openSession: async () => session,
    recordObservation: async () => {},
    saveResult: async (_root, value) => { saved = value; },
  });
  assert.equal(saved.diagnosticStage, "CLAIMED");
  assert.equal(saved.entryDiagnostic, "LINK_UNAVAILABLE");
  assert.equal(saved.reasonCode, "LINK_UNAVAILABLE");
  assert.equal(saved.attempted.createClick, false);
});

test("duplicate or disabled create links remain pre-click", async () => {
  for (const [count, enabled] of [[2, true], [1, false]]) {
    let saved;
    const session = { state: "LIST_OPEN",
      page: { url: () => listUrl, getByRole: () => ({
        waitFor: async () => {}, count: async () => count,
        isEnabled: async () => enabled,
      }) }, claim: { attemptId: "test-attempt" },
      observer: { stop: async () => ({ captureStatus: "UNVERIFIED",
        events: [], draftIds: [] }) } };
    await runPinnedPrivateCreateUiOnce({
      root: resolve("queue"), profileDir: resolve("profile"),
      playwrightModulePath: resolve("playwright"), imagePath: resolve("image.jpg"),
    }, {
      preflight: async () => ({ job: { snapshotFingerprint: "pinned" },
        snapshot: {}, imageBytes: Buffer.from("unused"), image: {} }),
      openSession: async () => session,
      recordObservation: async () => {},
      saveResult: async (_root, value) => { saved = value; },
    });
    assert.equal(saved.diagnosticStage, "CLAIMED");
    assert.equal(saved.reasonCode, "LINK_UNAVAILABLE");
    assert.equal(saved.attempted.createClick, false);
  }
});

test("NOT_SENT eligibility requires complete no-click and no-traffic proof", () => {
  const inventoryFingerprint = createHash("sha256")
    .update("dd273c1e-9b2a-4013-acc6-c445a481fab8").digest("hex");
  const claim = { operation: "OBSERVE_FUTURE_PRIVATE_CREATE_ONCE",
    shopId: "evkhihBFFNn5hukMS9s36H", attemptId: "test-attempt",
    outcome: "UNKNOWN", listingConfirmed: false,
    inventoryFingerprint,
    snapshotFingerprint: "63ec8ca8b8a390fb58f67b5fac09cd3d0fd8641aa82aee164bc67b07d55c81be",
    claimedAt: "2026-10-07T00:00:00.000Z" };
  const result = { attemptId: claim.attemptId, shopId: claim.shopId,
    inventoryFingerprint: claim.inventoryFingerprint,
    snapshotFingerprint: claim.snapshotFingerprint,
    outcome: "UNKNOWN", remoteId: null, listingConfirmed: false,
    diagnosticStage: "CLAIMED", reasonCode: "LINK_UNAVAILABLE",
    attempted: { createClick: false, fieldsOrFile: false,
      privateSaveClick: false }, observationCaptureStatus: "UNVERIFIED",
    recordedAt: "2026-10-07T00:01:00.000Z" };
  const observation = { attemptId: claim.attemptId,
    outcome: "OBSERVED_UNVERIFIED", captureStatus: "UNVERIFIED",
    events: [], draftIds: [] };
  const empty = { complete: true, managementCodeMatches: 0,
    titleMatches: 0, price99999Matches: 0 };
  const readback = { shopId: claim.shopId,
    inventoryId: "dd273c1e-9b2a-4013-acc6-c445a481fab8",
    managementCode: "TEST_B005659_E51E4F6B7B86DD150546", priceYen: 99999,
    onSaleAllVisibility: empty, draftAllPages: empty,
    observedAt: "2026-10-07T00:02:00.000Z" };
  assert.equal(eligibleForPinnedPrivateCreateNotSent({ claim, result,
    observation, readback }), true);
  assert.equal(eligibleForPinnedPrivateCreateNotSent({ claim, result: {
    ...result, attempted: undefined }, observation, readback }), false);
  assert.equal(eligibleForPinnedPrivateCreateNotSent({ claim, result,
    observation: { ...observation, events: [{ method: "POST" }] }, readback }), false);
  assert.equal(eligibleForPinnedPrivateCreateNotSent({ claim, result,
    observation, readback: { ...readback, draftAllPages: { ...empty,
      complete: false } } }), false);
  for (const changed of [undefined, "bogus"]) {
    const wrongClaim = { ...claim, inventoryFingerprint: changed,
      snapshotFingerprint: changed };
    assert.equal(eligibleForPinnedPrivateCreateNotSent({ claim: wrongClaim,
      result: { ...result, inventoryFingerprint: changed,
        snapshotFingerprint: changed }, observation, readback }), false);
  }
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
  assert.equal(saved.reasonCode, "BROWSER_UNAVAILABLE");
  assert.equal(saved.attempted.createClick, false);
  assert.equal(saved.observationCaptureStatus, "MISSING");
  assert.equal(saved.listingConfirmed, false);
});
