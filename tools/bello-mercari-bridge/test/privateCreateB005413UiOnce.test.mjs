import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildPrivateCreatePreparation, PRIVATE_CREATE_SHOP_ID } from
  "../src/privateCreatePreparation.mjs";
import { B005413_CATEGORY_PATH, exactB005413CategoryReadback,
  exactB005413PrivateCreateJob, exactNewDraftId,
  exactPrivateCreateResponse, runB005413PrivateCreateUiOnce } from
  "../src/privateCreateB005413UiOnce.mjs";

const snapshot = JSON.parse(await readFile(fileURLToPath(
  new URL("./fixtures/b005413-snapshot.json", import.meta.url)), "utf8"));
const prepared = buildPrivateCreatePreparation(snapshot);
const createUrl = `https://mercari-shops.com/seller/shops/${PRIVATE_CREATE_SHOP_ID}/products/create`;
const protectedIds = ["2JToDtSgGowzUwnwe9hgHU", "2JWp7EJx6aqKfn6dTXc5Q9",
  "2JXmhh6wZFnKBnhwk8zV9c", "2JXpBXSRGQW6ENrW57cri2"];

test("B005413 uses the chair category confirmed in the seller UI", () => {
  assert.deepEqual([...B005413_CATEGORY_PATH],
    ["家具・インテリア", "椅子・チェア", "椅子"]);
  assert.equal(exactB005413CategoryReadback("椅子",
    "カテゴリー家具・インテリア >椅子・チェア >椅子"), true);
  assert.equal(exactB005413CategoryReadback("椅子・チェア",
    "カテゴリー家具・インテリア >椅子・チェア"), false);
  assert.equal(exactB005413CategoryReadback("椅子",
    "カテゴリー家具・インテリア >椅子・チェア"), false);
  assert.equal(exactB005413CategoryReadback("座椅子",
    "カテゴリー家具・インテリア >椅子・チェア >座椅子"), false);
  assert.equal(exactB005413CategoryReadback("椅子",
    "カテゴリー家具・インテリア >ソファ・ソファベッド >椅子"), false);
  assert.equal(exactB005413CategoryReadback("椅子",
    "カテゴリー家具・インテリア >椅子・チェア >椅子 >その他"), false);
});

test("only the pinned B005413 job can enter its private-create executor", () => {
  assert.ok(exactB005413PrivateCreateJob(prepared));
  assert.equal(exactB005413PrivateCreateJob({ ...prepared,
    snapshotFingerprint: "0".repeat(64) }), null);
  assert.equal(exactB005413PrivateCreateJob({ ...prepared,
    snapshotJson: JSON.stringify({ ...snapshot, testPriceYen: 30000 }) }), null);
  assert.equal(exactB005413PrivateCreateJob({ ...prepared,
    snapshotJson: JSON.stringify({ ...snapshot,
      doNotModifyProductId: protectedIds[0] }) }), null);
  assert.equal(exactB005413PrivateCreateJob({ ...prepared,
    inventoryId: "dd273c1e-9b2a-4013-acc6-c445a481fab8" }), null);
});

test("B005413 will not reuse an existing public item or unattributed draft", () => {
  assert.deepEqual(exactNewDraftId(createUrl), { valid: true, id: null });
  assert.deepEqual(exactNewDraftId(`${createUrl}?productDraftId=fresh413`),
    { valid: true, id: "fresh413" });
  for (const id of protectedIds) {
    assert.equal(exactNewDraftId(`${createUrl}?productDraftId=${id}`).valid, false);
    const event = { httpStatus: 200, resultId: id, resultState: "UNOPENED" };
    assert.equal(exactPrivateCreateResponse({ captureStatus: "UNVERIFIED",
      events: [event], draftIds: [] }), null);
    assert.equal(exactPrivateCreateResponse({ captureStatus: "UNVERIFIED",
      events: [{ ...event, resultId: "fresh413" }], draftIds: [{ id }] }), null);
  }
  assert.equal(exactPrivateCreateResponse({ captureStatus: "UNVERIFIED",
    events: [{ httpStatus: 200, resultId: "fresh413",
      resultState: "UNOPENED" }], draftIds: [] }), "fresh413");
});

test("authentication uncertainty stays no-click and writes only the B005413 result slot", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-b005413-ui-"));
  let recorded = 0;
  const session = { state: "AUTH_REQUIRED",
    page: { url: () => "https://mercari-shops.com/signin/seller" },
    claim: { attemptId: "b005413-attempt" },
    observer: { stop: async () => ({ captureStatus: "UNVERIFIED",
      events: [], draftIds: [] }) } };
  try {
    const result = await runB005413PrivateCreateUiOnce({ root,
      profileDir: resolve("profile"), playwrightModulePath: resolve("playwright"),
      imagePath: resolve("image.jpg") }, {
      preflight: async () => ({ job: prepared, snapshot,
        imageBytes: Buffer.from("unused"), image: {} }),
      openSession: async ({ inventoryId }) => {
        assert.equal(inventoryId, snapshot.inventoryId);
        return session;
      },
      recordObservation: async () => { recorded += 1; },
    });
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.retainedSession, session);
    assert.equal(recorded, 1);
    const saved = JSON.parse(await readFile(join(root,
      "future-private-create-ui-once",
      `${PRIVATE_CREATE_SHOP_ID}-B005413-once.result.json`), "utf8"));
    assert.deepEqual(saved.attempted, { createClick: false,
      fieldsOrFile: false, privateSaveClick: false });
    assert.equal(saved.listingConfirmed, false);
    await assert.rejects(readFile(join(root, "future-private-create-ui-once",
      `${PRIVATE_CREATE_SHOP_ID}-once.result.json`)), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
