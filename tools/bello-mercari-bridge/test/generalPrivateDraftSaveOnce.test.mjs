import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { enqueueGeneralPrivateCreate, claimGeneralPrivateCreateOnce,
  writeGeneralPrivateCreateResultOnce } from
  "../src/generalPrivateCreateJob.mjs";
import { inspectB005396DraftSaveInput,
  inspectB005396DraftDuplicateProof, exactFormStillOpen,
  saveB005396PrivateDraftOnce,
  reconcileB005396PrivateDraftSaveUnknown } from
  "../src/generalPrivateDraftSaveOnce.mjs";
import { fetchCurrentGeneralPrivateCreateSnapshot } from
  "../src/generalPrivateCreateImages.mjs";

const inventoryId = "2c53f36a-7a60-4e34-801d-8abc24f6cfc0";
const shopId = "evkhihBFFNn5hukMS9s36H";
const draftId = "sourceDraft123";
const remoteDraftId = "shopsDraft123";
const sha256 = "a".repeat(64);
const imagePath = "/asset/sofa.jpg";
const asset = { pathHash: createHash("sha256").update(imagePath).digest("hex"),
  width: 960, height: 960 };
const pack = (description = "らくらく家財便Eまたは自社配送で発送します。") => ({
  schemaVersion: 1, kind: "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK",
  shopId, inventoryId,
  draftId: "12345678-1234-4234-8234-123456789abc",
  draftUpdatedAt: "2026-10-08T00:00:00.000Z",
  title: "ソファ", description, condition: "NO_NOTABLE_DAMAGE",
  imageRefs: [{ source: "INVENTORY", storageKey: "inventory/sofa.jpg",
    sortOrder: 0, photoAssetId: null }],
  priceYen: 99999, quantity: 1, categoryId: "12345",
  categoryPath: "家具・インテリア > ソファ・ソファベッド > 2人掛け・3人掛けソファ",
  brandId: null, brandName: null,
  managementCode: `BELLO_${inventoryId.replace(/-/g, "").toUpperCase()}`,
  shipping: { method: "METHOD_TYPE_UNDECIDED", payer: "PAYER_TYPE_SELLER",
    origin: "jp11", duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" },
  status: "PREPARED_NO_SEND",
});

async function withClaimedForm(action, description) {
  const root = await mkdtemp(join(tmpdir(), "bello-draft-save-"));
  try {
    await enqueueGeneralPrivateCreate(root, pack(description));
    const claim = await claimGeneralPrivateCreateOnce(root, inventoryId);
    await writeGeneralPrivateCreateResultOnce(root, inventoryId, {
      attemptId: claim.attemptId, outcome: "UNKNOWN",
      listingConfirmed: false, observedRemoteId: null,
      observedDraftId: remoteDraftId, reasonCode: "FORM_READY_NO_SAVE",
    });
    let clicks = 0;
    const url = `https://mercari-shops.com/seller/shops/${shopId}/products/create?productDraftId=${remoteDraftId}`;
    const current = pack(description);
    const fields = { name: current.title, description: current.description,
      price: "¥99,999", "variants.0.quantity": "1",
      "variants.0.skuCode": current.managementCode,
      "shippingMethodType.id": "METHOD_TYPE_UNDECIDED",
      "shippingPayerType.id": "PAYER_TYPE_SELLER",
      "shippingFromState.id": "jp11",
      "shippingDurationType.id": "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" };
    class FakeImage {
      complete = true;
      naturalWidth = 960;
      naturalHeight = 960;
      currentSrc = `https://cdn.example.invalid${imagePath}`;
    }
    const document = { location: { href: url },
      querySelector(selector) {
        const name = /^\[name="([^"]+)"\]$/.exec(selector)?.[1];
        if (name) return { value: fields[name] ?? null };
        if (selector === '[data-testid="condition-select-box"]')
          return { textContent: "目立った傷や汚れなし" };
        if (selector === '[data-testid="categories"]')
          return { textContent: "2人掛け・3人掛けソファ" };
        if (selector === 'label[for="category"]')
          return { closest: () => ({ textContent:
            `カテゴリー${current.categoryPath.replaceAll(" > ", ">")}` }) };
        return null;
      },
      querySelectorAll(selector) {
        return selector === 'img[alt="uploaded-image"]' ? [new FakeImage()] : [];
      } };
    let onHandleEnabled = null;
    const page = { url: () => url,
      evaluate: async () => ({ href: url, timeOrigin: 123456789 }),
      locator(selector) {
        assert.equal(selector, "body");
        return { evaluate: async fn => runInNewContext(`(${fn.toString()})()`,
          { document, performance: { timeOrigin: 123456789 },
            HTMLImageElement: FakeImage, URL }) };
      },
      getByRole(role, options) {
        assert.equal(role, "button");
        assert.deepEqual(options, { name: "下書きへ保存する", exact: true });
        const handle = { isEnabled: async () => {
          onHandleEnabled?.(); return true;
        },
          click: async () => { clicks++; } };
        return { count: async () => 1, isEnabled: async () => true,
          elementHandle: async () => handle };
      } };
    const form = { status: "FORM_READY_NO_SAVE", allowSave: false,
      listingConfirmed: false, attemptId: claim.attemptId,
      observedDraftId: remoteDraftId, documentTimeOrigin: 123456789,
      selectedImageSha256s: [sha256], selectedAssets: [asset],
      retainedSession: { page, context: {} } };
    return await action({ root, form, page, fields, clicks: () => clicks,
      onHandleEnabled: callback => { onHandleEnabled = callback; } });
  } finally { await rm(root, { recursive: true, force: true }); }
}

