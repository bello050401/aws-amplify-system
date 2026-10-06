import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindAccount } from "../src/queue.mjs";
import { buildPrivateCreatePreparation, preparePrivateCreateOnce,
  PRIVATE_CREATE_SHOP_ID } from "../src/privateCreatePreparation.mjs";

const inventoryId = "bd4850de-9156-4890-a821-cae75da5c8f7";
const runFile = promisify(execFile);
const input = { schemaVersion: 1, kind: "BELLO_PRIVATE_CREATE_PREPARATION",
  shopId: PRIVATE_CREATE_SHOP_ID, inventoryId, inventoryCode: "B009999",
  draftId: "e5da4384-16c9-4e63-bc2b-19280856b7de",
  draftUpdatedAt: "2026-10-06T12:00:00.000Z", title: "Reviewed item",
  description: "Reviewed condition and shipping description", priceYen: 45000,
  quantity: 1, condition: "NO_NOTABLE_DAMAGE", shippingMethod: "KAZAI",
  imageRefs: [{ source: "INVENTORY", storageKey: "inventory/photo.jpg",
    sortOrder: 0, photoAssetId: null }] };
const privateTestId = "dd273c1e-9b2a-4013-acc6-c445a481fab8";
const privateTest = {
  schemaVersion: 2, kind: "BELLO_SEPARATE_PRIVATE_TEST_PREPARATION",
  shopId: PRIVATE_CREATE_SHOP_ID, inventoryId: privateTestId,
  sourceInventoryCode: "B005659", sourcePriceYen: 54200,
  testManagementCode: "TEST_B005659_E51E4F6B7B86DD150546",
  testPriceYen: 99999, visibility: "PRIVATE_ONLY",
  doNotModifyProductId: "2JWp7EJx6aqKfn6dTXc5Q9",
  contentEvidence: "BELLO_SAVED_DRAFT_ONLY",
  draftId: input.draftId, draftUpdatedAt: input.draftUpdatedAt,
  title: input.title, description: input.description, quantity: 1,
  condition: "NO_NOTABLE_DAMAGE", shippingMethod: "KAZAI",
  imageRefs: input.imageRefs,
};

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "bello-private-create-preparation-"));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("complete BELLO data queues one no-send preparation and the same request is idempotent", () =>
  withRoot(async root => {
    const first = await preparePrivateCreateOnce(root, input);
    const second = await preparePrivateCreateOnce(root, input);
    assert.deepEqual(second, first);
    assert.equal(first.status, "PREPARED_NO_SEND");
    assert.equal(first.remoteId, null);
    assert.equal(first.listingConfirmed, false);
    assert.equal(first.requestId.length, 64);
    const stored = JSON.parse(await readFile(join(root, "private-create-prepared",
      `${inventoryId}.json`), "utf8"));
    assert.deepEqual(stored, first);
    assert.equal(JSON.stringify(stored).includes("http"), false);
  }));

test("changed draft or price cannot overwrite a prepared inventory", () =>
  withRoot(async root => {
    const first = await preparePrivateCreateOnce(root, input);
    await assert.rejects(preparePrivateCreateOnce(root,
      { ...input, priceYen: 46000 }), /differs/);
    const stored = JSON.parse(await readFile(join(root, "private-create-prepared",
      `${inventoryId}.json`), "utf8"));
    assert.deepEqual(stored, first);
  }));

test("B005659's separate private test pins source, target and existing product without sending", () =>
  withRoot(async root => {
    const job = await preparePrivateCreateOnce(root, privateTest);
    const snapshot = JSON.parse(job.snapshotJson);
    assert.equal(job.operation, "PREPARE_SEPARATE_PRIVATE_TEST_NO_SEND");
    assert.equal(job.status, "PREPARED_NO_SEND");
    assert.equal(job.remoteId, null);
    assert.equal(job.listingConfirmed, false);
    assert.equal(snapshot.sourceInventoryCode, "B005659");
    assert.equal(snapshot.sourcePriceYen, 54200);
    assert.equal(snapshot.testManagementCode, privateTest.testManagementCode);
    assert.equal(snapshot.testPriceYen, 99999);
    assert.equal(snapshot.visibility, "PRIVATE_ONLY");
    assert.equal(snapshot.doNotModifyProductId, privateTest.doNotModifyProductId);
    await assert.rejects(preparePrivateCreateOnce(root, privateTest), /already claimed/);
    const stored = JSON.parse(await readFile(join(root, "private-create-prepared",
      `${privateTestId}.json`), "utf8"));
    assert.deepEqual(stored, job);
  }));

test("private test overrides cannot change inventory, price, code, visibility or public target", () => {
  for (const candidate of [
    { ...privateTest, inventoryId },
    { ...privateTest, sourceInventoryCode: "B005757" },
    { ...privateTest, sourcePriceYen: 99999 },
    { ...privateTest, testManagementCode: "B005659" },
    { ...privateTest, testPriceYen: 54200 },
    { ...privateTest, visibility: "PUBLIC" },
    { ...privateTest, doNotModifyProductId: "other-product" },
    { ...privateTest, remoteId: privateTest.doNotModifyProductId },
    { ...privateTest, quantity: 2 },
    { ...privateTest, condition: "NEW" },
    { ...input, inventoryId: privateTestId, inventoryCode: "B005659" },
    { ...input, inventoryCode: "B005659" },
  ]) assert.throws(() => buildPrivateCreatePreparation(candidate));
});

