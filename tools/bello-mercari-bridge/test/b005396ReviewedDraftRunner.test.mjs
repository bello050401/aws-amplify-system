import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueueGeneralPrivateCreate, readGeneralPrivateCreateClaim } from
  "../src/generalPrivateCreateJob.mjs";
import { readB005396ImageByteProof, reviewB005396PrivateDraft,
  bindB005396InitialScan, createB005396ReviewedLiveDesktopInjection,
  runB005396ReviewedDraft } from "../src/b005396ReviewedDraftRunner.mjs";
import { bindB005396PrivateDraftReadback } from
  "../src/generalPrivateDraftReadback.mjs";
import { runB005396PrivateDraftPcFlow } from
  "../src/generalPrivateDraftPcFlow.mjs";
import { fillGeneralPrivateCreateFormOnly } from
  "../src/generalPrivateCreateFormOnly.mjs";

const inventoryId = "2c53f36a-7a60-4e34-801d-8abc24f6cfc0";
const shopId = "evkhihBFFNn5hukMS9s36H";
const bytes = Buffer.from("reviewed image bytes");
const imageSha256 = createHash("sha256").update(bytes).digest("hex");
const pack = { schemaVersion: 1, kind: "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK",
  shopId, inventoryId, draftId: "12345678-1234-4234-8234-123456789abc",
  draftUpdatedAt: "2026-10-08T00:00:00.000Z", title: "ソファ",
  description: "一部地域は配送をご相談ください。",
  condition: "NO_NOTABLE_DAMAGE", imageRefs: [{ source: "INVENTORY",
    storageKey: "inventory/sofa.jpg", sortOrder: 0, photoAssetId: null }],
  priceYen: 99999, quantity: 1, categoryId: "12345",
  categoryPath: "家具・インテリア > ソファ・ソファベッド > 2人掛け・3人掛けソファ",
  brandId: null, brandName: null,
  managementCode: `BELLO_${inventoryId.replace(/-/g, "").toUpperCase()}`,
  shipping: { method: "METHOD_TYPE_UNDECIDED", payer: "PAYER_TYPE_SELLER",
    origin: "jp11", duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" },
  status: "PREPARED_NO_SEND" };
const evidence = { shopId, inventoryId, draftId: pack.draftId,
  packFingerprint: createHash("sha256").update(JSON.stringify(pack)).digest("hex"),
  managementCode: pack.managementCode, title: pack.title,
  description: pack.description, categoryPath: pack.categoryPath,
  shipping: pack.shipping,
  priceYen: 99999, quantity: 1, imageSha256,
  privateOnly: true, shippingReviewRequired: true };
const fetchSnapshot = async () => ({ files: [{ buffer: bytes, imageSha256,
  sha256: imageSha256, storageKey: pack.imageRefs[0].storageKey }],
  sourcePriceYen: 50000, sourceShippingMethod: "KAZAI" });

test("review gate checks exact target, values, private flag and current image bytes", async () => {
  const target = { inventoryId, pack };
  assert.equal(await reviewB005396PrivateDraft(target, {
    evidence, fetchSnapshot }), true);
  for (const changed of [{ ...evidence, priceYen: 100000 },
    { ...evidence, privateOnly: false },
    { ...evidence, shippingReviewRequired: false },
    { ...evidence, imageSha256: "a".repeat(64) },
    { ...evidence, description: "changed" },
    { ...evidence, categoryPath: "changed" },
    { ...evidence, shipping: { ...pack.shipping, origin: "jp13" } },
    { ...evidence, packFingerprint: "a".repeat(64) },
    { ...evidence, draftId: "other" }])
    assert.equal(await reviewB005396PrivateDraft(target, {
      evidence: changed, fetchSnapshot }), false);
  assert.equal(await reviewB005396PrivateDraft(target, { evidence,
    fetchSnapshot: async () => ({ ...(await fetchSnapshot()),
      files: [{ ...(await fetchSnapshot()).files[0], buffer: Buffer.from("changed") }] }) }), false);
});

test("image-byte proof is source-backed and contains no image bytes or signed URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-image-byte-proof-"));
  try {
    await enqueueGeneralPrivateCreate(root, pack);
    const args = { root, inventoryId, origin: "https://bello.example.invalid",
      belloProfileDir: root, playwrightModulePath: root };
    const result = await readB005396ImageByteProof(args, { fetchSnapshot });
    assert.equal(result.status, "IMAGE_BYTES_READ_ONLY_VERIFIED");
    assert.equal(result.proof.imageSha256, imageSha256);
    assert.equal(result.proof.packFingerprint, evidence.packFingerprint);
    assert.equal(result.proof.description, pack.description);
    assert.equal(JSON.stringify(result).includes("reviewed image bytes"), false);
    assert.equal(JSON.stringify(result).includes("https://"), false);
    const blocked = await readB005396ImageByteProof(args, {
      fetchSnapshot: async () => { throw Error("BELLO_ADMIN_LOGIN_REQUIRED"); } });
    assert.equal(blocked.diagnostic, "BELLO_ADMIN_LOGIN_REQUIRED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("read-only scan binder closes the session and blocks non-query writes", async () => {
  let closed = 0;
  let guard;
  const scan = bindB005396InitialScan({ root: "r", shopsProfileDir: "s",
    playwrightModulePath: "p" }, {
    openSession: async options => { guard = options.requestGuard;
      return { context: { setOffline: async () => {},
        close: async () => { closed++; } }, page: {} }; },
    scan: async () => {
      await guard({ request: () => ({ method: () => "DELETE" }),
        abort: async () => { aborted++; } });
      return { tabs: [] };
    } });
  let aborted = 0;
  await assert.rejects(scan({ shopId, managementCode: pack.managementCode,
    title: pack.title }), /SCAN_NETWORK_GUARD_BLOCKED/);
  assert.equal(closed, 1);
  assert.equal(aborted, 1);
});

