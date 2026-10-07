import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recoverPrivateImageOnce } from "../src/privateImageRecovery.mjs";
import { claimPrivateImageWorkflow, claimPrivateImageSaveStage,
  readPrivateImageWorkflowClaim, readPrivateImageWorkflowResult,
  writePrivateImageWorkflowResult } from "../src/privateImageWorkflowAttempt.mjs";
import { readPrivateImageRecoveryClaim, readPrivateImageRecoverySave,
  readPrivateImageRecoveryResult, claimPrivateImageRecovery } from
  "../src/privateImageRecoveryAttempt.mjs";

const requestId = "7ecb7f7837d93390fe5f701abdc62e9acfaf5b35b4b751789c4183a2a376e825";
const target = { shopId: "evkhihBFFNn5hukMS9s36H",
  remoteId: "2JXjWPRVBxjZ2K2vgTGNqy", inventoryCode: "B005757",
  skuCode: "B005757-TEST-20261004-caf445ac6e676343", priceYen: 98000, quantity: 1 };
const editUrl = `https://mercari-shops.com/seller/shops/${target.shopId}/products/${target.remoteId}/edit`;
const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 1, 2, 3, 0xff, 0xd9]);
const imageSha256 = createHash("sha256").update(bytes).digest("hex");
const original = { pathHash: "a".repeat(64), width: 960, height: 960 };
const added = { pathHash: "b".repeat(64), width: 1080, height: 1080 };

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "bello-private-image-recovery-"));
  try {
    const imagePath = join(root, "proof.jpg");
    await writeFile(imagePath, bytes);
    const originalClaim = await claimPrivateImageWorkflow(root, target, imageSha256);
    await writePrivateImageWorkflowResult(root, target, originalClaim.attemptId,
      "UNKNOWN", "FILE_SELECTION_UNCERTAIN");
    return await run({ root, imagePath, originalClaim });
  } finally { await rm(root, { recursive: true, force: true }); }
}

function harness({ initiallyTwo = false, auth = false, imageAppears = true,
  acknowledged = true, becomesTwoBeforeSelection = false } = {}) {
  const actions = [];
  let selected = false;
  let closed = false;
  let imageReads = 0;
  const context = new EventEmitter();
  context.close = async () => { closed = true; context.emit("close"); };
  const page = {
    url: () => auth ? "https://mercari-shops.com/signin/seller" : editUrl,
    goto: async url => { assert.equal(url, editUrl); actions.push("reload"); },
    getByRole: (role, { name }) => {
      assert.equal(role, "button");
      assert.equal(name, "公開設定に進む");
      return { count: async () => 1, isEnabled: async () => true,
        click: async () => { actions.push("next"); } };
    },
  };
  const observer = { checkpoint: () => { actions.push("checkpoint"); return 0; },
    waitForExactPrivateUpdate: async () => {
      actions.push("ack"); return acknowledged;
    }, snapshot: () => [], stop: async () => { actions.push("stop"); return []; } };
  const deps = {
    openSession: async () => {
      actions.push("open");
      return { state: auth ? "AUTH_REQUIRED" : "NAVIGATED_UNVERIFIED",
        context, page };
    },
    readFields: async () => { actions.push("fields"); return { title: "Exact product" }; },
    readImages: async () => {
      actions.push("images");
      imageReads++;
      return initiallyTwo || selected || (becomesTwoBeforeSelection && imageReads >= 3) ?
        [original, added] : [original];
    },
    checkPrivate: async () => { actions.push("private-list"); return true; },
    fileInput: async () => ({ setInputFiles: async file => {
      assert.deepEqual(file.buffer, bytes);
      assert.equal((await readPrivateImageRecoveryClaim(rootForInput, target, requestId)).claimed,
        true, "recovery claim precedes file selection");
      actions.push("select"); selected = true;
    } }),
    saveControl: async () => ({ click: async () => { actions.push("private-save"); } }),
    waitForAddedImage: async () => {
      actions.push("wait-image"); return imageAppears ? added.pathHash : null;
    },
    observe: () => { actions.push("observe"); return observer; },
  };
  let rootForInput = null;
  return { deps, actions, bindRoot: root => { rootForInput = root; },
    get closed() { return closed; } };
}

