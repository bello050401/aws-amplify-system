import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueueGeneralPrivateCreate, claimGeneralPrivateCreateOnce,
  listGeneralPrivateCreateJobs } from
  "../src/generalPrivateCreateJob.mjs";
import { fillGeneralPrivateCreateFormOnce } from
  "../src/generalPrivateCreateForm.mjs";
import { fillGeneralPrivateCreateFormOnly,
  inspectGeneralPrivateCreateUrl } from
  "../src/generalPrivateCreateFormOnly.mjs";
import { openGeneralPrivateCreateFormSession } from "../src/session.mjs";

const inventoryId = "98765432-1234-4234-8234-987654321abc";
const shopId = "evkhihBFFNn5hukMS9s36H";
const pack = () => ({ schemaVersion: 1,
  kind: "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK",
  shopId, inventoryId, draftId: "12345678-1234-4234-8234-123456789abc",
  draftUpdatedAt: "2026-10-07T10:00:00.000Z", title: "Sofa",
  description: "Known saved description", condition: "NO_NOTABLE_DAMAGE",
  imageRefs: [{ source: "INVENTORY", storageKey: "inventory/sofa.jpg",
    sortOrder: 0, photoAssetId: null }], priceYen: 99999, quantity: 1,
  categoryId: "12345", categoryPath:
    "家具・インテリア > ソファ・ソファベッド > 2人掛けソファ",
  brandId: null, brandName: null,
  managementCode: `BELLO_${inventoryId.replace(/-/g, "").toUpperCase()}`,
  shipping: { method: "METHOD_TYPE_UNDECIDED", payer: "PAYER_TYPE_SELLER",
    origin: "jp11", duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" },
  status: "PREPARED_NO_SEND" });
const knownInventoryId = "2c53f36a-7a60-4e34-801d-8abc24f6cfc0";
const knownTitle = "HUKLA KASTOR 2Pソファ / モダン 北欧 デザイナーズ ソファ 2人掛け フクラ カストール 片アームソファ";
const knownPack = () => ({ ...pack(), inventoryId: knownInventoryId,
  managementCode: `BELLO_${knownInventoryId.replace(/-/g, "").toUpperCase()}`,
  title: knownTitle, categoryPath:
    "家具・インテリア > ソファ・ソファベッド > 2人掛け・3人掛けソファ" });
const knownEvidence = current => ({ schemaVersion: 1,
  kind: "B005396_KNOWN_EXISTING_PRIVATE_TEST_EXCEPTION",
  approvalBasis: "USER_APPROVED_ONE_NEW_PRIVATE_TEST_B005396_PRICE_99999",
  shopId: current.shopId, inventoryId: current.inventoryId,
  managementCode: current.managementCode,
  packFingerprint: createHash("sha256")
    .update(JSON.stringify(current)).digest("hex"),
  knownExistingRemoteId: "2JVJtFhb6kB5JBGkDbi2nm",
  knownExistingTitle: knownTitle, knownExistingSkuCode: null,
  knownExistingVisibility: "PUBLIC", knownExistingQuantity: 0,
  knownExistingPriceYen: 89_800, onSaleRows: 2, draftRows: 12,
  observedAt: new Date().toISOString(), noOtherCodeOrTitleMatch: true,
  allowPublic: false });

const imageFile = () => {
  const buffer = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3, 0xff, 0xd9]);
  return { storageKey: "inventory/sofa.jpg", index: 0, buffer,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    filename: "BELLO-1-test.jpg", mimeType: "image/jpeg" };
};

