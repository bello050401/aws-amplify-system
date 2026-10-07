import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readManualSaveClaim } from "../src/manualSaveAttempt.mjs";
import { readPinnedEditFields, saveExistingPrivateOnce } from "../src/saveExistingPrivateOnce.mjs";

const target = { shopId: "shop1", remoteId: "existing1", inventoryCode: "B005795",
  priceYen: 90000, quantity: 0 };
const editUrl = "https://mercari-shops.com/seller/shops/shop1/products/existing1/edit";

function locator(count = 1, name = "") {
  return { count: async () => count, isEnabled: async () => true,
    getAttribute: async attribute => attribute === "aria-modal" ? "true" :
      attribute === "type" ? "button" : null,
    getByText: () => locator(1),
    getByRole: (_, options) => locator(1, options?.name),
    locator: () => locator(1),
    click: async () => {},
    waitFor: async () => {},
    name };
}

function harness({ ack = true, privateBefore = true, changedAfter = false,
  closeDuringClick = false, nextDisabled = false, nextClickThrows = false } = {}) {
  const clicks = [];
  let closed = false;
  let checks = 0;
  let reads = 0;
  let checkpoint = null;
  const context = new EventEmitter();
  context.close = async () => { closed = true; context.emit("close"); };
  const page = {
    url: () => editUrl,
    goto: async url => { assert.equal(url, editUrl); },
    getByRole: (_, options) => {
      if (options?.name === "公開設定に進む")
        return { ...locator(), isEnabled: async () => !nextDisabled,
          click: async () => {
            clicks.push("next");
            if (nextClickThrows) throw Error("Next click outcome is unknown");
          } };
      if (_ === "dialog") return {
        ...locator(), locator: () => ({ ...locator(), getByRole: (_, button) => button ? ({
          ...locator(), click: async () => {
            clicks.push(button.name);
            if (closeDuringClick && button.name === "非公開で保存する") {
              await context.close();
              throw Error("Chrome closed during save click");
            }
          },
        }) : locator(3) }),
      };
      return locator();
    },
  };
  const dependencies = {
    openSession: async () => ({ state: "NAVIGATED_UNVERIFIED", page, context }),
    readFields: async () => {
      reads++;
      return changedAfter && reads >= 3 ?
        { title: "A title changed before save", sku: target.inventoryCode, priceYen: 90000,
          quantity: 0 } :
        { title: "Existing title", sku: target.inventoryCode, priceYen: 90000, quantity: 0 };
    },
    checkPrivate: async () => { checks++; return privateBefore && (!changedAfter || checks < 2); },
    observe: () => ({ checkpoint: () => { checkpoint = clicks.slice(); return 0; },
      snapshot: () => [],
      waitForPrivateSaveAcknowledgement: async (id, timeout, afterOrder) => {
        assert.equal(id, target.remoteId);
        assert.equal(afterOrder, 0);
        assert.deepEqual(checkpoint, ["next"]);
        assert.deepEqual(clicks, ["next", "非公開で保存する"]);
        return ack;
      },
      stop: async () => [] }),
  };
  return { dependencies, clicks, get closed() { return closed; } };
}

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "bello-private-save-"));
  try { return await run(root); }
  finally {
    assert.equal(resolve(root).startsWith(resolve(tmpdir()) + "\\"), true);
    await rm(root, { recursive: true, force: true });
  }
}

test("exact existing product is saved once and remains permanently non-retryable", () => withRoot(async root => {
  const fake = harness();
  const input = { root, profileDir: root, playwrightModulePath: root, target };
  const first = await saveExistingPrivateOnce(input, fake.dependencies);
  assert.equal(first.status, "UNKNOWN");
  assert.equal(first.diagnostic, "PRIVATE_CLICK_RETURNED");
  assert.equal(first.listingConfirmed, false);
  assert.deepEqual(fake.clicks, ["next", "非公開で保存する"]);
  assert.equal(fake.closed, false, "the browser stays open so pending save traffic is not cancelled");
  assert.ok(first.retainedSession);
  assert.equal((await readManualSaveClaim(root, target)).claimed, true);
  const second = await saveExistingPrivateOnce(input, fake.dependencies);
  assert.equal(second.status, "ALREADY_ATTEMPTED");
  assert.equal(fake.clicks.length, 2);
}));

