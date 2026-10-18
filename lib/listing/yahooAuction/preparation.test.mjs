import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as preparation from "./preparation.ts";
import * as ending from "./ending.ts";
import * as commonSettings from "../commonSettings.ts";

const inventoryId = "57b4b2b5-d6ad-435a-b303-5d412405a44c";
const draft = { id: "source-draft", inventoryId, title: "椅子", description: "木製の椅子1脚。",
  condition: "NO_NOTABLE_DAMAGE", images: [{ storageKey: "inventory/chair.jpg", sortOrder: 0 }],
  shippingMethod: "KAZAI", updatedAt: "2026-10-15T01:00:00.000Z" };
const input = { ...preparation.initialYahooAuctionInput(draft), priceYen: 99999,
  categoryId: "12345", categoryName: "椅子", endAtJst: "2030-01-10T21:00" };

test("automatic ending is the following Japan calendar day at 21:00, including month/year rollovers", () => {
  for (const [now, expected] of [
    ["2026-10-18T00:00:00+09:00", "2026-10-19T21:00"],
    ["2026-10-31T23:59:59+09:00", "2026-11-01T21:00"],
    ["2026-12-31T10:00:00+09:00", "2027-01-01T21:00"],
  ]) {
    assert.equal(ending.defaultYahooEndAt(Date.parse(now)), expected);
    assert.equal(ending.resolvedYahooEndAt({endAtJst:"2020-01-01T21:00"}, Date.parse(now)), expected);
  }
  assert.equal(ending.resolvedYahooEndAt({endAtJst:"2030-02-01T20:00",automaticEnd:false}),"2030-02-01T20:00");
  assert.equal(preparation.initialYahooAuctionInput({...draft,price:25000}).priceYen,25000);
  assert.equal(preparation.initialYahooAuctionInput(draft).automaticEnd,true);
});

test("uncategorized stocked inventory can save channel preparation and receives automatic ending", async () => {
  const t=actions({uncategorized:true});
  const r=await t.api.saveYahooAuctionPreparationAction(inventoryId, input, null, draft.updatedAt);
  assert.equal(r.ok,true);
  assert.equal(r.saved.payload.input.endAtJst,ending.defaultYahooEndAt());
  assert.equal(r.saved.payload.input.automaticEnd,true);
});

test("shipping presets retain the selected supported delivery and reject unknown methods",()=>{
  assert.equal(preparation.parseYahooAuctionInput({...input,shippingMethod:"SAGAWA"}).shippingMethod,"SAGAWA");
  assert.equal(preparation.parseYahooAuctionInput({...input,shippingMethod:"unknown"}),null);
  assert.ok(preparation.parseYahooAuctionInput(input),"legacy saved input remains readable");
});

test("partial drafts, exact integers and valid Japan dates", () => {
  assert.ok(preparation.parseYahooAuctionInput(preparation.initialYahooAuctionInput(draft)));
  for (const change of [{ priceYen: 0 }, { priceYen: 1.1 }, { quantity: -1 }, { quantity: 1.5 },
    { categoryId: "https://evil.example/" }, { categoryId: "__proto__" }, { format: "invalid" },
    { endAtJst: "2026-02-30T21:00" }, { endAtJst: "2026-10-15T24:00" }, { endAtJst: "2026-10-15T21:30" }])
    assert.equal(preparation.parseYahooAuctionInput({ ...input, ...change }), null);
  assert.equal(preparation.parseYahooAuctionInput({ ...input, buyNowYen: 100000 }).buyNowYen, null);
  assert.equal(preparation.parseYahooAuctionInput({ ...input, credential: "must-not-save" }).credential, undefined);
});

test("publication needs distinct price, dates, stock, images and category checks", () => {
  assert.deepEqual(preparation.yahooPreparationIssues(input, 1, 2, Date.parse("2030-01-09T00:00:00Z")), []);
  const issues = preparation.yahooPreparationIssues({ ...input, title: "長".repeat(66), quantity: 3,
    format: "AUCTION", buyNowYen: 1, automaticEnd: false }, 11, 2, Date.parse("2030-01-11T00:00:00Z"));
  assert.equal(issues.length, 5);
});

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().reverse().map(key => [key, reverseObjectKeys(value[key])]));
  return value;
}