async function withQueue(action) {
  const root = await mkdtemp(join(tmpdir(), "bello-form-only-"));
  try { await enqueueGeneralPrivateCreate(root, pack()); return await action(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("create URL accepts only the exact shop path and one draft ID", () => {
  const base = `https://mercari-shops.com/seller/shops/${shopId}/products/create`;
  assert.deepEqual(inspectGeneralPrivateCreateUrl(base, shopId),
    { valid: true, draftId: null });
  assert.deepEqual(inspectGeneralPrivateCreateUrl(`${base}?productDraftId=abc123`, shopId),
    { valid: true, draftId: "abc123" });
  for (const url of [`${base}?productDraftId=abc&x=1`,
    `${base}?productDraftId=abc&productDraftId=def`,
    `${base}?productDraftId=`, base.replace(shopId, "otherShop"),
    base.replace("https:", "http:"), `${base}#other`])
    assert.equal(inspectGeneralPrivateCreateUrl(url, shopId).valid, false);
});

test("an incomplete remote read blocks before BELLO fetch or claim", async () => {
  await withQueue(async root => {
    let fetches = 0;
    const result = await fillGeneralPrivateCreateFormOnly({ root, inventoryId }, {
      fetchImages: async () => { fetches++; return []; },
    });
    assert.deepEqual(result,
      { status: "BLOCKED", diagnostic: "REMOTE_SCAN_UNAVAILABLE" });
    assert.equal(fetches, 0);
    assert.equal((await listGeneralPrivateCreateJobs(root))[0].claimed, false);
  });
});

test("known existing exception needs exact evidence before the permanent claim", async () => {
  for (const mode of ["disabled", "invalid", "valid"]) {
    const root = await mkdtemp(join(tmpdir(), "bello-known-form-"));
    try {
      const current = knownPack();
      await enqueueGeneralPrivateCreate(root, current);
      const evidence = knownEvidence(current);
      if (mode === "invalid") evidence.knownExistingQuantity = 1;
      const order = [];
      const result = await fillGeneralPrivateCreateFormOnly({ root,
        inventoryId: knownInventoryId,
        allowKnownExistingPrivateTest: mode !== "disabled" }, {
        remotePreflight: async () => ({
          status: "B005396_PRIVATE_TEST_EXCEPTION", allowFinalCreate: false,
          evidence }),
        fetchImages: async () => { order.push("image-read");
          return [imageFile()]; },
        recordKnownExisting: async () => { order.push("record-basis"); },
        claimOnce: async (...args) => { order.push("claim");
          return claimGeneralPrivateCreateOnce(...args); },
        openSession: async () => { order.push("open");
          throw Error("browser unavailable"); },
      });
      if (mode === "valid") {
        assert.deepEqual(order, ["image-read", "record-basis", "claim",
          "open"]);
        assert.equal(result.status, "UNKNOWN");
        assert.equal((await listGeneralPrivateCreateJobs(root))[0].claimed, true);
      } else {
        assert.deepEqual(order, []);
        assert.equal(result.status, "BLOCKED");
        assert.equal((await listGeneralPrivateCreateJobs(root))[0].claimed, false);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("remote status is read once and changing or throwing getters fail closed", async () => {
  await withQueue(async root => {
    let reads = 0;
    const result = await fillGeneralPrivateCreateFormOnly({ root, inventoryId }, {
      remotePreflight: async () => ({
        get status() { return ++reads === 1 ?
          "REMOTE_SCAN_INCOMPLETE" : "TOKEN_ABC123_PRIVATE"; },
        allowFinalCreate: false,
      }),
    });
    assert.deepEqual(result,
      { status: "BLOCKED", diagnostic: "REMOTE_SCAN_INCOMPLETE" });
    assert.equal(reads, 1);
    assert.equal((await listGeneralPrivateCreateJobs(root))[0].claimed, false);
  });
  for (const failingProperty of ["status", "allowFinalCreate"]) {
    await withQueue(async root => {
      const remote = { status: "REMOTE_SCAN_INCOMPLETE",
        allowFinalCreate: false };
      Object.defineProperty(remote, failingProperty, {
        get() { throw Error("TOKEN_ABC123_PRIVATE"); },
      });
      const result = await fillGeneralPrivateCreateFormOnly({ root, inventoryId }, {
        remotePreflight: async () => remote,
      });
      assert.deepEqual(result,
        { status: "BLOCKED", diagnostic: "REMOTE_SCAN_UNVERIFIED" });
      assert.equal((await listGeneralPrivateCreateJobs(root))[0].claimed, false);
    });
  }
});

test("BELLO source is re-read before the claim and form fill never saves", async () => {
  await withQueue(async root => {
    const order = [];
    const listUrl = `https://mercari-shops.com/seller/shops/${shopId}/products?tab=on_sale&visibility=unopened`;
    let url = listUrl;
    const page = { url: () => url,
      evaluate: async () => ({ href: url, timeOrigin: 123456789 }),
      getByRole(role, options) {
        assert.equal(role, "link");
        assert.deepEqual(options, { name: "商品登録", exact: true });
        return { count: async () => 1, isEnabled: async () => true,
          getAttribute: async () => `/seller/shops/${shopId}/products/create`,
          click: async () => { order.push("create-link");
            url = `https://mercari-shops.com/seller/shops/${shopId}/products/create?productDraftId=draft123`; } };
      } };
    const result = await fillGeneralPrivateCreateFormOnly({ root, inventoryId }, {
      remotePreflight: async () => ({ status: "NO_MATCH_IN_OBSERVED_UI",
        allowFinalCreate: false }),
      fetchImages: async ({ pack: current }) => {
        order.push("bello-reread");
        assert.equal(current.managementCode, pack().managementCode);
        return [imageFile()];
      },
      openSession: async ({ claim }) => {
        order.push("shops-open-after-claim");
        assert.equal(claim.status, "UNKNOWN");
        assert.equal((await listGeneralPrivateCreateJobs(root))[0].claimed, true);
        return { state: "LIST_OPEN", page, context: {} };
      },
      fillForm: async (_page, current, files, { onStage, beforeWrite }) => {
        order.push("form-fill");
        assert.equal(current.priceYen, 99999);
        assert.equal(current.quantity, 1);
        assert.equal(files[0].sha256, imageFile().sha256);
        await onStage("CATEGORY_MISMATCH");
        await beforeWrite();
        return [{ pathHash: "a".repeat(64), width: 960, height: 960 }];
      },
    });
    assert.deepEqual(order, ["bello-reread", "shops-open-after-claim",
      "create-link", "form-fill"]);
    assert.equal(result.status, "FORM_READY_NO_SAVE");
    assert.equal(result.allowSave, false);
    assert.equal(result.listingConfirmed, false);
    assert.equal(result.observedDraftId, "draft123");
    assert.equal(result.documentTimeOrigin, 123456789);
    assert.deepEqual(result.selectedImageSha256s, [imageFile().sha256]);
    assert.equal(result.selectedAssets[0].pathHash, "a".repeat(64));
    assert.equal((await listGeneralPrivateCreateJobs(root))[0].outcome, "UNKNOWN");
    const again = await fillGeneralPrivateCreateFormOnly({ root, inventoryId });
    assert.equal(again.diagnostic, "LOCAL_CLAIM_UNKNOWN_NO_RETRY");
  });
});

test("changed current image bytes stop before claim, browser open or upload", async () => {
  await withQueue(async root => {
    let later = 0;
    const result = await fillGeneralPrivateCreateFormOnly({ root,
      inventoryId, expectedImageSha256: "b".repeat(64) }, {
      remotePreflight: async () => ({ status: "NO_MATCH_IN_OBSERVED_UI",
        allowFinalCreate: false }),
      fetchImages: async () => [imageFile()],
      claimOnce: async () => { later++; },
      openSession: async () => { later++; },
      fillForm: async () => { later++; },
    });
    assert.deepEqual(result, { status: "BLOCKED",
      diagnostic: "REVIEWED_IMAGE_CHANGED" });
    assert.equal(later, 0);
    assert.equal((await listGeneralPrivateCreateJobs(root))[0].claimed, false);
  });
});

test("an uncertain create page consumes the claim and cannot retry", async () => {
  await withQueue(async root => {
    const dependencies = { remotePreflight: async () => ({
      status: "NO_MATCH_IN_OBSERVED_UI", allowFinalCreate: false }),
    fetchImages: async () => [imageFile()],
    openSession: async () => { throw Error("browser unavailable"); } };
    const first = await fillGeneralPrivateCreateFormOnly({ root, inventoryId },
      dependencies);
    assert.equal(first.status, "UNKNOWN");
    assert.equal(first.diagnostic, "BROWSER_UNAVAILABLE");
    assert.equal((await listGeneralPrivateCreateJobs(root))[0].claimed, true);
    const second = await fillGeneralPrivateCreateFormOnly({ root, inventoryId },
      dependencies);
    assert.equal(second.diagnostic, "LOCAL_CLAIM_UNKNOWN_NO_RETRY");
  });
});

function simulatedReadyForm(fillForm) {
  const listUrl = `https://mercari-shops.com/seller/shops/${shopId}/products?tab=on_sale&visibility=unopened`;
  const createUrl = `https://mercari-shops.com/seller/shops/${shopId}/products/create`;
  let url = listUrl;
  let timeOrigin = 123456789;
  const page = { url: () => url,
    evaluate: async () => ({ href: url, timeOrigin }),
    getByRole(role) {
      assert.equal(role, "link");
      return { count: async () => 1, isEnabled: async () => true,
        getAttribute: async () => createUrl,
        click: async () => { url = createUrl; } };
    } };
  return { page, createUrl,
    setUrl: value => { url = value; },
    setTimeOrigin: value => { timeOrigin = value; },
    dependencies: { remotePreflight: async () => ({
      status: "NO_MATCH_IN_OBSERVED_UI", allowFinalCreate: false }),
    fetchImages: async () => [imageFile()],
    openSession: async () => ({ state: "LIST_OPEN", page, context: {} }),
    fillForm } };
}

test("document or draft identity changes stop the claimed form before another write", async () => {
  for (const kind of ["document", "draft"]) {
    await withQueue(async root => {
      let simulation;
      simulation = simulatedReadyForm(async (_page, _pack, _files,
        { beforeWrite }) => {
        await beforeWrite();
        if (kind === "document") simulation.setTimeOrigin(123456790);
        else simulation.setUrl(`${simulation.createUrl}?productDraftId=changedDraft`);
        await beforeWrite();
        assert.fail("Changed target must not reach a form write");
      });
      if (kind === "draft") {
        // A first draft ID is pinned by the checkpoint immediately after the link.
        const originalClick = simulation.page.getByRole;
        simulation.page.getByRole = (...args) => {
          const link = originalClick(...args);
          return { ...link, click: async () => {
            await link.click();
            simulation.setUrl(`${simulation.createUrl}?productDraftId=firstDraft`);
          } };
        };
      }
      const result = await fillGeneralPrivateCreateFormOnly({ root, inventoryId },
        simulation.dependencies);
      assert.equal(result.status, "UNKNOWN");
      assert.equal(result.diagnostic, kind === "document" ?
        "CREATE_DOCUMENT_UNVERIFIED" : "MULTIPLE_DRAFT_IDS_OBSERVED");
      assert.equal((await listGeneralPrivateCreateJobs(root))[0].claimed, true);
    });
  }
});

test("arbitrary uppercase errors and remote statuses never become diagnostics", async () => {
  for (const message of ["UNTRUSTED_SECRET_VALUE", "FORM_READY_NO_SAVE"]) {
    await withQueue(async root => {
      const simulation = simulatedReadyForm(async () => {
        throw Error(message);
      });
      const result = await fillGeneralPrivateCreateFormOnly({ root, inventoryId },
        simulation.dependencies);
      assert.equal(result.diagnostic, "FORM_FIELDS_UNCERTAIN");
      assert.equal((await listGeneralPrivateCreateJobs(root))[0].outcome, "UNKNOWN");
    });
  }
  await withQueue(async root => {
    const result = await fillGeneralPrivateCreateFormOnly({ root, inventoryId }, {
      remotePreflight: async () => ({ status: "UNTRUSTED_SECRET_VALUE",
        allowFinalCreate: false }),
    });
    assert.equal(result.diagnostic, "REMOTE_SCAN_UNVERIFIED");
    assert.equal((await listGeneralPrivateCreateJobs(root))[0].claimed, false);
  });
});

test("dedicated session refuses restored pages after the durable claim", async () => {
  await withQueue(async root => {
    const claim = await claimGeneralPrivateCreateOnce(root, inventoryId);
    let closed = false;
    let enabledConnection = 0;
    let newPages = 0;
    await assert.rejects(openGeneralPrivateCreateFormSession({ root,
      profileDir: join(root, "shops-profile"), shopId, claim,
      launchPersistentContext: async (_profile, options) => {
        assert.equal(options.offline, true);
        assert.equal(options.serviceWorkers, "block");
        return {
        pages: () => [{ url: () => `https://mercari-shops.com/seller/shops/${shopId}/products/create` }],
        newPage: async () => { newPages++; throw Error("Unexpected page"); },
        serviceWorkers: () => [],
        setOffline: async value => { if (value === false) enabledConnection++; },
        close: async () => { closed = true; },
      }; },
    }), /GENERAL_FORM_BROWSER_UNAVAILABLE/);
    assert.equal(closed, true);
    assert.equal(enabledConnection, 0);
    assert.equal(newPages, 0);
  });
});

test("dedicated session opens a fresh exact-shop list after the claim", async () => {
  await withQueue(async root => {
    const claim = await claimGeneralPrivateCreateOnce(root, inventoryId);
    let openPages = [];
    let currentUrl = "about:blank";
    const page = { url: () => currentUrl,
      goto: async value => { currentUrl = value; } };
    const context = { pages: () => openPages,
      serviceWorkers: () => [], setOffline: async value => {
        assert.equal(value, false); },
      newPage: async () => { openPages = [page]; return page; },
      close: async () => { throw Error("Unexpected close"); } };
    const session = await openGeneralPrivateCreateFormSession({ root,
      profileDir: join(root, "shops-profile"), shopId, claim,
      launchPersistentContext: async (_profile, options) => {
        assert.equal(options.offline, true);
        assert.equal(options.serviceWorkers, "block");
        return context;
      } });
    assert.equal(session.state, "LIST_OPEN");
    assert.equal(session.page.url(),
      `https://mercari-shops.com/seller/shops/${shopId}/products?tab=on_sale&visibility=unopened`);
  });
});

function fakeObservedForm(categoryLeafOverride = null,
  { navigateOnFirstEnabled = false } = {}) {
  const createUrl = `https://mercari-shops.com/seller/shops/${shopId}/products/create`;
  let url = createUrl;
  const state = { fields: {}, shipping: {}, imageCount: 0,
    condition: "新品、未使用", category: "", leaf: "選択してください",
    categorySteps: [], saveClicks: 0 };
  const withHandle = value => ({ ...value, elementHandle: async () => value });
  const control = name => withHandle({ count: async () => 1,
    isEnabled: async () => {
      if (navigateOnFirstEnabled && name === "name")
        url = "https://mercari-shops.com/seller/shops/another/products/create";
      return true;
    },
    fill: async value => { state.fields[name] = value; },
    selectOption: async value => { state.shipping[name] = value; },
    inputValue: async () => state.fields[name] ?? state.shipping[name] ?? "",
  });
  const page = {
    url: () => url,
    locator(selector) {
      const field = selector.match(/^\[name="(.+)"\]$/)?.[1];
      const shipping = selector.match(/^select\[name="(.+)"\]$/)?.[1];
      if (field || shipping) return control(field ?? shipping);
      if (selector === 'input[type="file"][multiple]')
        return withHandle({ count: async () => 1, isEnabled: async () => true,
          setInputFiles: async files => { state.imageCount = files.length; } });
      if (selector === 'img[alt="uploaded-image"]')
        return { count: async () => state.imageCount,
          first: () => ({ waitFor: async () => {
            assert.equal(state.imageCount, 1); } }) };
      if (selector === "body") return { evaluate: async () => ({
        name: state.fields.name, description: state.fields.description,
        price: state.fields.price, quantity: state.fields["variants.0.quantity"],
        sku: state.fields["variants.0.skuCode"], condition: state.condition,
        category: state.category, shipping: state.shipping,
        imageCount: state.imageCount }) };
      throw Error(`Unexpected observed selector: ${selector}`);
    },
    getByTestId(id) {
      if (id === "condition-select-box")
        return withHandle({ count: async () => 1, isEnabled: async () => true,
          innerText: async () => state.condition, click: async () => {} });
      if (id === "categories")
        return withHandle({ count: async () => 1, isEnabled: async () => true,
          innerText: async () => state.leaf, click: async () => {} });
      throw Error(`Unexpected test id: ${id}`);
    },
    getByText(label) { return withHandle({ count: async () => 1,
      isEnabled: async () => true, click: async () => { state.condition = label; } }); },
    getByRole(role) {
      assert.equal(role, "dialog");
      return { count: async () => 1,
        getByText(label) { return withHandle({ count: async () => 1,
          isEnabled: async () => true, click: async () => {
            state.categorySteps.push(label);
            state.leaf = categoryLeafOverride ?? label;
            state.category = `カテゴリー${state.categorySteps.join(">")}`;
          } }); } };
    },
  };
  return { page, state };
}

test("observed DOM adapter fills exact values and checks the leaf, without save", async () => {
  const { page, state } = fakeObservedForm();
  const stages = [];
  const assets = await fillGeneralPrivateCreateFormOnce(page, pack(),
    [imageFile()], { onStage: code => stages.push(code),
      beforeWrite: async () => {},
      readImages: async () => [{ pathHash: "a".repeat(64),
        width: 960, height: 960 }] });
  assert.equal(assets.length, 1);
  assert.equal(state.fields.price, "99999");
  assert.equal(state.fields["variants.0.skuCode"], pack().managementCode);
  assert.equal(state.leaf, "2人掛けソファ");
  assert.equal(state.saveClicks, 0);
  assert.ok(stages.includes("IMAGE_PROOF_UNVERIFIED"));
  const changed = fakeObservedForm("別のカテゴリ");
  await assert.rejects(fillGeneralPrivateCreateFormOnce(changed.page, pack(),
    [imageFile()], { beforeWrite: async () => {},
      readImages: async () => [] }),
  { code: "CATEGORY_MISMATCH" });
  assert.equal(changed.state.imageCount, 0);
});

test("navigation during locator enablement causes zero field writes", async () => {
  const { page, state } = fakeObservedForm(null,
    { navigateOnFirstEnabled: true });
  const expected = `https://mercari-shops.com/seller/shops/${shopId}/products/create`;
  await assert.rejects(fillGeneralPrivateCreateFormOnce(page, pack(),
    [imageFile()], { beforeWrite: async () => {
      if (page.url() !== expected) throw Error("CREATE_URL_UNVERIFIED");
    } }), /CREATE_URL_UNVERIFIED/);
  assert.deepEqual(state.fields, {});
  assert.equal(state.imageCount, 0);
});

test("reviewed bytes are checked again at the actual file input boundary", async () => {
  const { page, state } = fakeObservedForm();
  const file = imageFile();
  const reviewed = file.sha256;
  await assert.rejects(fillGeneralPrivateCreateFormOnce(page, pack(),
    [file], { expectedImageSha256: reviewed,
      beforeWrite: async () => {},
      onStage: code => { if (code === "IMAGE_PROOF_UNVERIFIED")
        file.buffer.fill(0); } }), { code: "REVIEWED_IMAGE_CHANGED" });
  assert.equal(state.imageCount, 0, "setInputFiles was never called");
  assert.equal(state.saveClicks, 0);
});
