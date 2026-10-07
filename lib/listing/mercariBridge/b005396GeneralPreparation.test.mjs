import test from "node:test";
import assert from "node:assert/strict";
import { B005396_INVENTORY_ID, inspectB005396GeneralPreparation,
  runB005396GeneralPreparation } from
  "./b005396GeneralPreparation.ts";

const imageRefs = [{ source: "INVENTORY", storageKey: "inventory/b005396/front.jpg",
  sortOrder: 0, photoAssetId: null }];
const source = { schemaVersion: 1, kind: "BELLO_PRIVATE_CREATE_PREPARATION",
  shopId: "evkhihBFFNn5hukMS9s36H", inventoryId: B005396_INVENTORY_ID,
  inventoryCode: "B005396", draftId: "0d76fb56-41f8-4dd3-ae18-a660a5e97ae1",
  draftUpdatedAt: "2026-10-08T01:02:03.000Z", title: "Fixture sofa",
  description: "Fixture description", condition: "NO_NOTABLE_DAMAGE",
  quantity: 1, priceYen: 50000, shippingMethod: "KAZAI", imageRefs };
const pack = { schemaVersion: 1, kind: "BELLO_MERCARI_SHOPS_MANUAL_LISTING_PACK",
  shopId: source.shopId, inventoryId: source.inventoryId,
  draftId: source.draftId, draftUpdatedAt: source.draftUpdatedAt,
  title: source.title, description: source.description,
  condition: source.condition, imageRefs, priceYen: 99999, quantity: 1,
  categoryId: "furniture_sofa", categoryPath: "家具・インテリア > ソファ",
  brandId: null, brandName: null,
  managementCode: "BELLO_2C53F36A7A604E34801D8ABC24F6CFC0",
  shipping: { method: "METHOD_TYPE_UNDECIDED", payer: "PAYER_TYPE_SELLER",
    origin: "jp11", duration: "DURATION_TYPE_FOUR_TO_SEVEN_DAYS" },
  status: "PREPARED_NO_SEND" };

test("B005396 review pack carries source evidence but never authorizes a send", () => {
  const evidence = inspectB005396GeneralPreparation(source, pack);
  assert.equal(evidence?.status, "REVIEW_REQUIRED_NO_SEND");
  assert.equal(evidence?.sourceShippingMethod, "KAZAI");
  assert.equal(evidence?.sourcePriceYen, 50000);
  assert.equal(evidence?.selectedCategoryPath, "家具・インテリア > ソファ");
  assert.equal(evidence?.categoryEvidence, "ADMIN_SELECTED_MASTER");
  assert.equal(evidence?.imageEvidence, "SAVED_REFERENCES_ONLY");
  assert.equal(evidence?.shippingReviewRequired, true);
  assert.equal(Object.hasOwn(evidence, "allowFinalCreate"), false);
});

test("B005396 review pack rejects changed identity, draft, image, price, shipping and quantity", () => {
  for (const changed of [
    [ { ...source, inventoryCode: "B005397" }, pack ],
    [ { ...source, draftUpdatedAt: "2026-10-08T01:02:04.000Z" }, pack ],
    [ { ...source, imageRefs: [{ ...imageRefs[0], storageKey: "other.jpg" }] }, pack ],
    [ source, { ...pack, priceYen: 99998 } ],
    [ source, { ...pack, shipping: { ...pack.shipping, origin: "jp13" } } ],
    [ source, { ...pack, quantity: 2 } ],
    [ source, { ...pack, condition: "NEW" } ],
  ]) assert.equal(inspectB005396GeneralPreparation(...changed), null);
});

test("B005396 action reads the current EC draft and never receives a send capability", async () => {
  const calls = [];
  const result = await runB005396GeneralPreparation({
    quantity: 1, categoryId: "furniture_sofa", brandId: null,
  }, {
    readSource: async () => { calls.push("source"); return { ok: true, preparation: source }; },
    readPack: async selected => {
      calls.push("pack");
      assert.deepEqual(selected, { priceYen: 99999, quantity: 1,
        categoryId: "furniture_sofa", brandId: null });
      return { ok: true, pack };
    },
  });
  assert.deepEqual(calls, ["source", "pack"]);
  assert.equal(result.ok, true);
  assert.equal(result.allowFinalCreate, false);
});

test("B005396 action stops before reading a pack on invalid selection or unavailable source", async () => {
  let reads = 0;
  const readers = {
    readSource: async () => { reads++; return { ok: false, code: "READ_UNAVAILABLE" }; },
    readPack: async () => { throw Error("unexpected pack read"); },
  };
  const invalid = await runB005396GeneralPreparation({
    quantity: 0, categoryId: "furniture_sofa", brandId: null,
  }, readers);
  assert.equal(invalid.code, "INVALID_SELECTION");
  assert.equal(reads, 0);
  const unavailable = await runB005396GeneralPreparation({
    quantity: 1, categoryId: "furniture_sofa", brandId: null,
  }, readers);
  assert.equal(unavailable.code, "READ_UNAVAILABLE");
  assert.equal(reads, 1);
});
