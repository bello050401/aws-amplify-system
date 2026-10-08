import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueueGeneralPrivateCreate } from
  "../src/generalPrivateCreateJob.mjs";
import { runB005396PrivateDraftPcFlow } from
  "../src/generalPrivateDraftPcFlow.mjs";

const inventoryId = "2c53f36a-7a60-4e34-801d-8abc24f6cfc0";
const shopId = "evkhihBFFNn5hukMS9s36H";
const pack = () => ({ schemaVersion: 1,
  kind: "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK", shopId, inventoryId,
  draftId: "12345678-1234-4234-8234-123456789abc",
  draftUpdatedAt: "2026-10-08T00:00:00.000Z",
  title: "ソファ", description: "一部地域は配送をご相談ください。",
  condition: "NO_NOTABLE_DAMAGE",
  imageRefs: [{ source: "INVENTORY", storageKey: "inventory/sofa.jpg",
    sortOrder: 0, photoAssetId: null }],
  priceYen: 99999, quantity: 1, categoryId: "12345",
  categoryPath: "家具・インテリア > ソファ・ソファベッド > 2人掛け・3人掛けソファ",
  brandId: null, brandName: null,
  managementCode: `BELLO_${inventoryId.replace(/-/g, "").toUpperCase()}`,
  shipping: { method: "METHOD_TYPE_UNDECIDED", payer: "PAYER_TYPE_SELLER",
    origin: "jp11", duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" },
  status: "PREPARED_NO_SEND" });
async function withJob(action, selected = pack()) {
  const root = await mkdtemp(join(tmpdir(), "bello-pc-draft-flow-"));
  try {
    await enqueueGeneralPrivateCreate(root, selected);
    return await action({ root, inventoryId, origin: "https://bello.example.invalid",
      belloProfileDir: join(root, "BELLOChrome"),
      shopsProfileDir: join(root, "ShopsChrome"),
      playwrightModulePath: join(root, "playwright", "package.json") });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("default PC review gate never opens Shops or saves a private draft", async () => {
  await withJob(async args => {
    let calls = 0;
    const result = await runB005396PrivateDraftPcFlow(args, {
      captureInitialScan: async () => { calls++; },
      fillForm: async () => { calls++; },
      saveDraft: async () => { calls++; } });
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.diagnostic, "REVIEW_HOLD");
    assert.equal(result.allowPublic, false);
    assert.equal(calls, 0);
  });
});

test("offline assembly passes reviewed pack through form and exact duplicate callback", async () => {
  await withJob(async args => {
    const calls = [];
    const context = {};
    const captureInitialScan = async () => ({});
    const result = await runB005396PrivateDraftPcFlow(args, {
      reviewGate: async ({ pack: reviewed }) => {
        assert.equal(reviewed.priceYen, 99999);
        assert.equal(reviewed.quantity, 1);
        assert.equal(reviewed.shipping.origin, "jp11");
        return true;
      }, captureInitialScan,
      fillForm: async input => { calls.push("form");
        assert.equal(input.captureReadOnlyScan, captureInitialScan);
        assert.equal(input.shopsProfileDir, args.shopsProfileDir);
        return { status: "FORM_READY_NO_SAVE", allowSave: false,
          listingConfirmed: false, retainedSession: { context } }; },
      bindDuplicateReader: bound => { calls.push("bind");
        assert.equal(bound, context);
        return async target => ({ ...target, complete: true }); },
      saveDraft: async (input, deps) => { calls.push("save");
        assert.equal(input.inventoryId, inventoryId);
        assert.equal(typeof deps.captureDuplicateProof, "function");
        return { status: "UNKNOWN", diagnostic: "DRAFT_SAVE_READBACK_UNVERIFIED",
          listingConfirmed: false, allowPublic: false }; },
    });
    assert.deepEqual(calls, ["form", "bind", "save"]);
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.allowPublic, false);
  });
});

test("authentication expiry or unknown form stops before duplicate and save", async () => {
  await withJob(async args => {
    let later = 0;
    const result = await runB005396PrivateDraftPcFlow(args, {
      reviewGate: async () => true,
      captureInitialScan: async () => ({}),
      fillForm: async () => ({ status: "UNKNOWN", diagnostic: "AUTH_REQUIRED",
        retainedSession: { context: {} } }),
      bindDuplicateReader: () => { later++; return async () => ({}); },
      saveDraft: async () => { later++; },
    });
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.retryAllowed, false);
    assert.equal(later, 0);
  });
});

test("changed fixed price or quantity cannot open the PC browser", async () => {
  for (const change of [{ priceYen: 100000 }, { quantity: 2 }]) {
    await withJob(async args => {
      const result = await runB005396PrivateDraftPcFlow(args, {
        reviewGate: () => { throw Error("should not run"); } });
      assert.equal(result.diagnostic, "REVIEWED_VALUES_CHANGED");
    }, { ...pack(), ...change });
  }
});
