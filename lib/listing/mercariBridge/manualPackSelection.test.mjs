import test from "node:test";
import assert from "node:assert/strict";
import { sameManualPackSelection } from "./manualPackSelection.ts";

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
