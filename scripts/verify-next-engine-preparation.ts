import assert from "node:assert/strict";
import { prepareNextEngineProduct } from "../lib/listing/nextEngine/preparation";
const input = { sku: "B005730", title: '家具 "A", テーブル', description: "一段落目。\n\n二段落目。", price: 12000, supplierCode: "9999" };
const output = prepareNextEngineProduct(input);
assert.equal(output.publicationState, "NOT_PUBLISHED");
assert.ok(output.csv.includes('"家具 ""A"", テーブル"'));
assert.ok(output.csv.includes('"一段落目。\n\n二段落目。"'));
assert.ok(!output.csv.includes("zaiko_su"));
for (const change of [{ price: 299 }, { price: 1.5 }, { sku: "../wrong" }, { supplierCode: "" }, { title: "あ".repeat(131) }, { description: "あ".repeat(3001) }])
  assert.throws(() => prepareNextEngineProduct({ ...input, ...change }));
console.log("Next Engine preparation: CSV quoting, paragraph retention, publication boundary and invalid inputs passed.");
