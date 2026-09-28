import assert from "node:assert/strict";
import { parseBaseItemVisibility } from "../lib/listing/base/visibility";
import { assertBasePrivateTestWrite } from "../lib/listing/base/privateTestGuard";

assert.equal(parseBaseItemVisibility({ item: { item_id: 123, visible: 0 } }, "123"), false);
assert.equal(parseBaseItemVisibility({ item: { item_id: "123", visible: "0" } }, "123"), false);
assert.equal(parseBaseItemVisibility({ item: { item_id: 123, visible: 1 } }, "123"), true);
for (const item of [null, { item_id: 124, visible: 0 }, { item_id: 123 }, { item_id: 123, visible: null },
  { item_id: 123, visible: true }, { item_id: 123, visible: "unknown" }]) {
  assert.throws(() => parseBaseItemVisibility({ item }, "123"));
}
console.log("BASE visibility: exact ID and explicit non-display required; unknown values rejected.");
const enabled = { BASE_PRIVATE_TEST_WRITES_ENABLED: "1" };
const privateItem = { title: "合成商品", detail: "合成説明", price: 300, stock: 1, visible: 0 };
assert.doesNotThrow(() => assertBasePrivateTestWrite("/items/add", privateItem, enabled));
assert.doesNotThrow(() => assertBasePrivateTestWrite("/items/edit", { item_id: "123", visible: 0 }, enabled));
for (const [path, params, env] of [
  ["/items/add", privateItem, {}],
  ["/items/add", { ...privateItem, visible: 1 }, enabled],
  ["/items/edit", { item_id: "123", visible: 1 }, enabled],
  ["/items/edit", { item_id: "123", visible: 0, price: 300 }, enabled],
  ["/items/edit", { item_id: "../wrong", visible: 0 }, enabled],
] as const) assert.throws(() => assertBasePrivateTestWrite(path, params, env));
console.log("BASE private write guard: hidden add and hide-only edit permitted; public and price writes rejected.");
