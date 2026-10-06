import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runPrivateImageWorkflowOnce } from "../src/privateImageWorkflow.mjs";
import { claimManualImageOnce } from "../src/manualImageAttempt.mjs";
import { addExistingImageOnce } from "../src/addExistingImageOnce.mjs";
import { saveExistingPrivateOnce } from "../src/saveExistingPrivateOnce.mjs";
import { readPrivateImageWorkflowClaim, readPrivateImageWorkflowResult } from
  "../src/privateImageWorkflowAttempt.mjs";

const target = { shopId: "shop1", remoteId: "existing1", inventoryCode: "B005795",
  priceYen: 90000, quantity: 0 };
const editUrl = "https://mercari-shops.com/seller/shops/shop1/products/existing1/edit";
const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 1, 2, 3, 0xff, 0xd9]);
const sha = createHash("sha256").update(bytes).digest("hex");
const original = { pathHash: "a".repeat(64), width: 960, height: 960 };
const added = { pathHash: "b".repeat(64), width: 1080, height: 1080 };

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "bello-private-image-flow-"));
  try {
    const imagePath = join(root, "image.jpg");
    await writeFile(imagePath, bytes);
    return await run({ root, imagePath });
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + "\\"));
    await rm(root, { recursive: true, force: true });
  }
}

function harness({ acknowledged = true, auth = false, probeAvailable = false,
  pendingPreview = false, previewStable = true } = {}) {
  const actions = [];
  let selected = false;
  let reloaded = false;
  let previewChecks = 0;
  let closed = false;
  const context = new EventEmitter();
  context.close = async () => { closed = true; context.emit("close"); };
  if (probeAvailable) context.newPage = async () => ({
    url: () => editUrl,
    goto: async url => { assert.equal(url, editUrl); actions.push("probe-reload"); },
    close: async () => { actions.push("probe-close"); },
  });
  const page = {
    url: () => auth ? "https://mercari-shops.com/signin/seller" : editUrl,
    goto: async url => { actions.push("reload"); assert.equal(url, editUrl);
      reloaded = true; },
    getByRole: (role, options) => {
      assert.equal(role, "button");
      assert.equal(options.name, "公開設定に進む");
      return { count: async () => 1, isEnabled: async () => true,
        click: async () => { actions.push("next"); } };
    },
  };
  const observer = { checkpoint: () => { actions.push("checkpoint"); return 0; },
    waitForExactPrivateUpdate: async () => { actions.push("ack"); return acknowledged; },
    snapshot: () => [], stop: async () => { actions.push("observer-stop"); return []; } };
  const deps = {
    openSession: async () => ({ context, page,
      state: auth ? "AUTH_REQUIRED" : "NAVIGATED_UNVERIFIED" }),
    readFields: async () => { actions.push("fields"); return { title: "One exact product" }; },
    readImages: async currentPage => { actions.push("images"); return selected ?
      pendingPreview && !reloaded && currentPage === page ? null : [original, added] :
      [original]; },
    checkPrivate: async () => { actions.push("private-list"); return true; },
    fileInput: async () => ({ verified: true }),
    selectVisible: async (_page, url, file, pinnedBytes) => {
      assert.equal(url, editUrl);
      assert.equal(file.mimeType, "image/jpeg");
      assert.deepEqual(pinnedBytes, bytes);
      actions.push("select"); selected = true;
    },
    saveControl: async () => ({ click: async () => { actions.push("private-save"); } }),
    waitForSelection: async () => {
      actions.push("wait-image");
      return pendingPreview ? { kind: "PENDING_PREVIEW_MATCHED" } :
        { kind: "REMOTE_SECOND_IMAGE", pathHash: added.pathHash };
    },
    verifyPendingPreview: async () => {
      previewChecks++;
      actions.push("preview-proof");
      return selected && (previewStable || previewChecks === 1);
    },
    observe: () => { actions.push("observe"); return observer; },
  };
  return { deps, actions, get closed() { return closed; } };
}

test("one explicit flow saves privately only after image and exact-product checks, then reads back", () =>
  withRoot(async ({ root, imagePath }) => {
    const fake = harness();
    const args = { root, profileDir: root, playwrightModulePath: root,
      target, imagePath, imageSha256: sha };
    const result = await runPrivateImageWorkflowOnce(args, fake.deps);
    assert.equal(result.status, "CONFIRMED_PRIVATE_WITH_IMAGE");
    assert.equal(result.stage, "PRIVATE_READBACK_CONFIRMED");
    assert.equal(fake.actions.filter(item => item === "select").length, 1);
    assert.equal(fake.actions.filter(item => item === "private-save").length, 1);
    assert.ok(fake.actions.indexOf("observe") < fake.actions.indexOf("select"));
    assert.ok(fake.actions.indexOf("wait-image") < fake.actions.indexOf("next"));
    assert.ok(fake.actions.indexOf("next") < fake.actions.indexOf("checkpoint"));
    assert.ok(fake.actions.indexOf("checkpoint") < fake.actions.indexOf("private-save"));
    assert.ok(fake.actions.indexOf("ack") < fake.actions.indexOf("reload"));
    assert.equal(fake.closed, true);
    assert.deepEqual(await readPrivateImageWorkflowResult(root, target),
      { status: "CONFIRMED_PRIVATE_WITH_IMAGE", stage: "PRIVATE_READBACK_CONFIRMED",
        observation: [], readbackPrivateWithImage: true });
    assert.equal((await runPrivateImageWorkflowOnce(args, fake.deps)).status,
      "BLOCKED_PREVIOUS_ATTEMPT");
    assert.equal(fake.actions.filter(item => item === "select").length, 1);
  }));

