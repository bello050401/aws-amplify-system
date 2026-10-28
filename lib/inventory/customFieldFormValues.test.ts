import assert from "node:assert/strict";
import { test } from "node:test";
import { customFieldFormValues } from "./customFieldFormValues";
import { productCustomFields, withHumanEdits } from "./humanEdits";

test("editing visible fields retains inactive and unknown product values without changing their types", () => {
  const original = { inactive: "過去の記録", imported: { source: "legacy" }, count: 4, visible: "old", belloBrand: "old" };
  const saved = customFieldFormValues(original, [{ fieldKey: "visible", fieldType: "TEXT" }], { visible: "new", belloBrand: "Magis" });
  assert.deepEqual(saved, { ...original, visible: "new", belloBrand: "Magis" });
  assert.equal(original.visible, "old");
});

test("clearing an active field and brand does not clear an inactive field", () => {
  assert.deepEqual(customFieldFormValues({ visible: "old", inactive: "keep", belloBrand: "Magis" },
    [{ fieldKey: "visible", fieldType: "TEXT" }], { visible: "", belloBrand: "" }), { inactive: "keep" });
});

test("new and duplicated records preserve numeric zero and omit source save/sync receipts", () => {
  assert.deepEqual(customFieldFormValues({ hidden: 12.5, __belloMobileWrite: { mutationId: "source" }, __belloEditedFields: ["name"] },
    [{ fieldKey: "amount", fieldType: "NUMBER" }], { amount: "0" }), { hidden: 12.5, amount: 0 });
  assert.deepEqual(customFieldFormValues(null, [{ fieldKey: "amount", fieldType: "NUMBER" }], { amount: "123.45" }), { amount: 123.45 });
});

test("Restage receipt is hidden and omitted on duplication, but preserved on editing", () => {
  const original={memo:'keep',__restageImport:{date:'2026-10-23',goodsId:'178392'}};
  assert.deepEqual(productCustomFields(original),{memo:'keep'});
  assert.deepEqual(customFieldFormValues(original,[],{}),{memo:'keep'});
  assert.deepEqual(withHumanEdits({}, {}, original, {memo:'keep'}),original);
});

test("Yahoo import identity survives editing, but is hidden and not copied to another inventory", () => {
  const original={usedGoodsFeature:'品目：椅子',__yahooPurchaseImport:{auctionId:'r1234567890'}};
  const visible={usedGoodsFeature:'品目：椅子'};
  assert.deepEqual(productCustomFields(original),visible);
  assert.deepEqual(customFieldFormValues(original,[],{}),visible);
  assert.deepEqual(withHumanEdits({}, {}, original, visible),original);
});
