// Exercise the real draft service against an in-memory SDK boundary; never writes live inventory.
const assert = require("node:assert/strict");
const esbuild = require("esbuild");
const vm = require("node:vm");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
let row = null;
const writes = [];
const state = {
  models: { ListingDraft: {
    listListingDraftByInventoryId: async () => ({ data: row ? [row] : [] }),
    create: async input => { writes.push(input); row = { ...input, id: "draft-test", createdAt: "now", updatedAt: "now" }; return { data: row }; },
    update: async input => { writes.push(input); row = { ...row, ...input }; return { data: row }; },
  } },
  inventory: { id: "inventory-test", name: "Test chair", categoryId: "sale", images: [] },
};
const stubs = new Map([
  ["server-only", ""],
  ["@/lib/amplify/dataClient", "export const serverDataClient={models:globalThis.__test.models};export const inventoryAuthMode={authMode:'userPool'};export const adminAuthMode={};"],
  ["@/lib/inventory/queries", "export const getInventoryDetail=async()=>globalThis.__test.inventory;"],
  ["@/lib/inventory/ecEligibleQuery", "export const listEcEligibleInventory=async()=>{throw Error('unexpected list');};"],
  ["@/lib/inventory/masters", "export const listAllMasterEntries=async()=>[{id:'sale',name:'販売中'}];export const normalizeMasterName=value=>value.normalize('NFKC').trim();"],
  ["@/lib/inventory/e2eFixtures", "export const isE2EFixtureModeActive=()=>false;"],
  ["./base/adapter", "export const createBaseProduct=async()=>{throw Error('external publish is forbidden');};"],
  ["./base/privateTestGuard", "export const isBasePrivateTestEnabled=()=>false;"],
  ["./e2eFixtures", "export const E2E_MANUAL_ONLY_INVENTORY_ID='unused';" +
    ["e2eListingsOverviewFetch","e2eManualOnlyChannelListing","e2eManualOnlyListingDraft","e2eMercariCsvListingDraft","e2eMercariCsvChannelListingFor","e2eChannelOverrideFor","e2eSaveChannelOverride"]
      .map(name => `export const ${name}=()=>{throw Error('unexpected fixture');};`).join("")],
]);

async function main() {
  const bundle = await esbuild.build({
    absWorkingDir: root, stdin: { contents: 'export {saveListingDraft,getListingDraftForInventory} from "./lib/listing/service";', resolveDir: root, loader: "ts" },
    bundle: true, platform: "node", format: "cjs", write: false,
    plugins: [{ name: "isolated-sdk", setup(build) {
      build.onResolve({ filter: /.*/ }, args => stubs.has(args.path) ? { path: args.path, namespace: "test-stub" } : null);
      build.onLoad({ filter: /.*/, namespace: "test-stub" }, args => ({ contents: stubs.get(args.path), loader: "js" }));
    } }],
  });
  const module = { exports: {} };
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, __test: state, console,
    process: { env: {} },
    require(name) { if (name === "node:async_hooks") return require(name); throw Error("Unexpected external dependency: " + name); },
    fetch() { throw Error("Network is forbidden"); },
  });
  const { saveListingDraft, getListingDraftForInventory } = module.exports;
  const input = { title: "Test chair", description: "", price: 29800, condition: "NO_NOTABLE_DAMAGE" };
  const packages = [{ id: "main", name: "本体", rank: "C" }, { id: "legs", name: "脚", rank: "A" }];
  await saveListingDraft("inventory-test", { ...input, shippingPackages: packages }, "test");
  assert.equal(typeof writes[0].shippingPackages, "string", "AWSJSON must be serialized");
  assert.deepEqual(JSON.parse(writes[0].shippingPackages), packages);
  assert.deepEqual(JSON.parse(JSON.stringify((await getListingDraftForInventory("inventory-test")).shippingPackages)), packages);
  console.log("PASS create and reload two packages through real service");
  await saveListingDraft("inventory-test", { ...input, title: "Renamed" }, "test");
  assert.deepEqual(JSON.parse(row.shippingPackages), packages);
  console.log("PASS omitted package field preserves saved packages");
  await saveListingDraft("inventory-test", { ...input, shippingPackages: [{ ...packages[0], rank: "B" }] }, "test");
  assert.deepEqual(JSON.parse(row.shippingPackages), [{ ...packages[0], rank: "B" }]);
  console.log("PASS manual size change and removal survive update/reload");
  delete row.shippingPackages;
  assert.equal((await getListingDraftForInventory("inventory-test")).shippingPackages[0].rank, null);
  console.log("PASS legacy draft defaults to automatic size");
  const before = writes.length;
  await assert.rejects(() => saveListingDraft("inventory-test", { ...input, shippingPackages: [] }, "test"));
  assert.equal(writes.length, before);
  console.log("PASS invalid packages rejected before mutation");
  console.log("5 draft persistence checks passed; no live SDK or network access");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