const proof = () => ({ status: "NO_OTHER_MATCH_OBSERVED", complete: true,
  allowFinalCreate: false, shopId, managementCode: pack().managementCode,
  ownDraftId: remoteDraftId, observedAt: new Date().toISOString() });
const image = () => [{ storageKey: "inventory/sofa.jpg", sha256 }];
const snapshot = () => ({ files: image(), sourcePriceYen: 50000,
  sourceShippingMethod: "KAZAI" });

test("BELLO readback binds downloaded image bytes to source price and method", async () => {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.alloc(20, 1), Buffer.from([0xff, 0xd9])]);
  let closed = false;
  const payload = { ok: true, inventoryId,
    draftId: pack().draftId, sourcePriceYen: 50000,
    sourceShippingMethod: "KAZAI",
    images: [{ index: 0, storageKey: "inventory/sofa.jpg",
      url: "https://image.example.invalid/one.jpg" }] };
  const context = { request: {
    post: async () => ({ ok: () => true, json: async () => payload }),
    get: async () => ({ ok: () => true, body: async () => bytes }),
  }, close: async () => { closed = true; } };
  const args = { origin: "https://bello.example.invalid",
    belloProfileDir: "C:/bello-profile", playwrightModulePath: "C:/playwright.js",
    pack: pack() };
  const read = await fetchCurrentGeneralPrivateCreateSnapshot(args,
    { openContext: async () => context });
  assert.equal(read.sourcePriceYen, 50000);
  assert.equal(read.sourceShippingMethod, "KAZAI");
  assert.equal(read.files[0].buffer.equals(bytes), true);
  assert.equal(closed, true);
  payload.sourceShippingMethod = "UNKNOWN";
  await assert.rejects(fetchCurrentGeneralPrivateCreateSnapshot(args,
    { openContext: async () => context }), /GENERAL_SOURCE_PROOF_UNVERIFIED/);
});

test("B005396 fixed draft values retain shipping review for before public", async () => {
  await withClaimedForm(async ({ form }) => {
    assert.equal(inspectB005396DraftSaveInput(pack(), form), null);
    assert.equal(inspectB005396DraftSaveInput(pack(
      "一部地域は追加送料が発生します。"), form),
    null);
    assert.equal(inspectB005396DraftSaveInput({ ...pack(), quantity: 2 }, form),
      "FORM_OR_PACK_UNVERIFIED");
  });
});

