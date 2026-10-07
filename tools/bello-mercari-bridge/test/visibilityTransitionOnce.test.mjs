import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { exactVisibilityMutationAcknowledgement, exactVisibilityPcJob,
  exactVisibilityTarget,
  runVisibilityTransitionOnce } from "../src/visibilityTransitionOnce.mjs";

const shopId = "evkhihBFFNn5hukMS9s36H";
const target = { shopId, inventoryId: "bd4850de-9156-4890-a821-cae75da5c8f7",
  remoteId: "ownedProduct123", title: "Exact owned product", skuCode: "B009999",
  priceYen: 45000, quantity: 1, visibilityPolicy: "PUBLIC_ALLOWED" };
const listing = { status: "ACTIVE", externalListingId: target.remoteId };
const editUrl = `https://mercari-shops.com/seller/shops/${shopId}/products/${target.remoteId}/edit`;
const event = action => ({ order: 1, method: "POST", host: "mercari-shops.com",
  path: "/graphql", bodyType: "json", fields: [],
  auth: { authorization: true, cookie: true, csrf: false }, httpStatus: 200,
  graphqlOperationType: "mutation", responseField: "updateProduct",
  responseKind: "UPDATE_PRODUCT", requestProductMatch: "MATCH",
  requestPrivateState: action === "STOP" ? "MATCH" : "DIFFERENT",
  requestPublicState: action === "RELIST" ? "MATCH" : "DIFFERENT",
  productMatch: "MATCH", shopMatch: "MATCH", graphqlErrors: "NONE",
  state: action === "STOP" ? "UNOPENED" : "OPENED" });

const args = (root, action) => ({ root, profileDir: resolve("profile"),
  playwrightModulePath: resolve("playwright"), action, target,
  listing: action === "STOP" ? listing : null });

function fakeBrowser(action, { wrongAfter = false } = {}) {
  let closed = false;
  let nextClicks = 0;
  let saveClicks = 0;
  const page = { url: () => editUrl, getByRole: () => ({ count: async () => 1,
    isEnabled: async () => true, click: async () => { nextClicks++; } }) };
  const context = { newPage: async () => ({ close: async () => {} }),
    close: async () => { closed = true; } };
  const deps = {
    openSession: async () => ({ context, page }),
    readVisibility: async (current, request) => ({ kind: "OBSERVED", shopId,
      remoteId: target.remoteId, title: target.title,
      visibility: current === page ? request.visibility :
        wrongAfter ? (action === "STOP" ? "PUBLIC" : "PRIVATE") : request.visibility }),
    readFields: async () => ({ title: target.title }),
    observe: () => ({ checkpoint: () => 0,
      waitForPostClickIdle: async () => true,
      stop: async () => [event(action)] }),
    chooseSaveButton: async () => ({ click: async () => { saveClicks++; } }),
  };
  return { deps, state: () => ({ closed, nextClicks, saveClicks }) };
}

test("only exact same-product update response can acknowledge each UI action", () => {
  assert.equal(exactVisibilityMutationAcknowledgement([event("STOP")], "STOP"), true);
  assert.equal(exactVisibilityMutationAcknowledgement([event("RELIST")], "RELIST"), true);
  assert.equal(exactVisibilityMutationAcknowledgement([event("STOP")], "RELIST"), false);
  assert.equal(exactVisibilityMutationAcknowledgement([event("STOP"),
    { ...event("STOP"), order: 2 }], "STOP"), false);
  assert.equal(exactVisibilityMutationAcknowledgement([{
    ...event("STOP"), productMatch: "DIFFERENT" }], "STOP"), false);
  assert.equal(exactVisibilityMutationAcknowledgement([{
    ...event("STOP"), graphqlErrors: "PRESENT" }], "STOP"), false);
  const saturatedWindow = [event("STOP"), ...Array.from({ length: 19 }, (_, index) => ({
    ...event("STOP"), order: index + 2, graphqlOperationType: "query",
    responseField: "product", responseKind: "PRODUCT" }))];
  assert.equal(exactVisibilityMutationAcknowledgement(saturatedWindow, "STOP"), false,
    "the observer may have dropped a later conflicting mutation at its cap");
});

test("private-only inventory variants and array identifiers cannot enter a claim", () => {
  for (const inventoryId of ["dd273c1e-9b2a-4013-acc6-c445a481fab8",
    "DD273C1E-9B2A-4013-ACC6-C445A481FAB8",
    ["dd273c1e-9b2a-4013-acc6-c445a481fab8"],
    "5b0f3587-cbbb-4c09-ae78-595b2b3e353f",
    "5B0F3587-CBBB-4C09-AE78-595B2B3E353F",
    ["5b0f3587-cbbb-4c09-ae78-595b2b3e353f"]])
    assert.equal(exactVisibilityTarget({ ...target, inventoryId }), false);
  for (const remoteId of ["2JWp7EJx6aqKfn6dTXc5Q9", "2JToDtSgGowzUwnwe9hgHU"])
    assert.equal(exactVisibilityTarget({ ...target, remoteId }), false);
  for (const skuCode of ["B005659", "B005413",
    "TEST_B005413_B63EF3F86211FFE0F890D81E"])
    assert.equal(exactVisibilityTarget({ ...target, skuCode }), false);
  assert.equal(exactVisibilityTarget({ ...target, visibilityPolicy: "PRIVATE_ONLY" }), false);
});