test("v1 cannot claim B005659 or its reserved test code with case variants", () =>
  withRoot(async root => {
    for (const candidate of [
      { ...input, inventoryId: privateTestId.toUpperCase(),
        inventoryCode: "b005659", priceYen: 300 },
      { ...input, inventoryId: privateTestId.replace("dd", "Dd"),
        inventoryCode: "B005659", priceYen: 300 },
      { ...input, inventoryCode: privateTest.testManagementCode,
        priceYen: 300 },
      { ...input, inventoryCode: privateTest.testManagementCode.toLowerCase(),
        priceYen: 300 },
    ]) {
      assert.throws(() => buildPrivateCreatePreparation(candidate));
      await assert.rejects(preparePrivateCreateOnce(root, candidate));
      await assert.rejects(readFile(join(root, "private-create-prepared",
        `${candidate.inventoryId}.json`), "utf8"), { code: "ENOENT" });
    }
  }));

test("array IDs cannot occupy B005659's one-time preparation slot", () =>
  withRoot(async root => {
    const disguised = { ...input, inventoryId: [privateTestId],
      inventoryCode: "B009999", priceYen: 300 };
    assert.throws(() => buildPrivateCreatePreparation(disguised));
    await assert.rejects(preparePrivateCreateOnce(root, disguised));
    await assert.rejects(readFile(join(root, "private-create-prepared",
      `${privateTestId}.json`), "utf8"), { code: "ENOENT" });
    const valid = await preparePrivateCreateOnce(root, privateTest);
    assert.equal(valid.operation, "PREPARE_SEPARATE_PRIVATE_TEST_NO_SEND");
    assert.equal(valid.inventoryId, privateTestId);
  }));

test("UUID and timestamp snapshot fields require strings before parsing", () => {
  for (const candidate of [
    { ...input, inventoryId: [inventoryId] },
    { ...input, draftId: [input.draftId] },
    { ...input, draftUpdatedAt: [input.draftUpdatedAt] },
    { ...input, imageRefs: [{ ...input.imageRefs[0], source: "PHOTO_ASSET",
      photoAssetId: [input.draftId] }] },
  ]) assert.throws(() => buildPrivateCreatePreparation(candidate));
});

test("Amplify timestamps with a timezone offset remain valid snapshots", () => {
  const job = buildPrivateCreatePreparation({ ...input,
    draftUpdatedAt: "2026-10-06T21:00:00+09:00" });
  assert.equal(job.status, "PREPARED_NO_SEND");
});

test("simultaneous preparation converges on one inventory record", () =>
  withRoot(async root => {
    const [first, second] = await Promise.all([
      preparePrivateCreateOnce(root, input), preparePrivateCreateOnce(root, input),
    ]);
    assert.deepEqual(second, first);
  }));

test("incomplete data, arbitrary URLs and remote draft IDs stop before queue", () =>
  withRoot(async root => {
    for (const candidate of [
      { ...input, description: "" }, { ...input, priceYen: 0 },
      { ...input, imageRefs: [...input.imageRefs, { ...input.imageRefs[0], sortOrder: 1 }] },
      { ...input, imageRefs: [{ ...input.imageRefs[0], storageKey: "https://example.test/photo" }] },
      { ...input, remoteId: "existing-product" },
      { ...input, productDraftId: "2JXmhh6wZFnKBnhwk8zV9c" },
    ]) assert.throws(() => buildPrivateCreatePreparation(candidate));
    await assert.rejects(readFile(join(root, "private-create-prepared",
      `${inventoryId}.json`), "utf8"), { code: "ENOENT" });
  }));

test("another bound Shops account blocks preparation", () =>
  withRoot(async root => {
    await bindAccount(root, "other-shop");
    await assert.rejects(preparePrivateCreateOnce(root, input), /another account/);
  }));

test("PC CLI imports the BELLO file as a no-send preparation only", () =>
  withRoot(async root => {
    const source = join(root, "bello-preparation.json");
    await writeFile(source, JSON.stringify(input), "utf8");
    const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
    const { stdout } = await runFile(process.execPath,
      [cli, "prepare-private-create-no-send", "--root", root, "--input", source]);
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.status, "PREPARED_NO_SEND");
    assert.equal(receipt.listingConfirmed, false);
    assert.equal(receipt.requestId.length, 64);
  }));

test("malformed BELLO file never exposes its contents or creates a preparation", () =>
  withRoot(async root => {
    const source = join(root, "malformed-preparation.json");
    const secret = "SYNTHETIC_SECRET_DO_NOT_PRINT_1749";
    await writeFile(source, `{\"description\":\"${secret}\",`, "utf8");
    const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
    await assert.rejects(runFile(process.execPath,
      [cli, "prepare-private-create-no-send", "--root", root, "--input", source]),
    error => {
      assert.equal(error.stdout, "");
      assert.equal(error.stderr.trim(),
        "BELLO Mercari bridge: BELLO_PREPARATION_FILE_INVALID");
      assert.equal(error.stderr.includes(secret), false);
      assert.equal(error.stderr.includes(source), false);
      return true;
    });
    await assert.rejects(readFile(join(root, "private-create-prepared",
      `${inventoryId}.json`), "utf8"), { code: "ENOENT" });
  }));
