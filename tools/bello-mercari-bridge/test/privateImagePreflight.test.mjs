import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectPrivateImagePreflight, isPinnedB005757ImageTarget } from
  "../src/privateImagePreflight.mjs";

const requestId = "7ecb7f7837d93390fe5f701abdc62e9acfaf5b35b4b751789c4183a2a376e825";
const target = { shopId: "evkhihBFFNn5hukMS9s36H",
  remoteId: "2JXjWPRVBxjZ2K2vgTGNqy", inventoryCode: "B005757",
  skuCode: "B005757-TEST-20261004-caf445ac6e676343", priceYen: 98000, quantity: 1 };
const editUrl = `https://mercari-shops.com/seller/shops/${target.shopId}/products/${target.remoteId}/edit`;
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
  privateState = true, input = true, redirectDuringFields = false,
  recheckChanged = false, readThrows = false } = {}) {
  const actions = [];
  let redirected = false;
  let fieldReads = 0;
  const page = { url: () => state === "AUTH_REQUIRED" || redirected ?
    "https://mercari-shops.com/signin/seller" : editUrl };
  const deps = {
    openSession: async () => {
      actions.push("open");
      return { page, state, context: { close: async () => { actions.push("close"); } } };
    },
    readFields: async () => {
      actions.push("fields");
      fieldReads++;
      if (readThrows) throw Error("private source value must not escape");
      if (redirectDuringFields) redirected = true;
      return fields && !redirected ?
        { title: recheckChanged && fieldReads === 2 ? "Changed product" : "Exact product" } : null;
    },
    readImages: async () => {
      actions.push("images");
      return images === "two" ? [{ pathHash: "a".repeat(64) },
        { pathHash: "b".repeat(64) }] :
        images === "bad-hash" ? [{ pathHash: "unverified" }] :
        images ? [{ pathHash: "a".repeat(64) }] : null;
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
      playwrightModulePath: root, requestId, target, imagePath, imageSha256 }, fake.deps);
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
      [{ images: "two" }, "ORIGINAL_IMAGE_UNVERIFIED"],
      [{ images: "bad-hash" }, "ORIGINAL_IMAGE_UNVERIFIED"],
      [{ privateState: false }, "PRIVATE_STATE_UNVERIFIED"],
      [{ recheckChanged: true }, "RECHECK_UNVERIFIED"],
      [{ input: false }, "FILE_INPUT_UNVERIFIED"],
      [{ readThrows: true }, "READ_FAILED"],
    ]) {
      const fake = harness(scenario);
      const result = await inspectPrivateImagePreflight({ root, profileDir: root,
        playwrightModulePath: root, requestId, target, imagePath, imageSha256 }, fake.deps);
      assert.equal(result.reasonCode, reason);
      assert.equal(result.status, reason === "LOGIN_REQUIRED" ?
        "AUTH_REQUIRED" : "PREFLIGHT_BLOCKED");
      assert.equal(fake.actions.at(-1), "close");
    }
    const redirected = harness({ redirectDuringFields: true });
    assert.deepEqual(await inspectPrivateImagePreflight({ root, profileDir: root,
      playwrightModulePath: root, requestId, target, imagePath, imageSha256 }, redirected.deps),
    { status: "AUTH_REQUIRED", reasonCode: "LOGIN_REQUIRED" });
  }));

test("changed image bytes stop locally before any Shops browser is opened", () =>
  withImage(async ({ root, imagePath }) => {
    const fake = harness();
    const result = await inspectPrivateImagePreflight({ root, profileDir: root,
      playwrightModulePath: root, requestId, target, imagePath,
      imageSha256: "b".repeat(64) }, fake.deps);
    assert.deepEqual(result,
      { status: "PREFLIGHT_BLOCKED", reasonCode: "IMAGE_PROOF_UNVERIFIED" });
    assert.deepEqual(fake.actions, []);
  }));

test("preflight rejects every changed B005757 identity before opening Chrome", () =>
  withImage(async ({ root, imagePath }) => {
    const variants = [
      [target, "a".repeat(64)],
      [{ ...target, shopId: "otherShop" }, requestId],
      [{ ...target, remoteId: "otherProduct" }, requestId],
      [{ ...target, inventoryCode: "B005795" }, requestId],
      [{ ...target, skuCode: "otherSku" }, requestId],
      [{ ...target, priceYen: 97000 }, requestId],
      [{ ...target, quantity: 0 }, requestId],
      [{ ...target, extra: true }, requestId],
      [{ shopId: "shop1", remoteId: "existing1", inventoryCode: "B005795",
        priceYen: 90000, quantity: 0 }, requestId],
    ];
    assert.equal(isPinnedB005757ImageTarget(target, requestId), true);
    for (const [changed, changedRequestId] of variants) {
      assert.equal(isPinnedB005757ImageTarget(changed, changedRequestId), false);
      const fake = harness();
      await assert.rejects(inspectPrivateImagePreflight({ root, profileDir: root,
        playwrightModulePath: root, requestId: changedRequestId,
        target: changed, imagePath, imageSha256 }, fake.deps));
      assert.deepEqual(fake.actions, []);
    }
  }));
