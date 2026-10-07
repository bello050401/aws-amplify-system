import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { enqueueGeneralPrivateCreate, claimGeneralPrivateCreateOnce,
  exactGeneralPrivateCreatePack, listGeneralPrivateCreateJobs,
  writeGeneralPrivateCreateResultOnce } from "../src/generalPrivateCreateJob.mjs";
import { diagnoseGeneralPrivateCreateForm } from
  "../src/generalPrivateCreateForm.mjs";
import { readGeneralPrivateCreateRequestJson } from
  "../src/generalPrivateCreateRequest.mjs";

const inventoryId = "98765432-1234-4234-8234-987654321abc";
const pack = () => ({ schemaVersion: 1,
  kind: "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK",
  shopId: "evkhihBFFNn5hukMS9s36H", inventoryId,
  draftId: "12345678-1234-4234-8234-123456789abc",
  draftUpdatedAt: "2026-10-07T10:00:00.000Z", title: "Sofa",
  description: "Known saved description", condition: "NO_NOTABLE_DAMAGE",
  imageRefs: [{ source: "INVENTORY", storageKey: "inventory/sofa.jpg",
    sortOrder: 0, photoAssetId: null }], priceYen: 99999, quantity: 1,
  categoryId: "12345", categoryPath: "家具・インテリア > ソファ・ソファベッド > 2人掛けソファ",
  brandId: null, brandName: null,
  managementCode: `BELLO_${inventoryId.replace(/-/g, "").toUpperCase()}`,
  shipping: { method: "METHOD_TYPE_UNDECIDED", payer: "PAYER_TYPE_SELLER",
    origin: "jp11", duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" },
  status: "PREPARED_NO_SEND" });

test("one immutable generic pack can be queued, claimed once, and retain an uncertain ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "bello-general-private-"));
  try {
    assert.equal((await enqueueGeneralPrivateCreate(root, pack())).status,
      "PREPARED_NO_SEND");
    await enqueueGeneralPrivateCreate(root, pack());
    await assert.rejects(enqueueGeneralPrivateCreate(root,
      { ...pack(), priceYen: 100000 }), /PACK_CHANGED/);
    const claim = await claimGeneralPrivateCreateOnce(root, inventoryId);
    await assert.rejects(claimGeneralPrivateCreateOnce(root, inventoryId),
      /ALREADY_CLAIMED/);
    await assert.rejects(enqueueGeneralPrivateCreate(root, pack()),
      /UNKNOWN_NO_RETRY/);
    await writeGeneralPrivateCreateResultOnce(root, inventoryId, {
      attemptId: claim.attemptId, outcome: "UNKNOWN", listingConfirmed: false,
      observedRemoteId: "observedOnly123", observedDraftId: "draftOnly123",
      reasonCode: "READBACK_UNVERIFIED",
    });
    await assert.rejects(writeGeneralPrivateCreateResultOnce(root, inventoryId, {
      attemptId: claim.attemptId, outcome: "UNKNOWN", listingConfirmed: false,
      observedRemoteId: null, observedDraftId: null,
      reasonCode: "READBACK_UNVERIFIED",
    }), { code: "EEXIST" });
    const rows = await listGeneralPrivateCreateJobs(root);
    assert.deepEqual(rows.map(row => [row.inventoryId, row.outcome,
      row.observedRemoteId]), [[inventoryId, "UNKNOWN", "observedOnly123"]]);
    const saved = JSON.parse(await readFile(join(root, "general-private-create-once",
      `${inventoryId}.result.json`), "utf8"));
    assert.equal(saved.listingConfirmed, false);
  } finally {
    if (dirname(resolve(root)) !== resolve(tmpdir()) ||
        !basename(root).startsWith("bello-general-private-"))
      throw Error("Unexpected temporary test directory");
    await rm(root, { recursive: true, force: true });
  }
});

test("protected tests and changed image identity cannot enter the generic queue", () => {
  assert.equal(exactGeneralPrivateCreatePack({ ...pack(), inventoryId:
    "5b0f3587-cbbb-4c09-ae78-595b2b3e353f" }), null);
  assert.equal(exactGeneralPrivateCreatePack({ ...pack(), imageRefs: [{
    ...pack().imageRefs[0], storageKey: "https://example.invalid/image.jpg" }] }), null);
  assert.equal(exactGeneralPrivateCreatePack({ ...pack(), inventoryId: [inventoryId] }), null);
  assert.equal(exactGeneralPrivateCreatePack({ ...pack(), categoryId: ["12345"] }), null);
  assert.equal(exactGeneralPrivateCreatePack({ ...pack(), brandId: ["12345"],
    brandName: "Brand" }), null);
});

test("each saved Shops field is checked before a final private save", () => {
  const input = pack();
  const view = { name: input.title, description: input.description,
    price: "¥99,999", quantity: "1", sku: input.managementCode,
    condition: "目立った傷や汚れなし",
    category: "カテゴリー 家具・インテリア > ソファ・ソファベッド > 2人掛けソファ",
    shipping: { "shippingMethodType.id": "METHOD_TYPE_UNDECIDED",
      "shippingPayerType.id": "PAYER_TYPE_SELLER",
      "shippingFromState.id": "jp11",
      "shippingDurationType.id": "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" },
    imageCount: 1 };
  assert.equal(diagnoseGeneralPrivateCreateForm(input, view), null);
  assert.equal(diagnoseGeneralPrivateCreateForm(input,
    { ...view, price: "¥100,000" }), "PRICE_MISMATCH");
  assert.equal(diagnoseGeneralPrivateCreateForm(input,
    { ...view, category: "カテゴリー 家具・インテリア > ソファ・ソファベッド" }),
  "CATEGORY_MISMATCH");
  assert.equal(diagnoseGeneralPrivateCreateForm(input,
    { ...view, imageCount: 0 }), "IMAGE_COUNT_MISMATCH");
  const chair = { ...input,
    categoryPath: "家具・インテリア > 椅子・チェア > 椅子" };
  assert.equal(diagnoseGeneralPrivateCreateForm(chair,
    { ...view, category: "カテゴリー 家具・インテリア > 椅子・チェア > 椅子" }), null);
  assert.equal(diagnoseGeneralPrivateCreateForm(chair,
    { ...view, category: "カテゴリー 家具・インテリア > 椅子・チェア > 座椅子" }),
  "CATEGORY_MISMATCH");
  const damaged = { ...input, condition: "DAMAGE" };
  assert.equal(diagnoseGeneralPrivateCreateForm(damaged,
    { ...view, condition: "傷や汚れあり" }), null);
  assert.equal(diagnoseGeneralPrivateCreateForm(damaged,
    { ...view, condition: "やや傷や汚れあり" }), "CONDITION_MISMATCH");
});

test("a Japanese field split across HTTP chunks remains byte exact", async () => {
  const expected = { ...pack(), title: "和箪笥" };
  const bytes = Buffer.from(JSON.stringify(expected), "utf8");
  const split = bytes.indexOf(Buffer.from("和", "utf8")) + 1;
  assert.ok(split > 0);
  const request = async function* () {
    yield bytes.subarray(0, split);
    yield bytes.subarray(split);
  };
  assert.deepEqual(await readGeneralPrivateCreateRequestJson(request()), expected);
  await assert.rejects(readGeneralPrivateCreateRequestJson((async function* () {
    yield Buffer.alloc(65537);
  })()), /BODY_TOO_LARGE/);
});