test("uncertain response retains marker and never clicks again", () => withRoot(async root => {
  const fake = harness({ ack: false });
  const input = { root, profileDir: root, playwrightModulePath: root, target };
  const first = await saveExistingPrivateOnce(input, fake.dependencies);
  assert.equal(first.status, "UNKNOWN");
  assert.equal(first.postflightPrivate, false);
  assert.equal((await saveExistingPrivateOnce(input, fake.dependencies)).status, "ALREADY_ATTEMPTED");
  assert.deepEqual(fake.clicks, ["next", "非公開で保存する"]);
}));

test("private-state preflight failure makes no claim or click", () => withRoot(async root => {
  const fake = harness({ privateBefore: false });
  const result = await saveExistingPrivateOnce({ root, profileDir: root,
    playwrightModulePath: root, target }, fake.dependencies);
  assert.equal(result.status, "PREFLIGHT_BLOCKED");
  assert.deepEqual(fake.clicks, []);
  assert.equal((await readManualSaveClaim(root, target)).claimed, false);
  assert.equal(fake.closed, true);
}));

test("a title changed in the save dialog stops before the final save click", () => withRoot(async root => {
  const fake = harness({ changedAfter: true });
  const result = await saveExistingPrivateOnce({ root, profileDir: root,
    playwrightModulePath: root, target }, fake.dependencies);
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.diagnostic, "POST_NEXT_FIELDS_CHECK");
  assert.deepEqual(fake.clicks, ["next"]);
  assert.equal((await readManualSaveClaim(root, target)).claimed, true);
  assert.equal(fake.closed, false);
}));

test("a Chrome close during the final click is immediately visible to the caller", () => withRoot(async root => {
  const fake = harness({ closeDuringClick: true });
  const result = await saveExistingPrivateOnce({ root, profileDir: root,
    playwrightModulePath: root, target }, fake.dependencies);
  assert.equal(result.status, "UNKNOWN");
  assert.equal(fake.closed, true);
  let notified = false;
  result.retainedSession.onClose(() => { notified = true; });
  assert.equal(notified, true);
  assert.equal((await readManualSaveClaim(root, target)).claimed, true);
}));

test("a blocked next control is distinct from an uncertain next click", () => withRoot(async root => {
  const input = { root, profileDir: root, playwrightModulePath: root, target };
  const blocked = harness({ nextDisabled: true });
  const first = await saveExistingPrivateOnce(input, blocked.dependencies);
  assert.equal(first.status, "BLOCKED_BEFORE_CLICK");
  assert.equal(first.diagnostic, "NEXT_CONTROL_CHECK");
  assert.deepEqual(blocked.clicks, []);
}));

test("a next click error is UNKNOWN because the first step may have sent a request", () => withRoot(async root => {
  const fake = harness({ nextClickThrows: true });
  const result = await saveExistingPrivateOnce({ root, profileDir: root,
    playwrightModulePath: root, target }, fake.dependencies);
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.diagnostic, "NEXT_CLICK_UNCERTAIN");
  assert.deepEqual(fake.clicks, ["next"]);
  assert.equal((await readManualSaveClaim(root, target)).claimed, true);
}));

test("field validation rejects a different SKU, price or quantity before any click", async () => {
  const fields = { documentUrl: editUrl, rows: [
    { label: "商品名", name: "observed-name", value: "Existing title" },
    { label: "商品管理コード", name: "variants.0.skuCode", value: "B005795" },
    { label: "販売価格", name: "price", value: "¥90,000" },
  ], quantity: "0" };
  const page = { url: () => editUrl, getByRole: () => locator(),
    locator: () => ({ evaluateAll: async () => fields }) };
  assert.equal((await readPinnedEditFields(page, editUrl, target)).sku, "B005795");
  const testSku = "B005757-TEST-20261004-caf445ac6e676343";
  fields.rows[1].value = testSku;
  assert.equal((await readPinnedEditFields(page, editUrl,
    { ...target, skuCode: testSku })).sku, testSku);
  assert.equal(await readPinnedEditFields(page, editUrl, target), null);
  fields.rows[1].value = "B005795";
  for (const changed of [
    { rows: fields.rows.map(row => row.label === "商品管理コード" ? { ...row, value: "OTHER" } : row) },
    { rows: fields.rows.map(row => row.label === "販売価格" ? { ...row, value: "¥91,000" } : row) },
    { quantity: "1" },
  ]) {
    Object.assign(fields, changed);
    assert.equal(await readPinnedEditFields(page, editUrl, target), null);
    Object.assign(fields, { documentUrl: editUrl, rows: [
      { label: "商品名", name: "observed-name", value: "Existing title" },
      { label: "商品管理コード", name: "variants.0.skuCode", value: "B005795" },
      { label: "販売価格", name: "price", value: "¥90,000" },
    ], quantity: "0" });
  }
});
