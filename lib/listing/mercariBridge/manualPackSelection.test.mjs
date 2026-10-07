import test from "node:test";
import assert from "node:assert/strict";
import { b005396ReviewSelectionReady, sameManualPackSelection } from
  "./manualPackSelection.ts";

test("a delayed preparation cannot be copied after any submitted field changes", () => {
  const submitted = { price: "30000", quantity: "1",
    categoryId: "chair-category", brandId: null };
  assert.equal(sameManualPackSelection(submitted, { ...submitted }), true);
  for (const changed of [
    { price: "30001" }, { quantity: "2" },
    { categoryId: "sofa-category" }, { brandId: "some-brand" },
  ]) {
    assert.equal(sameManualPackSelection(submitted, { ...submitted, ...changed }),
      false);
  }
});

test("B005396 review requires fixed price, selected category and stock-backed quantity", () => {
  const selection = { price: "99999", quantity: "1",
    categoryId: "sofa-category", brandId: null };
  assert.equal(b005396ReviewSelectionReady(selection, 1), true);
  for (const changed of [
    { price: "99998" }, { quantity: "0" }, { quantity: "2" },
    { quantity: "01" }, { categoryId: null },
  ]) assert.equal(b005396ReviewSelectionReady({ ...selection, ...changed }, 1), false);
  assert.equal(b005396ReviewSelectionReady(selection, 0), false);
});
