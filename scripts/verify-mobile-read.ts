import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";

async function main() {
  const calls: string[] = [];
  let session = { kind: "authorized", role: "VIEWER" } as Record<string, string>;
  const row = { id: "test-id", sku: "TEST", name: "試験用在庫", quantity: 2, unit: "脚", categoryId: "c", locationId: "l", conditionRating: "", note: "", barcode: "TEST", plannedSalePrice: 1000, mainImageThumbnailKey: null, mainImageStorageKey: null, updatedAt: "2026-10-17T01:00:00Z", secretTestField: "must-not-return" };
  const ports = {
    getInventorySessionStatus: async () => session,
    getCurrentInventoryUserSub: async () => "test-staff",
    listCategories: async () => { calls.push("categories"); return [{ id: "c", name: "販売中" }]; },
    listLocations: async () => { calls.push("locations"); return [{ id: "l", name: "倉庫" }]; },
    listStatuses: async () => { calls.push("statuses"); return [{ id: "s", label: "既存の状態" }]; },
    listInventoryOffsetPage: async (_filters: unknown, options: { limit: number; offset: number }) => { calls.push("index"); assert.equal(options.limit, 50); return { items: [row], offset: options.offset, limit: 50, hasNext: false, usedIndex: true }; },
    listInventory: async () => { throw new Error("Fallback must not run when the index succeeds."); },
    listInventorySimpleSearch: async () => { calls.push("search"); return { items: [row], offset: 0, limit: 50, total: 1 }; },
  };
  const sources: Record<string, string> = {
    "next/server": 'export class NextResponse { static json(body,init={}) { return new Response(JSON.stringify(body), { ...init, headers: { "Content-Type": "application/json", ...init.headers } }); } }',
    "next/headers": 'export const cookies = () => ({});',
    "aws-amplify/storage/server": 'export const getUrl = async () => { throw new Error("No images in this fixture"); };',
    "@/lib/amplify/serverUtils": 'export const runWithAmplifyServerContext = async ({operation}) => operation({});',
    "@/lib/amplify/requireInventoryUser": 'export const getInventorySessionStatus = (...a) => globalThis.ports.getInventorySessionStatus(...a); export const getCurrentInventoryUserSub = (...a) => globalThis.ports.getCurrentInventoryUserSub(...a);',
    "@/lib/inventory/queries": 'export const listCategories = (...a) => globalThis.ports.listCategories(...a); export const listLocations = (...a) => globalThis.ports.listLocations(...a); export const listStatuses = (...a) => globalThis.ports.listStatuses(...a); export const listInventory = (...a) => globalThis.ports.listInventory(...a); export const listInventorySimpleSearch = (...a) => globalThis.ports.listInventorySimpleSearch(...a);',
    "@/lib/inventory/inventoryPage": 'export const listInventoryOffsetPage = (...a) => globalThis.ports.listInventoryOffsetPage(...a);',
    "@/app/actions/photoRegistration": 'export const listInventoryPrimaryPhotoThumbnailsAction = async () => ({ok:true,value:{"test-id":{url:"https://example.test/photo.jpg",explicitPrimary:true}}});',
  };
  const bundled = await build({ entryPoints: ["app/api/mobile/inventory/route.ts"], bundle: true, write: false, platform: "node", format: "cjs", plugins: [{ name: "mobile-read-boundary", setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) => sources[args.path] ? { path: args.path, namespace: "stub" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: sources[args.path], loader: "js" }));
  }}] });
  const module = { exports: {} as { GET: (request: Request) => Promise<Response>; POST?: unknown } };
  vm.runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, ports, Response, Request, URL, Promise, Date });
  const get = (query = "") => module.exports.GET(new Request(`https://bello.example/api/mobile/inventory${query}`));
  assert.equal(module.exports.POST, undefined);
  for (const [kind, expected] of [["signed-out", 401], ["signed-in-not-authorized", 403], ["temporarily-unavailable", 503]] as const) {
    calls.length = 0; session = { kind }; assert.equal((await get()).status, expected); assert.deepEqual(calls, []);
  }
  session = { kind: "authorized", role: "VIEWER" };
  Object.assign(row, { statusId: "s", conditionRating: "3.5", customFields: { zaicoState: "must-not-use" } });
  for (const query of ["?offset=-1", "?offset=1.5", "?offset=50001", `?q=${"x".repeat(201)}`]) {
    calls.length = 0; assert.equal((await get(query)).status, 400); assert.deepEqual(calls, []);
  }
  calls.length = 0;
  const response = await get(); const body = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(body.owner, "test-staff"); assert.equal(body.role, "VIEWER");
  assert.equal(body.items[0].category, "販売中"); assert.equal(body.items[0].location, "倉庫");
  assert.equal(body.items[0].condition, "既存の状態"); assert.equal(body.items[0].statusId, "s");
  assert.equal(body.items[0].thumbnailUrl, "https://example.test/photo.jpg");
  assert.equal("secretTestField" in body.items[0], false); assert.equal("categoryId" in body.items[0], false);
  assert.equal(body.items.length, 1); assert.ok(calls.includes("index"));
  calls.length = 0; assert.equal((await get("?q=chair")).status, 200); assert.ok(calls.includes("search")); assert.equal(calls.includes("index"), false);
  const missingCategory = await get("?category=missing"); assert.equal((await missingCategory.json()).items.length, 0);
  ports.listCategories = async () => { throw new Error("private diagnostic details"); };
  const failed = await get(); assert.equal(failed.status, 503); assert.deepEqual(await failed.json(), { error: "INVENTORY_UNAVAILABLE" });
  console.log("PASS: mobile inventory read authorization, pagination, DTO, errors; no writes or live network.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
