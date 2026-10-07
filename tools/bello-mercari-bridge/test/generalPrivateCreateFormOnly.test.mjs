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

test("BELLO source is re-read before the claim and form fill never saves", async () => {
  await withQueue(async root => {
    const order = [];
    const listUrl = `https://mercari-shops.com/seller/shops/${shopId}/products?tab=on_sale&visibility=unopened`;
    let url = listUrl;
    const page = { url: () => url,
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
      fillForm: async (_page, current, files, { onStage }) => {
        order.push("form-fill");
        assert.equal(current.priceYen, 99999);
        assert.equal(current.quantity, 1);
        assert.equal(files[0].sha256, imageFile().sha256);
        onStage("CATEGORY_MISMATCH");
        return [{ pathHash: "a".repeat(64), width: 960, height: 960 }];
      },
    });
    assert.deepEqual(order, ["bello-reread", "shops-open-after-claim",
      "create-link", "form-fill"]);
    assert.equal(result.status, "FORM_READY_NO_SAVE");
    assert.equal(result.allowSave, false);
    assert.equal(result.listingConfirmed, false);
    assert.equal(result.observedDraftId, "draft123");
    assert.equal((await listGeneralPrivateCreateJobs(root))[0].outcome, "UNKNOWN");
    const again = await fillGeneralPrivateCreateFormOnly({ root, inventoryId });
    assert.equal(again.diagnostic, "LOCAL_CLAIM_UNKNOWN_NO_RETRY");
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

test("dedicated session refuses restored pages after the durable claim", async () => {
  await withQueue(async root => {
    const claim = await claimGeneralPrivateCreateOnce(root, inventoryId);
    let closed = false;
    await assert.rejects(openGeneralPrivateCreateFormSession({ root,
      profileDir: join(root, "shops-profile"), shopId, claim,
      launchPersistentContext: async () => ({
        pages: () => [{ url: () => `https://mercari-shops.com/seller/shops/${shopId}/products/create` }],
        close: async () => { closed = true; },
      }),
    }), /GENERAL_FORM_BROWSER_UNAVAILABLE/);
    assert.equal(closed, true);
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
      newPage: async () => { openPages = [page]; return page; },
      close: async () => { throw Error("Unexpected close"); } };
    const session = await openGeneralPrivateCreateFormSession({ root,
      profileDir: join(root, "shops-profile"), shopId, claim,
      launchPersistentContext: async () => context });
    assert.equal(session.state, "LIST_OPEN");
    assert.equal(session.page.url(),
      `https://mercari-shops.com/seller/shops/${shopId}/products?tab=on_sale&visibility=unopened`);
  });
});

function fakeObservedForm(categoryLeafOverride = null) {
  const state = { fields: {}, shipping: {}, imageCount: 0,
    condition: "新品、未使用", category: "", leaf: "選択してください",
    categorySteps: [], saveClicks: 0 };
  const control = name => ({ count: async () => 1, isEnabled: async () => true,
    fill: async value => { state.fields[name] = value; },
    selectOption: async value => { state.shipping[name] = value; },
    inputValue: async () => state.fields[name] ?? state.shipping[name] ?? "",
  });
  const page = {
    url: () => `https://mercari-shops.com/seller/shops/${shopId}/products/create`,
    locator(selector) {
      const field = selector.match(/^\[name="(.+)"\]$/)?.[1];
      const shipping = selector.match(/^select\[name="(.+)"\]$/)?.[1];
      if (field || shipping) return control(field ?? shipping);
      if (selector === 'input[type="file"][multiple]')
        return { count: async () => 1, isEnabled: async () => true,
          setInputFiles: async files => { state.imageCount = files.length; } };
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
        return { count: async () => 1, isEnabled: async () => true,
          innerText: async () => state.condition, click: async () => {} };
      if (id === "categories")
        return { count: async () => 1, isEnabled: async () => true,
          innerText: async () => state.leaf, click: async () => {} };
      throw Error(`Unexpected test id: ${id}`);
    },
    getByText(label) { return { count: async () => 1,
      isEnabled: async () => true, click: async () => { state.condition = label; } }; },
    getByRole(role) {
      assert.equal(role, "dialog");
      return { count: async () => 1,
        getByText(label) { return { count: async () => 1,
          isEnabled: async () => true, click: async () => {
            state.categorySteps.push(label);
            state.leaf = categoryLeafOverride ?? label;
            state.category = `カテゴリー${state.categorySteps.join(">")}`;
          } }; } };
    },
  };
  return { page, state };
}

test("observed DOM adapter fills exact values and checks the leaf, without save", async () => {
  const { page, state } = fakeObservedForm();
  const stages = [];
  const assets = await fillGeneralPrivateCreateFormOnce(page, pack(),
    [imageFile()], { onStage: code => stages.push(code),
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
    [imageFile()], { readImages: async () => [] }),
  { code: "CATEGORY_MISMATCH" });
  assert.equal(changed.state.imageCount, 0);
});