test("duplicate proof must be recent, exact-shop and own-draft bound", () => {
  const form = { observedDraftId: remoteDraftId };
  assert.equal(inspectB005396DraftDuplicateProof(pack(), form, proof()), true);
  assert.equal(inspectB005396DraftDuplicateProof(pack(), form,
    { ...proof(), ownDraftId: "otherDraft" }), false);
  assert.equal(inspectB005396DraftDuplicateProof(pack(), form,
    { ...proof(), observedAt: "2026-01-01T00:00:00.000Z" }), false);
  assert.equal(inspectB005396DraftDuplicateProof(pack(), form,
    { ...proof(), status: "REMOTE_DUPLICATE_POSSIBLE" }), false);
});

test("exact form readback checks every saved field, leaf, document and image", async () => {
  await withClaimedForm(async ({ form, page }) => {
    const current = pack();
    const fields = { name: current.title, description: current.description,
      price: "¥99,999", "variants.0.quantity": "1",
      "variants.0.skuCode": current.managementCode,
      "shippingMethodType.id": "METHOD_TYPE_UNDECIDED",
      "shippingPayerType.id": "PAYER_TYPE_SELLER",
      "shippingFromState.id": "jp11",
      "shippingDurationType.id": "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" };
    const view = { href: page.url(), timeOrigin: 123456789,
      fields, assets: [asset], condition: "目立った傷や汚れなし",
      categoryLeaf: "2人掛け・3人掛けソファ",
      categoryGroup: `カテゴリー${current.categoryPath.replaceAll(" > ", ">")}` };
    const options = { readSnapshot: async () => view };
    assert.equal(await exactFormStillOpen(current, form, page, options), true);
    assert.equal(await exactFormStillOpen(current, form, page,
      { readSnapshot: async () => ({ ...view,
        fields: { ...fields, price: "¥100,000" } }) }), false);
    assert.equal(await exactFormStillOpen(current, form, page,
      { readSnapshot: async () => ({ ...view, assets: [{ ...asset,
        pathHash: "c".repeat(64) }] }) }), false);
  });
});

test("default atomic DOM readback stops when price changes before draft click", async () => {
  await withClaimedForm(async ({ root, form, fields, clicks,
    onHandleEnabled }) => {
    onHandleEnabled(() => { fields.price = "¥100,000"; });
    const result = await saveB005396PrivateDraftOnce({ root, inventoryId,
      form }, { fetchSnapshot: async () => snapshot(),
      captureDuplicateProof: async () => proof() });
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.diagnostic, "DRAFT_BUTTON_UNVERIFIED");
    assert.equal(clicks(), 0);
  });
});

test("no duplicate reader or changed BELLO image stops before a save claim", async () => {
  await withClaimedForm(async ({ root, form, clicks }) => {
    const noReader = await saveB005396PrivateDraftOnce({ root, inventoryId,
      form }, { fetchSnapshot: async () => snapshot() });
    assert.equal(noReader.diagnostic, "REMOTE_DUPLICATE_UNVERIFIED");
    const changed = await saveB005396PrivateDraftOnce({ root, inventoryId,
      form }, { fetchSnapshot: async () => ({ ...snapshot(),
        files: [{ ...image()[0], sha256: "c".repeat(64) }] }),
      captureDuplicateProof: async () => proof() });
    assert.equal(changed.diagnostic, "SOURCE_CHANGED");
    const shippingChanged = await saveB005396PrivateDraftOnce({ root, inventoryId,
      form }, { fetchSnapshot: async () => ({ ...snapshot(),
        sourceShippingMethod: "SAGAWA" }),
      captureDuplicateProof: async () => proof() });
    assert.equal(shippingChanged.diagnostic, "SOURCE_CHANGED");
    assert.equal(clicks(), 0);
  });
});