test("a byte-matched data preview permits one private save but not image attribution", () =>
  withRoot(async ({ root, imagePath }) => {
    const fake = harness({ pendingPreview: true, probeAvailable: true });
    const args = { root, profileDir: root, playwrightModulePath: root,
      target, imagePath, imageSha256: sha };
    const result = await runPrivateImageWorkflowOnce(args, fake.deps);
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.stage, "PRIVATE_TWO_IMAGES_ATTRIBUTION_UNVERIFIED");
    assert.equal(result.readbackPrivateWithImage, true);
    assert.equal(fake.actions.filter(item => item === "preview-proof").length, 2);
    assert.equal(fake.actions.filter(item => item === "private-save").length, 1);
    assert.ok(fake.actions.lastIndexOf("preview-proof") < fake.actions.indexOf("private-save"));
    assert.equal(fake.actions.includes("probe-reload"), true);
    assert.equal((await readPrivateImageWorkflowResult(root, target)).stage,
      "PRIVATE_TWO_IMAGES_ATTRIBUTION_UNVERIFIED");
    assert.equal((await runPrivateImageWorkflowOnce(args, fake.deps)).status,
      "BLOCKED_PREVIOUS_ATTEMPT");
    assert.equal(fake.closed, false);
    await result.retainedSession.observer.stop();
    await result.retainedSession.context.close();
  }));

test("a changed pending preview stops before the private save click", () =>
  withRoot(async ({ root, imagePath }) => {
    const fake = harness({ pendingPreview: true, previewStable: false });
    const result = await runPrivateImageWorkflowOnce({ root, profileDir: root,
      playwrightModulePath: root, target, imagePath, imageSha256: sha }, fake.deps);
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.stage, "NEXT_CLICK_UNCERTAIN");
    assert.equal(fake.actions.includes("private-save"), false);
    assert.equal(fake.closed, false);
    await result.retainedSession.observer.stop();
    await result.retainedSession.context.close();
  }));

test("an unacknowledged preview save remains unknown despite private two-image readback", () =>
  withRoot(async ({ root, imagePath }) => {
    const fake = harness({ pendingPreview: true, acknowledged: false,
      probeAvailable: true });
    const result = await runPrivateImageWorkflowOnce({ root, profileDir: root,
      playwrightModulePath: root, target, imagePath, imageSha256: sha }, fake.deps);
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.stage, "SAVE_ACK_UNVERIFIED");
    assert.equal(result.readbackPrivateWithImage, true);
    assert.equal(fake.actions.filter(item => item === "private-save").length, 1);
    assert.equal(fake.actions.includes("reload"), false);
    assert.equal(fake.closed, false);
    await result.retainedSession.observer.stop();
    await result.retainedSession.context.close();
  }));

test("unverified save response retains Chrome and permanently blocks replay", () =>
  withRoot(async ({ root, imagePath }) => {
    const fake = harness({ acknowledged: false });
    const args = { root, profileDir: root, playwrightModulePath: root,
      target, imagePath, imageSha256: sha };
    const result = await runPrivateImageWorkflowOnce(args, fake.deps);
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.stage, "SAVE_ACK_UNVERIFIED");
    assert.equal(fake.closed, false);
    assert.equal(fake.actions.includes("reload"), false,
      "an unacknowledged save never discards the pending edit by navigation");
    assert.equal((await readPrivateImageWorkflowClaim(root, target)).claimed, true);
    assert.equal((await runPrivateImageWorkflowOnce(args, fake.deps)).status,
      "BLOCKED_PREVIOUS_ATTEMPT");
    assert.equal(fake.actions.filter(item => item === "private-save").length, 1);
    assert.equal((await addExistingImageOnce(args, fake.deps)).status, "ALREADY_ATTEMPTED");
    assert.equal((await saveExistingPrivateOnce(args, fake.deps)).status, "ALREADY_ATTEMPTED");
    assert.equal(fake.actions.filter(item => item === "select").length, 1);
    await result.retainedSession.observer.stop();
    await result.retainedSession.context.close();
  }));

test("unverified save probes in a separate tab without discarding the original edit", () =>
  withRoot(async ({ root, imagePath }) => {
    const fake = harness({ acknowledged: false, probeAvailable: true });
    const result = await runPrivateImageWorkflowOnce({ root, profileDir: root,
      playwrightModulePath: root, target, imagePath, imageSha256: sha }, fake.deps);
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.readbackPrivateWithImage, true);
    assert.equal(fake.actions.includes("reload"), false);
    assert.equal(fake.actions.includes("probe-reload"), true);
    assert.equal(fake.actions.includes("probe-close"), true);
    assert.equal(fake.closed, false);
    assert.equal((await readPrivateImageWorkflowResult(root, target)).readbackPrivateWithImage,
      true);
    await result.retainedSession.observer.stop();
    await result.retainedSession.context.close();
  }));

test("a prior old image marker blocks the new flow before opening Shops", () =>
  withRoot(async ({ root, imagePath }) => {
    await claimManualImageOnce(root, target, sha);
    const fake = harness();
    const result = await runPrivateImageWorkflowOnce({ root, profileDir: root,
      playwrightModulePath: root, target, imagePath, imageSha256: sha }, fake.deps);
    assert.equal(result.status, "BLOCKED_PREVIOUS_ATTEMPT");
    assert.deepEqual(fake.actions, []);
  }));

test("expired authentication stops before image or save claims", () =>
  withRoot(async ({ root, imagePath }) => {
    const fake = harness({ auth: true });
    const result = await runPrivateImageWorkflowOnce({ root, profileDir: root,
      playwrightModulePath: root, target, imagePath, imageSha256: sha }, fake.deps);
    assert.equal(result.status, "AUTH_REQUIRED");
    assert.equal(fake.closed, true);
    assert.equal((await readPrivateImageWorkflowClaim(root, target)).claimed, false);
  }));
