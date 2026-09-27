import assert from "node:assert/strict";
import { selectProductReferences as selectReferences } from "../lib/ai/productPage/productResearch";
import type { ResearchSourceDocument } from "../lib/inquiry/research/port";
const document = (text: string, overrides: Partial<ResearchSourceDocument> = {}): ResearchSourceDocument => ({
  text: `ExampleBrand ${text}`, url: "https://example.com/model", title: "Model", sourceType: "MANUFACTURER", injectionDetected: false, ...overrides,
});
const selectProductReferences = (documents: ResearchSourceDocument[], model: string) => selectReferences(documents, model, "ExampleBrand");
assert.equal(selectProductReferences([document("AB-1234 different model")], "AB-123").length, 0);
assert.equal(selectProductReferences([document("XAB-123 different model")], "AB-123").length, 0);
assert.equal(selectProductReferences([document("AB-123 design")], "AB-123").length, 1);
assert.equal(selectProductReferences([document("AB-123", { sourceType: "OTHER" })], "AB-123").length, 0);
assert.equal(selectProductReferences([document("AB-123", { injectionDetected: true })], "AB-123").length, 0);
assert.equal(selectProductReferences([document("AB-123")], "AB").length, 0);
assert.equal(selectProductReferences(Array.from({ length: 5 }, (_, i) => document("AB-123", { url: `https://example.com/model/${i}` })), "AB-123").length, 2);
assert.equal(selectProductReferences([document("AB-123"), document("AB-123", { url: "https://example.com/model#spec" })], "AB-123").length, 1);
assert.equal(selectProductReferences([document("AB-123", { url: "javascript:alert(1)" })], "AB-123").length, 0);
assert.equal(selectProductReferences([document("AB-123", { url: "invalid-url" })], "AB-123").length, 0);
console.log("Product research identity and source boundary checks passed.");
assert.equal(selectReferences([document("AB-123")], "AB-123", null).length, 0);
assert.equal(selectProductReferences([document("other product\nAB-123 different brand")], "AB-123").length, 0);
assert.equal(selectProductReferences([document("AB-123 design。\nOther product is velvet.")], "AB-123")[0].fact, "ExampleBrand AB-123 design。");