test("a single draft button click is claimed and passes the shared 30-second gate", async () => {
  await withClaimedForm(async ({ root, form, clicks }) => {
    const result = await saveB005396PrivateDraftOnce({ root, inventoryId,
      form }, { fetchSnapshot: async () => snapshot(),
      captureDuplicateProof: async () => proof(),
      verifyForm: async () => true });
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.diagnostic, "DRAFT_SAVE_READBACK_UNVERIFIED");
    assert.equal(result.allowPublic, false);
    assert.equal(result.shippingReviewRequired, true);
    assert.equal(clicks(), 1);
    const markerDir = join(root, "listing-send-attempts");
    const claim = JSON.parse(await readFile(join(root,
      "general-private-draft-save-once", `${inventoryId}.claim.json`), "utf8"));
    const marker = JSON.parse(await readFile(join(markerDir,
      `${shopId}-${claim.attemptId}.json`), "utf8"));
    assert.equal(marker.minimumGapSeconds, 30);
    assert.equal(marker.operation, "CREATE");
    assert.equal(claim.shippingReviewRequired, true);
    const again = await saveB005396PrivateDraftOnce({ root, inventoryId,
      form }, { fetchSnapshot: async () => snapshot(),
      captureDuplicateProof: async () => proof(),
      verifyForm: async () => true });
    assert.equal(again.diagnostic, "DRAFT_SAVE_ALREADY_CLAIMED");
    assert.equal(clicks(), 1);
    const unresolved = await reconcileB005396PrivateDraftSaveUnknown({
      root, inventoryId });
    assert.equal(unresolved.status, "UNKNOWN");
    const wrong = await reconcileB005396PrivateDraftSaveUnknown({
      root, inventoryId, readDraft: async () => ({
        status: "PRIVATE_DRAFT_READBACK_CONFIRMED", shopId,
        draftId: "otherDraft", managementCode: pack().managementCode,
      }) });
    assert.equal(wrong.status, "UNKNOWN");
    const confirmed = await reconcileB005396PrivateDraftSaveUnknown({
      root, inventoryId, readDraft: async () => ({
        status: "PRIVATE_DRAFT_READBACK_CONFIRMED",
        visibility: "DRAFT_PRIVATE", public: false,
        observedAt: new Date().toISOString(), shopId,
        draftId: remoteDraftId, managementCode: pack().managementCode,
        title: pack().title, description: pack().description,
        priceYen: 99999, quantity: 1,
        condition: "NO_NOTABLE_DAMAGE", categoryPath: pack().categoryPath,
        shipping: pack().shipping, assets: [asset],
      }) });
    assert.equal(confirmed.status, "PRIVATE_DRAFT_READBACK_CONFIRMED");
    assert.equal(clicks(), 1);
  });
});

test("duplicate uncertainty after claim records UNKNOWN without clicking", async () => {
  await withClaimedForm(async ({ root, form, clicks }) => {
    const result = await saveB005396PrivateDraftOnce({ root, inventoryId,
      form }, { fetchSnapshot: async () => snapshot(),
      captureDuplicateProof: async () => ({ ...proof(),
        status: "REMOTE_DUPLICATE_POSSIBLE" }),
      verifyForm: async () => true });
    assert.equal(result.diagnostic, "REMOTE_DUPLICATE_UNVERIFIED");
    assert.equal(clicks(), 0);
    const again = await saveB005396PrivateDraftOnce({ root, inventoryId,
      form }, { fetchSnapshot: async () => snapshot(),
      captureDuplicateProof: async () => proof(),
      verifyForm: async () => true });
    assert.equal(again.diagnostic, "DRAFT_SAVE_ALREADY_CLAIMED");
  });
});

test("BELLO image changing during the gate leaves the claimed save UNKNOWN", async () => {
  await withClaimedForm(async ({ root, form, clicks }) => {
    let reads = 0;
    const result = await saveB005396PrivateDraftOnce({ root, inventoryId,
      form }, { fetchSnapshot: async () => {
        reads++;
        return reads === 1 ? snapshot() : { ...snapshot(),
          files: [{ ...image()[0], sha256: "c".repeat(64) }] };
      }, captureDuplicateProof: async () => proof(),
      verifyForm: async () => true });
    assert.equal(result.diagnostic, "SOURCE_CHANGED");
    assert.equal(result.status, "UNKNOWN");
    assert.equal(clicks(), 0);
    assert.equal(reads, 2);
  });
});

test("changed form after the gate never clicks the draft button", async () => {
  await withClaimedForm(async ({ root, form, clicks }) => {
    const result = await saveB005396PrivateDraftOnce({ root, inventoryId,
      form }, { fetchSnapshot: async () => snapshot(),
      captureDuplicateProof: async () => proof(),
      verifyForm: async () => false });
    assert.equal(result.diagnostic, "FORM_CHANGED");
    assert.equal(clicks(), 0);
  });
});
