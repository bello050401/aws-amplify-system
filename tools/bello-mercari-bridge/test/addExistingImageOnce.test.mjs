import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { addExistingImageOnce, readExistingUploadedImages } from "../src/addExistingImageOnce.mjs";
import { claimManualImageOnce, readManualImageClaim, readManualImageOutcome } from "../src/manualImageAttempt.mjs";

const target = { shopId: "shop1", remoteId: "existing1", inventoryCode: "B005795",
  priceYen: 90000, quantity: 0 };
const editUrl = "https://mercari-shops.com/seller/shops/shop1/products/existing1/edit";
const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 1, 2, 3, 0xff, 0xd9]);
const imageSha256 = createHash("sha256").update(imageBytes).digest("hex");
const original = { pathHash: "a".repeat(64), width: 960, height: 960 };

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "bello-image-once-"));
  try {
    const imagePath = join(root, "selected.jpg");
    await writeFile(imagePath, imageBytes);
    return await run({ root, imagePath });
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + "\\"));
    await rm(root, { recursive: true, force: true });
  }
}

function harness(root, imagePath, { privateBefore = true, inputChanges = false,
  imageChanges = false, selectThrows = false, fileChangesAfterRead = false } = {}) {
  const actions = [];
  let closed = false;
  let readCount = 0;
  let inputChecks = 0;
  let imageReads = 0;
  const context = new EventEmitter();
  context.close = async () => { closed = true; context.emit("close"); };
  const page = { url: () => editUrl };
  const input = { setInputFiles: async file => {
    assert.match(file.name, /^B005795-[a-f0-9]{16}\.jpg$/);
    assert.equal(file.mimeType, "image/jpeg");
    assert.deepEqual(file.buffer, imageBytes, "selected bytes remain pinned even if the local file changes");
    assert.equal((await readManualImageClaim(root, target, imageSha256)).claimed, true,
      "the permanent marker is written before file selection");
    assert.ok(actions.includes("observe"), "traffic observation starts before selection");
    actions.push("select");
    if (selectThrows) throw Error("selection outcome uncertain");
  } };
  const deps = {
    openSession: async () => ({ state: "NAVIGATED_UNVERIFIED", page, context }),
    readFields: async () => { readCount++; return { title: "Exact private product" }; },
    checkPrivate: async () => {
      if (fileChangesAfterRead) await writeFile(imagePath, Buffer.from("changed after initial validation"));
      return privateBefore;
    },
    readImages: async () => {
      imageReads++;
      if (imageChanges && imageReads === 2) return [{ ...original, pathHash: "b".repeat(64) }];
      return imageReads >= 4 && actions.includes("select") && !selectThrows ?
        [original, { pathHash: "c".repeat(64), width: 1080, height: 1080 }] : [original];
    },
    fileInput: async () => {
      inputChecks++;
      return inputChanges && inputChecks >= 2 ? null : input;
    },
    observe: () => { actions.push("observe"); return { snapshot: () => [], stop: async () => [] }; },
  };
  return { deps, actions, get closed() { return closed; }, get readCount() { return readCount; } };
}

test("one image selection is claimed and observed before the only file-input call", () => withRoot(async ({ root, imagePath }) => {
  const fake = harness(root, imagePath);
  const args = { root, profileDir: root, playwrightModulePath: root, target, imagePath, imageSha256 };
  const result = await addExistingImageOnce(args, fake.deps);
  assert.equal(result.status, "UNKNOWN", "an image shown in the UI is not a confirmed product save");
  assert.equal(result.diagnostic, "ADDED_IMAGE_UI_OBSERVED");
  assert.deepEqual(fake.actions, ["observe", "select"]);
  assert.equal(fake.closed, false, "the browser remains open for upload observation");
  assert.equal((await readManualImageOutcome(root, target, imageSha256)).outcome, "UNKNOWN");
  assert.equal((await addExistingImageOnce(args, fake.deps)).status, "ALREADY_ATTEMPTED");
  assert.deepEqual(fake.actions, ["observe", "select"]);
}));