test("a BELLO PC handoff is fingerprinted and cannot swap target or action", () => {
  const body = { schemaVersion: 1, action: "STOP", target, listing };
  const fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  assert.equal(exactVisibilityPcJob({ ...body, fingerprint }), true);
  assert.equal(exactVisibilityPcJob({ ...body, target: { ...target, priceYen: 99999 },
    fingerprint }), false);
  assert.equal(exactVisibilityPcJob({ ...body, action: "RELIST", fingerprint }), false);
  const relist = { ...body, action: "RELIST" };
  assert.equal(exactVisibilityPcJob({ ...relist,
    fingerprint: createHash("sha256").update(JSON.stringify(relist)).digest("hex") }), true);
  assert.equal(exactVisibilityPcJob({ ...body, target: { ...target,
    inventoryId: target.inventoryId.toUpperCase() }, fingerprint }), false);
});

test("one verified stop permits one later relist of the same ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-visibility-once-"));
  try {
    const stop = fakeBrowser("STOP");
    const first = await runVisibilityTransitionOnce(args(root, "STOP"), stop.deps);
    assert.deepEqual({ status: first.status, remoteId: first.remoteId },
      { status: "STOP_VERIFIED", remoteId: target.remoteId });
    assert.deepEqual(stop.state(), { closed: true, nextClicks: 1, saveClicks: 1 });
    const relist = fakeBrowser("RELIST");
    const second = await runVisibilityTransitionOnce(args(root, "RELIST"), relist.deps);
    assert.equal(second.status, "RELIST_VERIFIED");
    assert.deepEqual(relist.state(), { closed: true, nextClicks: 1, saveClicks: 1 });
    const relistClaim = JSON.parse(await readFile(join(root, "visibility-transition-once",
      `${shopId}-${target.remoteId}-RELIST.claim.json`), "utf8"));
    const marker = JSON.parse(await readFile(join(root, "listing-send-attempts",
      `${shopId}-${relistClaim.attemptId}.json`), "utf8"));
    assert.equal(marker.operation, "RELIST");
    assert.equal(marker.minimumGapSeconds, 30);
    assert.equal((await runVisibilityTransitionOnce(args(root, "RELIST"), relist.deps)).status,
      "ALREADY_ATTEMPTED");
    assert.equal(relist.state().saveClicks, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unknown after readback preserves the ID and permanently blocks another click", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-visibility-unknown-"));
  try {
    const browser = fakeBrowser("STOP", { wrongAfter: true });
    const first = await runVisibilityTransitionOnce(args(root, "STOP"), browser.deps);
    assert.equal(first.status, "UNKNOWN");
    assert.equal(first.remoteId, target.remoteId);
    assert.equal(first.retainedSession !== null, true);
    assert.deepEqual(browser.state(), { closed: false, nextClicks: 1, saveClicks: 1 });
    const saved = JSON.parse(await readFile(join(root, "visibility-transition-once",
      `${shopId}-${target.remoteId}-STOP.result.json`), "utf8"));
    assert.equal(saved.outcome, "UNKNOWN");
    assert.equal(saved.remoteId, target.remoteId);
    assert.equal((await runVisibilityTransitionOnce(args(root, "STOP"), browser.deps)).status,
      "ALREADY_ATTEMPTED");
    assert.equal(browser.state().saveClicks, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a saturated response window records UNKNOWN even with matching readback", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-visibility-saturated-"));
  try {
    const browser = fakeBrowser("STOP");
    browser.deps.observe = () => ({ checkpoint: () => 0,
      waitForPostClickIdle: async () => true,
      stop: async () => [event("STOP"), ...Array.from({ length: 19 }, (_, index) => ({
        ...event("STOP"), order: index + 2,
        graphqlOperationType: "query", responseKind: "PRODUCT" }))] });
    const result = await runVisibilityTransitionOnce(args(root, "STOP"), browser.deps);
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.retainedSession !== null, true);
    const saved = JSON.parse(await readFile(join(root, "visibility-transition-once",
      `${shopId}-${target.remoteId}-STOP.result.json`), "utf8"));
    assert.equal(saved.outcome, "UNKNOWN");
    assert.equal(browser.state().saveClicks, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