function args(root, imagePath, readbackObserved = "PRIVATE_ONE_IMAGE_OBSERVED") {
  return { root, profileDir: root, playwrightModulePath: root,
    requestId, target, imagePath, imageSha256, readbackObserved };
}

test("one recovery claim precedes upload and private save only follows two exact images", () =>
  withRoot(async ({ root, imagePath, originalClaim }) => {
    const fake = harness(); fake.bindRoot(root);
    const result = await recoverPrivateImageOnce(args(root, imagePath), fake.deps);
    assert.equal(result.status, "CONFIRMED_PRIVATE_WITH_IMAGE");
    assert.equal(result.stage, "PRIVATE_READBACK_CONFIRMED");
    assert.ok(fake.actions.indexOf("select") < fake.actions.indexOf("wait-image"));
    assert.ok(fake.actions.indexOf("wait-image") < fake.actions.indexOf("next"));
    assert.ok(fake.actions.indexOf("next") < fake.actions.indexOf("private-save"));
    assert.equal(fake.actions.filter(item => item === "select").length, 1);
    assert.equal(fake.actions.filter(item => item === "private-save").length, 1);
    assert.equal((await readPrivateImageRecoverySave(root, target, requestId)).claimed, true);
    assert.deepEqual(await readPrivateImageRecoveryResult(root, target, requestId),
      { status: "CONFIRMED_PRIVATE_WITH_IMAGE", stage: "PRIVATE_READBACK_CONFIRMED",
        readbackPrivateWithImage: true });
    assert.equal((await readPrivateImageWorkflowClaim(root, target)).attemptId,
      originalClaim.attemptId);
    assert.equal((await readPrivateImageWorkflowResult(root, target)).stage,
      "FILE_SELECTION_UNCERTAIN");
    assert.equal((await recoverPrivateImageOnce(args(root, imagePath), fake.deps)).status,
      "BLOCKED_PREVIOUS_ATTEMPT");
    assert.equal(fake.actions.filter(item => item === "select").length, 1);
    assert.equal(fake.closed, true);
  }));

test("unknown second image stops before save, retains Chrome and cannot be retried", () =>
  withRoot(async ({ root, imagePath }) => {
    const fake = harness({ imageAppears: false }); fake.bindRoot(root);
    const result = await recoverPrivateImageOnce(args(root, imagePath), fake.deps);
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.stage, "FILE_SELECTION_UNCERTAIN");
    assert.equal(fake.actions.includes("private-save"), false);
    assert.equal((await readPrivateImageRecoverySave(root, target, requestId)).claimed, false);
    assert.equal(fake.closed, false);
    assert.equal((await recoverPrivateImageOnce(args(root, imagePath), fake.deps)).status,
      "BLOCKED_PREVIOUS_ATTEMPT");
    await result.retainedSession.observer.stop();
    await result.retainedSession.context.close();
  }));

test("a second image appearing after the recovery claim blocks file selection", () =>
  withRoot(async ({ root, imagePath }) => {
    const fake = harness({ becomesTwoBeforeSelection: true }); fake.bindRoot(root);
    const result = await recoverPrivateImageOnce(args(root, imagePath), fake.deps);
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.stage, "IMAGE_CLAIMED");
    assert.equal(fake.actions.includes("select"), false);
    assert.equal(fake.actions.includes("private-save"), false);
    assert.equal((await readPrivateImageRecoveryClaim(root, target, requestId)).claimed, true);
    assert.equal((await recoverPrivateImageOnce(args(root, imagePath), fake.deps)).status,
      "BLOCKED_PREVIOUS_ATTEMPT");
    await result.retainedSession.observer.stop();
    await result.retainedSession.context.close();
  }));