test("private or original-image mismatch stops without claiming or selecting", () => withRoot(async ({ root, imagePath }) => {
  for (const options of [{ privateBefore: false }, { imageChanges: true }]) {
    const fake = harness(root, imagePath, options);
    const result = await addExistingImageOnce({ root, profileDir: root, playwrightModulePath: root,
      target, imagePath, imageSha256 }, fake.deps);
    assert.equal(result.status, "PREFLIGHT_BLOCKED");
    assert.deepEqual(fake.actions, []);
    assert.equal(fake.closed, true);
    assert.equal((await readManualImageClaim(root, target, imageSha256)).claimed, false);
  }
}));

test("a changed file input after claim remains permanently blocked", () => withRoot(async ({ root, imagePath }) => {
  const fake = harness(root, imagePath, { inputChanges: true });
  const args = { root, profileDir: root, playwrightModulePath: root, target, imagePath, imageSha256 };
  const result = await addExistingImageOnce(args, fake.deps);
  assert.equal(result.status, "BLOCKED_BEFORE_SELECT");
  assert.equal(result.diagnostic, "FILE_INPUT_CHECK");
  assert.deepEqual(fake.actions, ["observe"]);
  assert.equal((await readManualImageClaim(root, target, imageSha256)).claimed, true);
  assert.equal((await addExistingImageOnce(args, fake.deps)).status, "ALREADY_ATTEMPTED");
}));

test("a thrown file-input call is uncertain and cannot be repeated", () => withRoot(async ({ root, imagePath }) => {
  const fake = harness(root, imagePath, { selectThrows: true });
  const args = { root, profileDir: root, playwrightModulePath: root, target, imagePath, imageSha256 };
  const result = await addExistingImageOnce(args, fake.deps);
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.diagnostic, "FILE_SELECT_UNCERTAIN");
  assert.deepEqual(fake.actions, ["observe", "select"]);
  assert.equal((await addExistingImageOnce(args, fake.deps)).status, "ALREADY_ATTEMPTED");
}));

test("the selected bytes stay pinned if the local file changes during preflight", () => withRoot(async ({ root, imagePath }) => {
  const fake = harness(root, imagePath, { fileChangesAfterRead: true });
  const result = await addExistingImageOnce({ root, profileDir: root, playwrightModulePath: root,
    target, imagePath, imageSha256 }, fake.deps);
  assert.equal(result.status, "UNKNOWN");
  assert.deepEqual(fake.actions, ["observe", "select"]);
}));

test("changed local image bytes are rejected before opening Shops or claiming", () => withRoot(async ({ root, imagePath }) => {
  await writeFile(imagePath, Buffer.from("wrong file"));
  const fake = harness(root, imagePath);
  await assert.rejects(addExistingImageOnce({ root, profileDir: root, playwrightModulePath: root,
    target, imagePath, imageSha256 }, fake.deps));
  assert.equal(fake.readCount, 0);
  assert.equal((await readManualImageClaim(root, target, imageSha256)).claimed, false);
}));

test("image-read helper hashes paths and discards signed query strings", async () => {
  const page = { url: () => editUrl, locator: () => ({ evaluateAll: async () => [
    { pathname: "/asset/original.jpg", width: 960, height: 960 },
  ] }) };
  const images = await readExistingUploadedImages(page, editUrl);
  assert.equal(images.length, 1);
  assert.equal(images[0].pathHash.length, 64);
  assert.equal(JSON.stringify(images).includes("/asset/original.jpg"), false);
  assert.equal(images[0].width, 960);
});

test("one durable image marker wins a race and blocks a changed image", () => withRoot(async ({ root }) => {
  const claims = await Promise.allSettled([
    claimManualImageOnce(root, target, imageSha256),
    claimManualImageOnce(root, target, imageSha256),
  ]);
  assert.equal(claims.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(claims.filter(item => item.status === "rejected" && item.reason?.code === "EEXIST").length, 1);
  assert.equal((await readManualImageClaim(root, target, "f".repeat(64))).claimed, true);
  assert.equal((await readManualImageClaim(root, target, "f".repeat(64))).valid, false);
}));
