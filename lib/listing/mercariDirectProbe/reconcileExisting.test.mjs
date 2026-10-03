import assert from "node:assert/strict";
import test from "node:test";
import { reconcileExistingMercariProduct } from "./reconcileExisting.ts";

const observed = value => ({ kind: "OBSERVED", value });
const unobserved = { kind: "UNOBSERVED" };

test("exact existing product separates matches, different fields, and unobserved image identity", () => {
  const comparison = reconcileExistingMercariProduct({
    accountReference: "shop-one", remoteId: "product-one",
    fields: { inventoryCode: "SKU-1", title: "検証品", priceYen: 90000,
      condition: "やや傷や汚れあり", shippingMethod: "らくらく家財便",
      primaryImageIdentity: "bello-image-key" },
  }, {
    exactProductReadBack: true, accountReference: observed("shop-one"), remoteId: observed("product-one"),
    visibility: observed("PRIVATE"), fields: { inventoryCode: observed("SKU-1"), title: observed("検証品"),
      priceYen: observed(90000), condition: observed("目立った傷や汚れなし"),
      shippingMethod: observed("未定(出品者が手配)"),
      imageCount: observed(1), primaryImageIdentity: unobserved },
  });
  assert.equal(comparison.account, "MATCH");
  assert.equal(comparison.remoteId, "MATCH");
  assert.equal(comparison.visibility, "PRIVATE_OBSERVED");
  assert.equal(comparison.fields.priceYen, "MATCH");
  assert.equal(comparison.fields.condition, "DIFFERENT");
  assert.equal(comparison.fields.shippingMethod, "DIFFERENT");
  assert.equal(comparison.fields.primaryImageIdentity, "UNOBSERVED");
  assert.equal(comparison.fields.imageCount, "NO_BELLO_EXPECTATION");
  assert.equal(comparison.createAllowed, false);
});

test("a list row or an unknown account never confirms exact product identity or privacy", () => {
  const expected = { accountReference: "shop-one", remoteId: "product-one", fields: { inventoryCode: "SKU-1" } };
  const observedRow = { exactProductReadBack: false, accountReference: observed("shop-one"),
    remoteId: observed("product-one"), visibility: observed("PRIVATE"),
    fields: { inventoryCode: observed("SKU-1") } };
  const result = reconcileExistingMercariProduct(expected, observedRow);
  assert.equal(result.account, "UNOBSERVED");
  assert.equal(result.remoteId, "UNOBSERVED");
  assert.equal(result.visibility, "UNOBSERVED");
  assert.equal(result.fields.inventoryCode, "UNOBSERVED");
  assert.equal(result.createAllowed, false);
});

test("wrong account, unknown account, or wrong remote ID never promote target fields", () => {
  const expected = { accountReference: "shop-one", remoteId: "product-one", fields: { inventoryCode: "SKU-1" } };
  const base = { exactProductReadBack: true, accountReference: observed("shop-one"),
    remoteId: observed("product-one"), visibility: observed("PRIVATE"),
    fields: { inventoryCode: observed("SKU-1") } };
  for (const candidate of [
    { ...base, accountReference: observed("shop-two") },
    { ...base, accountReference: unobserved },
    { ...base, remoteId: observed("product-two") },
  ]) {
    const result = reconcileExistingMercariProduct(expected, candidate);
    assert.equal(result.visibility, "UNOBSERVED");
    assert.equal(result.fields.inventoryCode, "UNOBSERVED");
    assert.equal(result.createAllowed, false);
  }
});
