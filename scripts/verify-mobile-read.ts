import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";

async function main() {
  const calls: string[] = [];
  let session: Record<string, unknown> = { ok: true, owner: "test-staff", role: "VIEWER", features: { ecListing: false, sales: false } };
  let waitForPhotos: Promise<void> | null = null;
  const row = { id: "test-id", sku: "TEST", name: "試験用在庫", quantity: 2, unit: "脚", categoryId: "c", locationId: "l", conditionRating: "", note: "", barcode: "TEST", plannedSalePrice: 1000, mainImageThumbnailKey: null, mainImageStorageKey: null, updatedAt: "2026-10-17T01:00:00Z", secretTestField: "must-not-return" };
  const ports = {
    getMobileSession: async () => session,
    listCategories: async () => { calls.push("categories"); return [{ id: "c", name: "販売中" }]; },
    listLocations: async () => { calls.push("locations"); return [{ id: "l", name: "倉庫" }]; },
    listStatuses: async () => { calls.push("statuses"); return [{ id: "s", label: "既存の状態" }]; },
    listCustomFieldDefinitions: async () => [],
    getInventoryDetail: async (id: string) => { calls.push("detail"); return id === row.id ? row : null; },
    listInventoryOffsetPage: async (_filters: unknown, options: { limit: number; offset: number }) => { calls.push("index"); assert.equal(options.limit, 50); return { items: [row], offset: options.offset, limit: 50, hasNext: false, usedIndex: true }; },
    listInventory: async () => { throw new Error("Fallback must not run when the index succeeds."); },
    listInventoryMobileSearch: async () => { calls.push("search"); return { items: [row], offset: 0, limit: 50, total: 1, totalQuantity: row.quantity }; },
    listInventoryPrimaryPhotoThumbnailsAction: async () => { calls.push("photos"); await waitForPhotos; return { ok: true, value: { "test-id": { url: "https://example.test/photo.jpg", explicitPrimary: true } } }; },
  };
  const sources: Record<string, string> = {
    '@/lib/inventory/listImageUrls': 'export const withListImageUrls = async rows => rows; export const signInventoryListKey = async () => null;',
    '@/lib/inventory/thumbnailRecords': 'export const readThumbnailRecords = async ids => (await Promise.all([...new Set(ids)].map(id => globalThis.ports.getInventoryDetail(id)))).filter(Boolean);',
    "next/server": 'export class NextResponse { static json(body,init={}) { return new Response(JSON.stringify(body), { ...init, headers: { "Content-Type": "application/json", ...init.headers } }); } }',
    "next/headers": 'export const cookies = () => ({});',
    "aws-amplify/storage/server": 'export const getUrl = async () => { throw new Error("No images in this fixture"); };',
    "@/lib/amplify/serverUtils": 'export const runWithAmplifyServerContext = async ({operation}) => operation({});',
    "@/lib/mobile/session": 'export const getMobileSession = (...a) => globalThis.ports.getMobileSession(...a);',
    "@/lib/inventory/queries": 'export const listCategories = (...a) => globalThis.ports.listCategories(...a); export const listLocations = (...a) => globalThis.ports.listLocations(...a); export const listStatuses = (...a) => globalThis.ports.listStatuses(...a); export const listCustomFieldDefinitions = (...a) => globalThis.ports.listCustomFieldDefinitions(...a); export const getInventoryDetail = (...a) => globalThis.ports.getInventoryDetail(...a); export const listInventory = (...a) => globalThis.ports.listInventory(...a); export const listInventoryMobileSearch = (...a) => globalThis.ports.listInventoryMobileSearch(...a);',
    "@/lib/inventory/inventoryPage": 'export const listInventoryOffsetPage = (...a) => globalThis.ports.listInventoryOffsetPage(...a);',
    "@/app/actions/photoRegistration": 'export const listInventoryPrimaryPhotoThumbnailsAction = (...a) => globalThis.ports.listInventoryPrimaryPhotoThumbnailsAction(...a);',
  };
  const bundled = await build({ entryPoints: ["app/api/mobile/inventory/route.ts"], bundle: true, write: false, platform: "node", format: "cjs", plugins: [{ name: "mobile-read-boundary", setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) => sources[args.path] ? { path: args.path, namespace: "stub" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: sources[args.path], loader: "js" }));
  }}] });
  const module = { exports: {} as { GET: (request: Request) => Promise<Response>; POST?: unknown } };
  vm.runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, ports, Response, Request, URL, Promise, Date });
  const get = (query = "") => module.exports.GET(new Request(`https://bello.example/api/mobile/inventory${query}`));
  assert.equal(module.exports.POST, undefined);
  for (const expected of [401, 403, 503]) {
    calls.length = 0; session = { ok: false, status: expected, error: "UNAVAILABLE" };
    for (const query of ["", "?images=deferred", "?images=only"]) assert.equal((await get(query)).status, expected);
    assert.deepEqual(calls, []);
  }
  session = { ok: true, owner: "test-staff", role: "VIEWER", features: { ecListing: false, sales: false } };
  Object.assign(row, { statusId: "s", conditionRating: "3.5", customFields: { zaicoState: "must-not-use" } });
  for (const query of ["?images=invalid", "?images=only", "?images=only&ids=invalid/../path", `?images=only&ids=${Array(51).fill("test-id").join(",")}`, "?offset=-1", "?offset=1.5", "?offset=50001", `?q=${"x".repeat(201)}`]) {
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
  // The fast response must resolve even if image processing never completes.
  waitForPhotos = new Promise(() => {});
  for (const quantity of [0, 1, 11]) {
    calls.length = 0; row.quantity = quantity;
    const fast = await (await get("?images=deferred")).json();
    assert.equal(fast.items[0].quantity, quantity);
    assert.equal(fast.items[0].thumbnailUrl, null);
    assert.equal(fast.imagesDeferred, true);
    assert.equal(calls.includes("photos"), false);
  }
  waitForPhotos = null;
  calls.length = 0;
  const images = await (await get("?images=only&ids=test-id,deleted-id")).json();
  assert.deepEqual(images.items, [{ id: row.id, updatedAt: row.updatedAt, thumbnailUrl: "https://example.test/photo.jpg" }]);
  assert.equal(calls.includes("search") || calls.includes("index") || calls.includes("categories"), false);
  const missingCategory = await get("?category=missing"); assert.equal((await missingCategory.json()).items.length, 0);
  ports.listCategories = async () => { throw new Error("private diagnostic details"); };
  const failed = await get(); assert.equal(failed.status, 503); assert.deepEqual(await failed.json(), { error: "INVENTORY_UNAVAILABLE" });
  console.log("PASS: mobile inventory read authorization, pagination, DTO, errors; no writes or live network.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
