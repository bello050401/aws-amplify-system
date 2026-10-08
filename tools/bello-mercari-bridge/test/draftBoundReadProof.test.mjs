import test from "node:test";
import assert from "node:assert/strict";
import { evaluateBoundDraftReadProof } from
  "../src/draftBoundReadProof.mjs";

const shopId = "evkhihBFFNn5hukMS9s36H";
const managementCode = "BELLO_2C53F36A7A604E34801D8ABC24F6CFC0";
const target = { managementCode, title: "対象商品", priceYen: 99_999 };
const rows = [
  { draftId: "draft1", title: "別の商品", skuCode: "OTHER_1" },
  { draftId: "draft2", title: "", skuCode: null },
];
const list = () => [
  { id: "draft1", title: "別の商品", price: 20_000 },
  { id: "draft2", title: "", price: 0 },
];
const detail = (id, title, skuCode, priceYen, imageCount = 0) => ({
  id, title, skuCode, priceYen, imageCount,
});

function proof({ listRows = list(), detail1 = detail("draft1", "別の商品",
  "OTHER_1", 20_000), detail2 = detail("draft2", "", null, 0),
  omitDetail2 = false, domRows = rows } = {}) {
  const details = new Map([["draft1", detail1]]);
  if (!omitDetail2) details.set("draft2", detail2);
  return evaluateBoundDraftReadProof({ list: listRows, details, failed: false,
    rows: domRows, ...target, expectedRowCount: 2 });
}

test("server-bound blank draft and unrelated named draft establish no match", () => {
  assert.deepEqual(proof(), {
    status: "DRAFT_NETWORK_BOUND_NO_MATCH", complete: true,
    allowFinalCreate: false, rowCount: 2, anonymousVerified: 1,
  });
});

test("every draft requires a matching list and detail response", () => {
  assert.equal(proof({ omitDetail2: true }).status,
    "DRAFT_NETWORK_BOUND_UNVERIFIED");
  assert.equal(proof({ detail2: detail("wrong", "", null, 0) }).status,
    "DRAFT_NETWORK_BOUND_UNVERIFIED");
  assert.equal(proof({ domRows: [rows[0], { ...rows[1],
    draftId: "other" }] }).status, "DRAFT_NETWORK_BOUND_UNVERIFIED");
});

test("target identity and populated anonymous drafts fail closed", () => {
  assert.equal(proof({ detail1: detail("draft1", "別の商品",
    managementCode, 20_000), domRows: [{ ...rows[0],
    skuCode: managementCode }, rows[1]] }).status,
  "REMOTE_DUPLICATE_POSSIBLE");
  assert.equal(proof({ detail2: detail("draft2", "", null,
    99_999), listRows: [list()[0], { ...list()[1], price: 99_999 }] }).status,
  "DRAFT_NETWORK_BOUND_UNVERIFIED");
  assert.equal(proof({ detail2: detail("draft2", "", null,
    0, 1) }).status, "DRAFT_NETWORK_BOUND_UNVERIFIED");
});
