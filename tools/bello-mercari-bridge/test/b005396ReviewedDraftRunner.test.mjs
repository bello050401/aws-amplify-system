import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueueGeneralPrivateCreate } from "../src/generalPrivateCreateJob.mjs";
import { reviewB005396PrivateDraft, bindB005396InitialScan,
  runB005396ReviewedDraft } from "../src/b005396ReviewedDraftRunner.mjs";

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
  managementCode: pack.managementCode, title: pack.title,
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
    { ...evidence, draftId: "other" }])
    assert.equal(await reviewB005396PrivateDraft(target, {
      evidence: changed, fetchSnapshot }), false);
  assert.equal(await reviewB005396PrivateDraft(target, { evidence,
    fetchSnapshot: async () => ({ ...(await fetchSnapshot()),
      files: [{ ...(await fetchSnapshot()).files[0], buffer: Buffer.from("changed") }] }) }), false);
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