function actions({ role = "ADMIN", lostAck = false, competingWrite = false, sold = false, reorderPayload = false, uncategorized = false } = {}) {
  let row = null, writes = 0, reads = 0;
  const source = structuredClone(draft);
  const models = { YahooAuctionPreparation: { get: async () => { reads++; return { data: row }; } } };
  const client = { models, graphql: async ({ variables, query, authMode }) => {
    assert.equal(authMode, "userPool"); writes++;
    const actual = variables.input;
    if (competingWrite) {
      row = { ...actual, payload: JSON.stringify({ ...JSON.parse(actual.payload), input: { ...input, title: "別画面で編集" } }), updatedAt: "2026-10-15T02:00:00Z" };
      throw Error("ConditionalCheckFailed");
    }
    if (row ? variables.condition.revision.eq !== row.revision : variables.condition.revision.attributeExists !== false)
      throw Error("ConditionalCheckFailed");
    row = { ...actual, updatedAt: "2026-10-15T02:00:00Z" };
    if (reorderPayload) row.payload = JSON.stringify(reverseObjectKeys(JSON.parse(actual.payload)));
    if (lostAck) throw Error("Acknowledgement lost");
    return { data: { [query.includes("createYahooAuctionPreparation(") ? "createYahooAuctionPreparation" : "updateYahooAuctionPreparation"]: row } };
  } };
  const stubs = {
    "@/lib/amplify/requireInventoryUser": { canEditInventory: r => ["ADMIN", "EDITOR"].includes(r), getInventoryRole: async () => role, getCurrentInventoryUserEmail: async () => "operator-fixture" },
    "@/lib/amplify/dataClient": { serverDataClient: client, inventoryAuthMode: { authMode: "userPool" } },
    "@/lib/inventory/queries": { getInventoryDetail: async () => ({ id: inventoryId, quantity: 2, saleEndDate: sold ? "2026-10-14" : null, categoryId: uncategorized ? null : "category" }), listCategories: async () => [{ id: "category", name: "在庫" }] },
    "@/lib/listing/service": { getListingDraftForInventory: async () => structuredClone(source) },
    "@/lib/listing/ecEligibility": { isEcListingEligible: () => true },
    "@/lib/listing/yahooAuction/preparation": preparation,
    "@/lib/listing/yahooAuction/ending": ending,
    "@/lib/listing/commonSettings": commonSettings,
  };
  const text = fs.readFileSync(new URL("../../../app/actions/yahooAuctionPreparation.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exported = {};
  vm.runInNewContext(compiled, { exports: exported, require: name => {
    if (!stubs[name]) throw Error(`Unexpected dependency: ${name}`);
    return stubs[name];
  }, Date, JSON, Number, Promise, Error });
  return { api: exported, state: () => ({ row, writes, reads }), source };
}

test("read-only users and invalid input cannot reach persistence", async () => {
  const t = actions({ role: "VIEWER" });
  assert.equal((await t.api.getYahooAuctionPreparationAction(inventoryId)).code, "FORBIDDEN");
  assert.equal((await t.api.saveYahooAuctionPreparationAction(inventoryId, input, null, draft.updatedAt)).code, "FORBIDDEN");
  assert.equal(t.state().reads, 0); assert.equal(t.state().writes, 0);
  const admin = actions();
  assert.equal((await admin.api.saveYahooAuctionPreparationAction(inventoryId, { ...input, priceYen: -1 }, null, draft.updatedAt)).code, "INVALID_INPUT");
  assert.equal(admin.state().writes, 0);
});

test("channel draft persists exact selected values with server-owned photos; stale updates stop", async () => {
  const t = actions();
  const saved = await t.api.saveYahooAuctionPreparationAction(inventoryId, { ...input, images: ["attacker"] }, null, draft.updatedAt);
  assert.equal(saved.ok, true); assert.equal(saved.saved.revision, 1);
  assert.deepEqual(saved.saved.payload.source.images, draft.images);
  assert.equal(saved.saved.payload.input.priceYen, 99999);
  assert.equal(saved.saved.payload.input.images, undefined);
  const reload = await t.api.getYahooAuctionPreparationAction(inventoryId);
  assert.equal(reload.context.saved.revision, 1);
  assert.equal((await t.api.saveYahooAuctionPreparationAction(inventoryId, input, null, draft.updatedAt)).code, "CONFLICT");
  assert.equal(t.state().writes, 1);
  const updated = await t.api.saveYahooAuctionPreparationAction(inventoryId, { ...input, priceYen: 109999 }, 1, draft.updatedAt);
  assert.equal(updated.saved.revision, 2);
  assert.equal(updated.saved.payload.input.priceYen, 109999);
});

test("changed common draft, excessive stock and sold product block save", async () => {
  const t = actions();
  assert.equal((await t.api.saveYahooAuctionPreparationAction(inventoryId, input, null, "old-version")).code, "SOURCE_CHANGED");
  assert.equal((await t.api.saveYahooAuctionPreparationAction(inventoryId, { ...input, quantity: 3 }, null, draft.updatedAt)).code, "NOT_ELIGIBLE");
  const sold = actions({ sold: true });
  assert.equal((await sold.api.saveYahooAuctionPreparationAction(inventoryId, input, null, draft.updatedAt)).code, "NOT_ELIGIBLE");
  assert.equal(t.state().writes + sold.state().writes, 0);
});

test("uncertain save acknowledgement is reconciled by one read, never replayed", async () => {
  const t = actions({ lostAck: true });
  assert.equal((await t.api.saveYahooAuctionPreparationAction(inventoryId, input, null, draft.updatedAt)).ok, true);
  assert.equal(t.state().writes, 1);
});

test("AWSJSON object key ordering does not turn a committed save into a conflict", async () => {
  for (const lostAck of [false, true]) {
    const t = actions({ reorderPayload: true, lostAck });
    const result = await t.api.saveYahooAuctionPreparationAction(inventoryId, input, null, draft.updatedAt);
    assert.equal(result.ok, true);
    assert.equal(result.saved.payload.input.priceYen, 99999);
    assert.equal(t.state().writes, 1);
    assert.equal((await t.api.getYahooAuctionPreparationAction(inventoryId)).context.saved.revision, 1);
  }
});

test("concurrent tab write wins without overwrite or false success", async () => {
  const t = actions({ competingWrite: true });
  assert.equal((await t.api.saveYahooAuctionPreparationAction(inventoryId, input, null, draft.updatedAt)).code, "CONFLICT");
  assert.equal(t.state().writes, 1);
  assert.equal(JSON.parse(t.state().row.payload).input.title, "別画面で編集");
});

test("source change is detectable and malformed persisted records are rejected", () => {
  const source = { draftId: draft.id, draftUpdatedAt: draft.updatedAt, images: draft.images, shippingMethod: "KAZAI" };
  assert.equal(preparation.yahooSourceMatches(source, draft), true);
  assert.equal(preparation.yahooSourceMatches(reverseObjectKeys(source), draft), true);
  assert.equal(preparation.yahooSourceMatches(source, { ...draft, images: [] }), false);
  const payload = { schemaVersion: 1, input, source: { ...source, images: [
    ...source.images, { storageKey: "inventory/second.jpg", sortOrder: 1 }] } };
  assert.equal(preparation.yahooPayloadsMatch(payload, reverseObjectKeys(payload)), true);
  assert.equal(preparation.yahooPayloadsMatch(payload, { ...payload, source: {
    ...payload.source, images: [...payload.source.images].reverse() } }), false);
  assert.equal(preparation.yahooPayloadsMatch(payload, { ...payload, input: { ...input, priceYen: 1 } }), false);
  assert.equal(preparation.parseYahooSaved({ revision: 1, updatedAt: new Date().toISOString(), payload: "broken" }), null);
});
