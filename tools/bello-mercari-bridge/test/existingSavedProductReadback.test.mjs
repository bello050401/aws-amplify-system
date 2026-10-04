import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { claimManualImageOnce } from "../src/manualImageAttempt.mjs";
import { claimManualSaveOnce } from "../src/manualSaveAttempt.mjs";
import { verifyExistingSavedProductReadOnly, readExistingSavedProductReadback } from
  "../src/existingSavedProductReadback.mjs";

const target = { shopId: "shop1", remoteId: "existing1", inventoryCode: "B005795",
  priceYen: 90000, quantity: 0 };
const sha = createHash("sha256").update("existing image").digest("hex");
const url = "https://mercari-shops.com/seller/shops/shop1/products/existing1/edit";

async function withRoot(work) {
  const root = await mkdtemp(join(tmpdir(), "bello-readback-"));
  try { return await work(root); }
  finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + "\\"));
    await rm(root, { recursive: true, force: true });
  }
}

function harness({ privateList = true, changed = false } = {}) {
  const actions = [];
  const page = { url: () => url };
  const deps = {
    openSession: async () => ({ state: "NAVIGATED_UNVERIFIED", page,
      context: { close: async () => { actions.push("close"); } } }),
    readFields: async () => { actions.push("fields"); return { title: "Exact product" }; },
    readImages: async () => {
      actions.push("images");
      const second = changed && actions.filter(item => item === "images").length > 1 ?
        "c".repeat(64) : "b".repeat(64);
      return [{ pathHash: "a".repeat(64), width: 960, height: 960 },
        { pathHash: second, width: 1080, height: 1080 }];
    },
    checkPrivate: async () => { actions.push("private-list"); return privateList; },
  };
  return { deps, actions };
}

test("old image and save attempts can be linked to a fresh read without another write", () =>
  withRoot(async root => {
    await claimManualImageOnce(root, target, sha);
    await claimManualSaveOnce(root, target);
    const fake = harness();
    const result = await verifyExistingSavedProductReadOnly({ root, profileDir: root,
      playwrightModulePath: root, target, imageSha256: sha }, fake.deps);
    assert.equal(result.status, "OBSERVED_PRIVATE_TWO_IMAGES");
    assert.deepEqual(fake.actions, ["fields", "images", "private-list",
      "fields", "images", "close"]);
    assert.deepEqual(await readExistingSavedProductReadback(root, target, sha), result);
    const secondRead = harness({ privateList: false });
    assert.equal((await verifyExistingSavedProductReadOnly({ root, profileDir: root,
      playwrightModulePath: root, target, imageSha256: sha }, secondRead.deps)).status,
    "UNKNOWN", "a later read may safely update the current-state observation");
    assert.equal((await readExistingSavedProductReadback(root, target, sha)).status, "UNKNOWN");
  }));

test("missing old markers prevents navigation and changing images never confirms", () =>
  withRoot(async root => {
    const fake = harness();
    assert.equal((await verifyExistingSavedProductReadOnly({ root, profileDir: root,
      playwrightModulePath: root, target, imageSha256: sha }, fake.deps)).status,
    "PRIOR_ATTEMPT_MISMATCH");
    assert.deepEqual(fake.actions, []);
    await claimManualImageOnce(root, target, sha);
    await claimManualSaveOnce(root, target);
    const changed = harness({ changed: true });
    assert.equal((await verifyExistingSavedProductReadOnly({ root, profileDir: root,
      playwrightModulePath: root, target, imageSha256: sha }, changed.deps)).status,
    "UNKNOWN");
    assert.equal((await readExistingSavedProductReadback(root, target, sha)).status, "UNKNOWN");
  }));
