import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claimPrivateImageWorkflow, writePrivateImageWorkflowResult } from
  "../src/privateImageWorkflowAttempt.mjs";
import { verifyPrivateImageWorkflowReadOnly } from "../src/privateImageReadback.mjs";

const requestId = "7ecb7f7837d93390fe5f701abdc62e9acfaf5b35b4b751789c4183a2a376e825";
const target = { shopId: "evkhihBFFNn5hukMS9s36H",
  remoteId: "2JXjWPRVBxjZ2K2vgTGNqy", inventoryCode: "B005757",
  skuCode: "B005757-TEST-20261004-caf445ac6e676343", priceYen: 98000, quantity: 1 };
const editUrl = `https://mercari-shops.com/seller/shops/${target.shopId}/products/${target.remoteId}/edit`;
const original = { pathHash: "a".repeat(64), width: 960, height: 960 };
const additional = { pathHash: "b".repeat(64), width: 1080, height: 1080 };

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "bello-image-readback-"));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function recordedUncertainImage(root) {
  const claim = await claimPrivateImageWorkflow(root, target, "c".repeat(64));
  await writePrivateImageWorkflowResult(root, target, claim.attemptId,
    "UNKNOWN", "FILE_SELECTION_UNCERTAIN");
}

function harness({ state = "NAVIGATED_UNVERIFIED", images = [original],
  privateState = true, changedSecondRead = false, fields = true } = {}) {
  const actions = [];
  const page = { url: () => state === "AUTH_REQUIRED" ?
    "https://mercari-shops.com/signin/seller" : editUrl };
  let reads = 0;
  const deps = {
    openSession: async ({ shopId, remoteId }) => {
      assert.equal(shopId, target.shopId);
      assert.equal(remoteId, target.remoteId);
      actions.push("open");
      return { state, page, context: { close: async () => { actions.push("close"); } } };
    },
    readFields: async () => {
      actions.push("fields");
      return fields ? { title: "Exact product" } : null;
    },
    readImages: async () => {
      actions.push("images");
      reads++;
      return changedSecondRead && reads === 2 ? [original] : images;
    },
    checkPrivate: async () => { actions.push("private"); return privateState; },
  };
  return { deps, actions };
}

test("fresh exact-product read reports one or two private images without a write", () =>
  withRoot(async root => {
    await recordedUncertainImage(root);
    for (const [images, status] of [
      [[original], "PRIVATE_ONE_IMAGE_OBSERVED"],
      [[original, { ...additional, assetId: "private-asset-id" }],
        "PRIVATE_TWO_IMAGES_UNATTRIBUTED"],
    ]) {
      const fake = harness({ images });
      const result = await verifyPrivateImageWorkflowReadOnly({ root, profileDir: root,
        playwrightModulePath: root, requestId, target }, fake.deps);
      assert.deepEqual(result, { status });
      assert.equal(JSON.stringify(result).includes("private-asset-id"), false);
      assert.deepEqual(fake.actions,
        ["open", "fields", "images", "private", "fields", "images", "close"]);
    }
  }));

test("missing prior claim and a changed target never open Shops", () =>
  withRoot(async root => {
    const fake = harness();
    assert.deepEqual(await verifyPrivateImageWorkflowReadOnly({ root, profileDir: root,
      playwrightModulePath: root, requestId, target }, fake.deps),
    { status: "NO_ELIGIBLE_ATTEMPT" });
    assert.deepEqual(fake.actions, []);
    await recordedUncertainImage(root);
    await assert.rejects(verifyPrivateImageWorkflowReadOnly({ root, profileDir: root,
      playwrightModulePath: root, requestId: "d".repeat(64), target }, fake.deps));
    await assert.rejects(verifyPrivateImageWorkflowReadOnly({ root, profileDir: root,
      playwrightModulePath: root, requestId,
      target: { ...target, priceYen: 97000 } }, fake.deps));
    assert.deepEqual(fake.actions, []);
  }));

test("authentication, changed images, missing fields or privacy remain unverified", () =>
  withRoot(async root => {
    await recordedUncertainImage(root);
    for (const [options, status] of [
      [{ state: "AUTH_REQUIRED" }, "AUTH_REQUIRED"],
      [{ changedSecondRead: true, images: [original, additional] }, "UNVERIFIED"],
      [{ images: [{ ...original, width: 0 }] }, "UNVERIFIED"],
      [{ privateState: false }, "UNVERIFIED"],
      [{ fields: false }, "UNVERIFIED"],
    ]) {
      const fake = harness(options);
      assert.deepEqual(await verifyPrivateImageWorkflowReadOnly({ root, profileDir: root,
        playwrightModulePath: root, requestId, target }, fake.deps), { status });
      assert.equal(fake.actions.at(-1), "close");
    }
  }));