test("read-only scan binder admits only the pinned Self account query", async () => {
  const query = `query Self {
  self {
    nickname
    picture
    accountId
    customerId
    mercariId
    externalId
    picture
    roles
    email
    token {
      expiresIn
      audience
    }
  }
}`;
  let continued = 0;
  let aborted = 0;
  let guard;
  const scan = bindB005396InitialScan({ root: "r", shopsProfileDir: "s",
    playwrightModulePath: "p" }, {
    openSession: async options => { guard = options.requestGuard;
      return { context: { setOffline: async () => {}, close: async () => {} },
        page: {} }; },
    scan: async () => {
      const request = body => ({ method: () => "POST",
        url: () => "https://mercari-shops.com/graphql",
        resourceType: () => "fetch",
        postDataBuffer: () => Buffer.from(JSON.stringify(body)) });
      await guard({ request: () => request({ query }),
        continue: async () => { continued++; },
        abort: async () => { aborted++; } });
      return { tabs: [] };
    },
  });
  await scan({ shopId, managementCode: pack.managementCode,
    title: pack.title });
  assert.equal(continued, 1);
  assert.equal(aborted, 0);
});

test("dry runner reads but cannot enter form, image upload or save path", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-reviewed-dry-"));
  try {
    await enqueueGeneralPrivateCreate(root, pack);
    let flowCalls = 0;
    const result = await runB005396ReviewedDraft({ root, inventoryId,
      origin: "https://bello.example.invalid", belloProfileDir: root,
      shopsProfileDir: root, playwrightModulePath: root }, {
      evidence, fetchSnapshot, captureInitialScan: async () => ({}),
      remotePreflight: async () => ({ status: "NO_MATCH_IN_OBSERVED_UI" }),
      flow: async () => { flowCalls++; } });
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.diagnostic, "DRY_READ_ONLY");
    assert.equal(result.reviewMatched, true);
    assert.equal(result.remoteStatus, "NO_MATCH_IN_OBSERVED_UI");
    assert.equal(flowCalls, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("LIVE entry requires explicit enable and current reviewed evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-reviewed-live-gate-"));
  try {
    await enqueueGeneralPrivateCreate(root, pack);
    const args = { root, inventoryId, origin: "https://bello.example.invalid",
      belloProfileDir: root, shopsProfileDir: root,
      playwrightModulePath: root };
    let flowCalls = 0;
    const flow = async (_args, deps) => {
      flowCalls++;
      assert.equal(typeof deps.captureInitialScan, "function");
      assert.equal(await deps.reviewGate({ inventoryId, pack }), true);
      return { status: "BLOCKED", diagnostic: "TEST_FLOW_NO_SAVE" };
    };
    const missingFlag = await runB005396ReviewedDraft(args, {
      mode: "LIVE", evidence, fetchSnapshot, flow });
    assert.equal(missingFlag.diagnostic, "LIVE_REVIEW_HOLD");
    const missingReview = await runB005396ReviewedDraft(args, {
      mode: "LIVE", allowLiveAfterReview: true,
      fetchSnapshot, flow });
    assert.equal(missingReview.diagnostic, "REVIEW_HOLD");
    assert.equal(flowCalls, 0);
    const enabled = await runB005396ReviewedDraft(args, {
      mode: "LIVE", allowLiveAfterReview: true, evidence,
      fetchSnapshot, flow });
    assert.equal(enabled.diagnostic, "TEST_FLOW_NO_SAVE");
    assert.equal(flowCalls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("desktop LIVE injection cannot be constructed without the independent review gate", () => {
  const imageByteProof = { schemaVersion: 1,
    kind: "B005396_IMAGE_BYTES_READ_ONLY", ...evidence,
    sourcePriceYen: 50000, sourceShippingMethod: "KAZAI",
    observedAt: new Date().toISOString() };
  assert.throws(() => createB005396ReviewedLiveDesktopInjection({ imageByteProof }),
    /B005396_LIVE_REVIEW_HOLD/);
  assert.throws(() => createB005396ReviewedLiveDesktopInjection({
    independentReviewPassed: true }), /B005396_LIVE_REVIEW_HOLD/);
  const injection = createB005396ReviewedLiveDesktopInjection({
    independentReviewPassed: true, imageByteProof });
  assert.equal(injection.offlineDraftActionEnabled, true);
  assert.equal(typeof injection.runGeneralDraft, "function");
});

test("fresh draft page proves same ID, private list membership and every form field", async () => {
  const draftId = "draft123";
  const assets = [{ pathHash: "a".repeat(64), width: 960, height: 960 }];
  const detailUrl = `https://mercari-shops.com/seller/shops/${shopId}/products/create?productDraftId=${draftId}`;
  let url = "about:blank";
  let closed = 0;
  const page = { route: async () => {}, routeWebSocket: async () => {},
    waitForTimeout: async () => {},
    goto: async target => { url = target; }, url: () => url,
    close: async () => { closed++; } };
  const snapshot = { href: detailUrl, categoryLeaf: "2人掛け・3人掛けソファ",
    categoryGroup: "カテゴリー家具・インテリア>ソファ・ソファベッド>2人掛け・3人掛けソファ",
    condition: "目立った傷や汚れなし", assets,
    fields: { name: pack.title, description: pack.description,
      price: "99999", "variants.0.quantity": "1",
      "variants.0.skuCode": pack.managementCode,
      "shippingMethodType.id": pack.shipping.method,
      "shippingPayerType.id": pack.shipping.payer,
      "shippingFromState.id": pack.shipping.origin,
      "shippingDurationType.id": pack.shipping.duration } };
  const bind = (readForm = async () => snapshot) =>
    bindB005396PrivateDraftReadback({ newPage: async () => page }, pack, {
      readCount: async () => ({ status: "DRAFT_COUNT_OBSERVED",
        count: 1, allowFinalCreate: false }),
      collectDrafts: async () => ({ status: "DRAFT_DETAILS_DOM_OBSERVED",
        allowFinalCreate: false, rows: [{ draftId, title: pack.title,
          skuCode: pack.managementCode }] }), readForm });
  const target = { shopId, draftId, managementCode: pack.managementCode,
    selectedAssets: assets };
  const proof = await bind()(target);
  assert.equal(proof.status, "PRIVATE_DRAFT_READBACK_CONFIRMED");
  assert.equal(proof.visibility, "DRAFT_PRIVATE");
  assert.equal(proof.public, false);
  assert.equal(closed, 1);
  assert.equal(await bind(async () => ({ ...snapshot, fields: {
    ...snapshot.fields, description: "changed" } }))(target), null);
  assert.equal(closed, 2);
});

test("a non-read request during separate draft readback blocks confirmation", async () => {
  let guard;
  let aborted = 0;
  const page = { route: async (_pattern, callback) => { guard = callback; },
    routeWebSocket: async () => {}, close: async () => {} };
  const readDraft = bindB005396PrivateDraftReadback({
    newPage: async () => page }, pack, {
    readCount: async () => {
      await guard({ request: () => ({ method: () => "DELETE" }),
        abort: async () => { aborted++; } });
      return { status: "DRAFT_COUNT_OBSERVED", count: 1,
        allowFinalCreate: false };
    } });
  assert.equal(await readDraft({ shopId, draftId: "draft123",
    managementCode: pack.managementCode,
    selectedAssets: [{ pathHash: "a".repeat(64), width: 960,
      height: 960 }] }), null);
  assert.equal(aborted, 1);
});

test("LIVE wrapper reconciles a clicked UNKNOWN only through separate readback", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-live-readback-"));
  try {
    await enqueueGeneralPrivateCreate(root, pack);
    let readbackCalls = 0;
    const result = await runB005396ReviewedDraft({ root, inventoryId,
      origin: "https://bello.example.invalid", belloProfileDir: root,
      shopsProfileDir: root, playwrightModulePath: root }, {
      mode: "LIVE", allowLiveAfterReview: true, evidence, fetchSnapshot,
      captureInitialScan: async () => ({}),
      flow: async () => ({ status: "UNKNOWN", clicked: true,
        observedDraftId: "draft123",
        retainedSession: { context: {} } }),
      bindReadback: () => { readbackCalls++; return async () => ({}); },
      reconcile: async ({ readDraft }) => {
        assert.equal(typeof readDraft, "function");
        return { status: "PRIVATE_DRAFT_READBACK_CONFIRMED",
          diagnostic: "PRIVATE_DRAFT_READBACK_CONFIRMED" };
      } });
    assert.equal(result.status, "PRIVATE_DRAFT_READBACK_CONFIRMED");
    assert.equal(result.allowPublic, false);
    assert.equal(readbackCalls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reviewed A image changing to B before form gives zero upload and zero claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-sha-boundary-"));
  try {
    await enqueueGeneralPrivateCreate(root, pack);
    let claims = 0;
    let uploads = 0;
    const changed = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3, 0xff, 0xd9]);
    const changedSha = createHash("sha256").update(changed).digest("hex");
    const result = await runB005396ReviewedDraft({ root, inventoryId,
      origin: "https://bello.example.invalid", belloProfileDir: root,
      shopsProfileDir: root, playwrightModulePath: root }, {
      mode: "LIVE", allowLiveAfterReview: true, evidence, fetchSnapshot,
      captureInitialScan: async () => ({}),
      flow: (args, deps) => runB005396PrivateDraftPcFlow(args, {
        ...deps, fillForm: input => fillGeneralPrivateCreateFormOnly(input, {
          remotePreflight: async () => ({ status: "NO_MATCH_IN_OBSERVED_UI",
            allowFinalCreate: false }),
          fetchImages: async () => [{ storageKey: pack.imageRefs[0].storageKey,
            index: 0, buffer: changed, sha256: changedSha,
            filename: "changed.jpg", mimeType: "image/jpeg" }],
          claimOnce: async () => { claims++; },
          fillForm: async () => { uploads++; },
        }),
      }),
    });
    assert.equal(result.status, "UNKNOWN");
    assert.equal(claims, 0);
    assert.equal(uploads, 0);
    assert.equal(await readGeneralPrivateCreateClaim(root, inventoryId), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