test("two images, no independent one-image result, auth and old save all block upload", () =>
  withRoot(async ({ root, imagePath, originalClaim }) => {
    const two = harness({ initiallyTwo: true }); two.bindRoot(root);
    assert.equal((await recoverPrivateImageOnce(args(root, imagePath), two.deps)).status,
      "PREFLIGHT_BLOCKED");
    assert.equal(two.actions.includes("select"), false);
    assert.equal((await readPrivateImageRecoveryClaim(root, target, requestId)).claimed, false);
    const refused = harness(); refused.bindRoot(root);
    assert.equal((await recoverPrivateImageOnce(args(root, imagePath,
      "PRIVATE_TWO_IMAGES_UNATTRIBUTED"), refused.deps)).status, "PREFLIGHT_BLOCKED");
    assert.deepEqual(refused.actions, []);
    await assert.rejects(recoverPrivateImageOnce({ ...args(root, imagePath),
      target: { ...target, inventoryCode: "B005795" } }, refused.deps));
    assert.deepEqual(refused.actions, []);
    const auth = harness({ auth: true }); auth.bindRoot(root);
    assert.equal((await recoverPrivateImageOnce(args(root, imagePath), auth.deps)).status,
      "AUTH_REQUIRED");
    assert.equal(auth.actions.includes("select"), false);
    await claimPrivateImageSaveStage(root, target, originalClaim.attemptId);
    const priorSave = harness(); priorSave.bindRoot(root);
    assert.equal((await recoverPrivateImageOnce(args(root, imagePath), priorSave.deps)).status,
      "BLOCKED_PREVIOUS_ATTEMPT");
    assert.deepEqual(priorSave.actions, []);
  }));

test("unacknowledged private save is unknown and permanently blocks a second recovery", () =>
  withRoot(async ({ root, imagePath }) => {
    const fake = harness({ acknowledged: false }); fake.bindRoot(root);
    const result = await recoverPrivateImageOnce(args(root, imagePath), fake.deps);
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.stage, "SAVE_ACK_UNVERIFIED");
    assert.equal(fake.actions.filter(item => item === "private-save").length, 1);
    assert.equal(fake.closed, false);
    assert.equal((await recoverPrivateImageOnce(args(root, imagePath), fake.deps)).status,
      "BLOCKED_PREVIOUS_ATTEMPT");
    await result.retainedSession.observer.stop();
    await result.retainedSession.context.close();
  }));

test("recovery marker wins a race and a stray save marker blocks before opening Chrome", () =>
  withRoot(async ({ root, imagePath, originalClaim }) => {
    const outcomes = await Promise.allSettled([
      claimPrivateImageRecovery(root, target, requestId,
        originalClaim.attemptId, imageSha256),
      claimPrivateImageRecovery(root, target, requestId,
        originalClaim.attemptId, imageSha256),
    ]);
    assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(item => item.status === "rejected").length, 1);
    const fake = harness(); fake.bindRoot(root);
    assert.equal((await recoverPrivateImageOnce(args(root, imagePath), fake.deps)).status,
      "BLOCKED_PREVIOUS_ATTEMPT");
    assert.deepEqual(fake.actions, []);
  }));

test("a stray recovery save file blocks any upload", () =>
  withRoot(async ({ root, imagePath }) => {
    const dir = join(root, "private-image-recovery-once");
    await mkdir(dir);
    await writeFile(join(dir, `${target.shopId}-${target.remoteId}.save.json`), "{}\n");
    const fake = harness(); fake.bindRoot(root);
    assert.equal((await recoverPrivateImageOnce(args(root, imagePath), fake.deps)).status,
      "BLOCKED_PREVIOUS_ATTEMPT");
    assert.deepEqual(fake.actions, []);
  }));
