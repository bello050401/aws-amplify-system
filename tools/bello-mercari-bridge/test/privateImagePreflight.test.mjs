import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectPrivateImagePreflight } from "../src/privateImagePreflight.mjs";

const target = { shopId: "shop1", remoteId: "product1", inventoryCode: "B005757",
  skuCode: "B005757-TEST-20261004-caf445ac6e676343", priceYen: 98000, quantity: 1 };
const editUrl = "https://mercari-shops.com/seller/shops/shop1/products/product1/edit";
const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 1, 2, 3, 0xff, 0xd9]);
const imageSha256 = createHash("sha256").update(bytes).digest("hex");

async function withImage(run) {
  const root = await mkdtemp(join(tmpdir(), "bello-private-image-preflight-"));
  try {
    const imagePath = join(root, "image.jpg");
    await writeFile(imagePath, bytes);
    return await run({ root, imagePath });
  } finally { await rm(root, { recursive: true, force: true }); }
}

function harness({ state = "NAVIGATED_UNVERIFIED", fields = true, images = true,
  privateState = true, input = true, redirectDuringFields = false } = {}) {
  const actions = [];
  let redirected = false;
  const page = { url: () => state === "AUTH_REQUIRED" || redirected ?
    "https://mercari-shops.com/signin/seller" : editUrl };
  const deps = {
    openSession: async () => {
      actions.push("open");
      return { page, state, context: { close: async () => { actions.push("close"); } } };
    },
    readFields: async () => {
      actions.push("fields");
      if (redirectDuringFields) redirected = true;
      return fields && !redirected ? { title: "Exact product" } : null;
    },
    readImages: async () => {
      actions.push("images"); return images ? [{ pathHash: "a".repeat(64) }] : null;
    },
    checkPrivate: async () => {
      actions.push("private"); return privateState;
    },
    fileInput: async () => {
      actions.push("input"); return input ? {} : null;
    },
  };
  return { deps, actions };
}

test("read-only preflight checks the exact private product without selection or save", () =>
  withImage(async ({ root, imagePath }) => {
    const fake = harness();
    const result = await inspectPrivateImagePreflight({ root, profileDir: root,
      playwrightModulePath: root, target, imagePath, imageSha256 }, fake.deps);
    assert.deepEqual(result, { status: "READY", reasonCode: "EXACT_PRIVATE_PRODUCT_READY" });
    assert.deepEqual(fake.actions,
      ["open", "fields", "images", "private", "fields", "images", "input", "close"]);
  }));

test("login and each pre-claim guard return fixed codes and close Chrome", () =>
  withImage(async ({ root, imagePath }) => {
    for (const [scenario, reason] of [
      [{ state: "AUTH_REQUIRED" }, "LOGIN_REQUIRED"],
      [{ state: "UNKNOWN" }, "NAVIGATION_UNVERIFIED"],
      [{ fields: false }, "FIELDS_UNVERIFIED"],
      [{ images: false }, "ORIGINAL_IMAGE_UNVERIFIED"],
      [{ privateState: false }, "PRIVATE_STATE_UNVERIFIED"],
      [{ input: false }, "FILE_INPUT_UNVERIFIED"],
    ]) {
      const fake = harness(scenario);
      const result = await inspectPrivateImagePreflight({ root, profileDir: root,
        playwrightModulePath: root, target, imagePath, imageSha256 }, fake.deps);
      assert.equal(result.reasonCode, reason);
      assert.equal(result.status, reason === "LOGIN_REQUIRED" ?
        "AUTH_REQUIRED" : "PREFLIGHT_BLOCKED");
      assert.equal(fake.actions.at(-1), "close");
    }
    const redirected = harness({ redirectDuringFields: true });
    assert.deepEqual(await inspectPrivateImagePreflight({ root, profileDir: root,
      playwrightModulePath: root, target, imagePath, imageSha256 }, redirected.deps),
    { status: "AUTH_REQUIRED", reasonCode: "LOGIN_REQUIRED" });
  }));

test("changed image bytes stop locally before any Shops browser is opened", () =>
  withImage(async ({ root, imagePath }) => {
    const fake = harness();
    const result = await inspectPrivateImagePreflight({ root, profileDir: root,
      playwrightModulePath: root, target, imagePath,
      imageSha256: "b".repeat(64) }, fake.deps);
    assert.deepEqual(result,
      { status: "PREFLIGHT_BLOCKED", reasonCode: "IMAGE_PROOF_UNVERIFIED" });
    assert.deepEqual(fake.actions, []);
  }));
