import assert from "node:assert/strict";
import { assertPrivateTestPage, NEXT_ENGINE_TEST_PUBLICATION_POLICY } from "../lib/listing/nextEngine/privateTestPolicy";
const testCode = "BELLO-NE-TEST-20260928";
for (const flag of [0, "0"]) assert.doesNotThrow(() => assertPrivateTestPage({ goods_page_display_flag: flag, goods_page_goods_code: testCode }, testCode));
for (const flag of [1, "1", undefined, null, false, "", " 0", "private", 2])
  assert.throws(() => assertPrivateTestPage({ goods_page_display_flag: flag, goods_page_goods_code: testCode }, testCode));
assert.throws(() => assertPrivateTestPage({ goods_page_display_flag: 0, goods_page_goods_code: "B005730" }, testCode));
assert.throws(() => assertPrivateTestPage({ goods_page_display_flag: 0, goods_page_goods_code: "B005730" }, "B005730"));
assert.equal(NEXT_ENGINE_TEST_PUBLICATION_POLICY.allowPublicListing, false);
assert.equal(NEXT_ENGINE_TEST_PUBLICATION_POLICY.allowExistingProductUpdate, false);
console.log("Private-only test guard: public, missing and ambiguous visibility rejected.");
