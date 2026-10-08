import test from "node:test";
import assert from "node:assert/strict";
import { buildWebHttpDraftJob, reserveWebHttpDraftJob } from "./webHttpDraftJob.ts";

const inventoryId = "2c53f36a-7a60-4e34-801d-8abc24f6cfc0";
const shipping = { method: "METHOD_TYPE_UNDECIDED", payer: "PAYER_TYPE_SELLER",
  origin: "jp11", duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" };
const imageRefs = [{ source: "INVENTORY", storageKey: "inventory/b005396/front.jpg",
  sortOrder: 0, photoAssetId: null }];
const pack = { schemaVersion: 1, kind: "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK",
  shopId: "evkhihBFFNn5hukMS9s36H", inventoryId,
  draftId: "0d76fb56-41f8-4dd3-ae18-a660a5e97ae1",
  draftUpdatedAt: "2026-10-08T01:02:03.000Z", title: "Fixture sofa",
  description: "Fixture description", condition: "NO_NOTABLE_DAMAGE",
  imageRefs, priceYen: 99999, quantity: 1,
  categoryId: "furniture_sofa", categoryPath: "家具・インテリア > ソファ",
  brandId: null, brandName: null,
  managementCode: "BELLO_2C53F36A7A604E34801D8ABC24F6CFC0",
  shipping, status: "PREPARED_NO_SEND" };
const evidence = { sourceInventoryCode: "B005396", sourcePriceYen: 50000,
  sourceQuantity: 1, sourceShippingMethod: "KAZAI", selectedQuantity: 1,
  selectedCategoryId: pack.categoryId, selectedCategoryPath: pack.categoryPath,
  categoryEvidence: "ADMIN_SELECTED_MASTER", shopsShipping: shipping,
  imageCount: 1, imageEvidence: "SAVED_REFERENCES_ONLY",
  shippingReviewRequired: true, status: "REVIEW_REQUIRED_NO_SEND" };

test("Web HTTP job freezes one no-send snapshot without a PC or Shops dependency", () => {
  const job = buildWebHttpDraftJob(pack, evidence, "admin@example.com",
    "2026-10-08T01:02:04.000Z");
  assert.match(job.requestId, /^[a-f0-9]{64}$/);
  assert.equal(job.status, "AWAITING_HTTP_AUTH_AND_CREATE_CONTRACT");
  assert.equal(JSON.parse(job.snapshotJson).transport, "BELLO_SERVER_HTTP");
  assert.equal(JSON.parse(job.snapshotJson).shippingReviewed, true);
  assert.equal(JSON.parse(job.snapshotJson).pack.managementCode, pack.managementCode);
  assert.equal(Object.hasOwn(job, "sendUrl"), false);
});

test("same Web request is idempotent; changed BELLO content is a conflict", async () => {
  let stored = null;
  let creates = 0;
  const repo = { getJob: async () => stored, createJob: async job => {
    creates++;
    if (stored) throw Error("duplicate");
    stored = job;
  } };
  const first = await reserveWebHttpDraftJob(pack, evidence, "admin@example.com", repo);
  const repeat = await reserveWebHttpDraftJob(pack, evidence, "admin@example.com", repo);
  assert.deepEqual(repeat, first);
  assert.equal(creates, 1);
  await assert.rejects(() => reserveWebHttpDraftJob({ ...pack,
    description: "Changed description" }, evidence, "admin@example.com", repo),
  { code: "JOB_CONFLICT" });
});

test("concurrent clicks converge after conditional create failure", async () => {
  let stored = null;
  const repo = { getJob: async () => stored, createJob: async job => {
    if (stored) throw Error("duplicate");
    stored = job;
  } };
  const results = await Promise.all([
    reserveWebHttpDraftJob(pack, evidence, "admin@example.com", repo),
    reserveWebHttpDraftJob(pack, evidence, "admin@example.com", repo),
  ]);
  assert.deepEqual(results[0], results[1]);
});

test("Web job rejects unreviewed shipping and wrong inventory", () => {
  assert.throws(() => buildWebHttpDraftJob(pack,
    { ...evidence, shippingReviewRequired: false }, "admin@example.com"),
  { code: "INVALID_INPUT" });
  assert.throws(() => buildWebHttpDraftJob({ ...pack, inventoryId: "other" },
    evidence, "admin@example.com"), { code: "INVALID_INPUT" });
});
