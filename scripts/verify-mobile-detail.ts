import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";
import { createRequire } from "node:module";
import { ALL_EXTENDED_FIELDS } from "../lib/inventory/extendedFields";
import { DETAIL_FIELDS } from "../mobile/src/domain/detailFields";
import { ZAICO_ATTRIBUTE_MAP, mapZaicoOptionalAttributes } from "../lib/inventory/zaicoMapping";
import { mobileInventoryDetail } from "../lib/mobile/inventoryDetail";
import type { InventoryDetail } from "../lib/inventory/queries";
import { normalizeImageRecord } from "../lib/inventory/imageTypes";

async function main() {
  // The app must read the same persisted keys as the Web UI and existing ZAICO import.
  const existingColumns = new Set<string>([...ALL_EXTENDED_FIELDS.map(field => field.key), "purchasePrice", "salePrice", "shippingCost"]);
  const customKeys = new Set(Object.values(ZAICO_ATTRIBUTE_MAP).flatMap(target => target.kind === "customField" ? [target.fieldKey] : []));
  for (const field of DETAIL_FIELDS) assert.ok(field.custom ? customKeys.has(field.key) : existingColumns.has(field.key), `Unknown existing storage field: ${field.key}`);
  const imported = mapZaicoOptionalAttributes(Object.entries(ZAICO_ATTRIBUTE_MAP).flatMap(([name, target]) =>
    target.kind === "unmapped" || (target.kind === "coreField" && target.lowerPriority) ? [] : [{ name, value: target.valueType === "number" ? "123" : target.valueType === "date" ? "2026/10/17" : "sample-existing-value" }]), true);
  const importedRow = { ...imported.coreFields, ...imported.extendedFields, customFields: imported.customFields } as InventoryDetail;
  const projected = mobileInventoryDetail(importedRow, [], [], [], { ecListing: true, sales: true }, [], new Date().toISOString());
  for (const field of DETAIL_FIELDS) {
    const expected = field.custom ? imported.customFields[field.key] : importedRow[field.key];
    if (expected != null) assert.equal(projected.details?.[field.key], String(expected), `ZAICO/Web/mobile field drift: ${field.key}`);
  }
  const id = "11111111-1111-4111-8111-111111111111";
  let session: Record<string, unknown> = { ok: true, owner: "staff", role: "EDITOR", features: { ecListing: false, sales: false } };
  let calls = 0, unavailable = false, found = true, assetsUnavailable = false;
  const signedPaths: string[] = [];
  const row = {
    id, sku: "SAMPLE", displayId: "73770285", name: "Synthetic chair", quantity: 11, purchaseQuantity: 3,
    unit: "脚", categoryId: "category", locationId: "location", statusId: "status", note: "", barcode: "0000123",
    plannedSalePrice: 29800, purchasePrice: 5940, salePrice: 40000, saleCommission: 4000, listingNotes: "restricted listing text",
    conditionRating: "3.5", depth: "54.5", updatedAt: "2026-10-17T00:00:00Z", images: [
      normalizeImageRecord({ storageKey: "inventory/product.jpg", sortOrder: 0, type: "NORMAL", isPrimary: true }),
      normalizeImageRecord({ storageKey: "inventory/damage.jpg", sortOrder: 1, type: "DAMAGE" }),
    ],
    customFields: { zaicoState: "must-not-use", seatDimensions: "幅46 奥行40 高さ45", unexpectedToken: "must-not-return" },
  };
  const ports = {
    session: async () => session,
    detail: async (requested: string) => { calls++; assert.equal(requested, id); if (unavailable) throw new Error("private provider details"); return found ? row : null; },
    sign: async (path: string) => { signedPaths.push(path); return { url: `https://bello-storage.example/${path}` }; },
    assets: async () => {
      if (assetsUnavailable) throw new Error("BELLO photo store unavailable");
      return { ok: true, value: { truncated: false, assets: [{ id: "bello-camera", status: "READY", isDeleted: false, sequence: 0,
        thumbnailUrl: "https://bello-storage.example/camera-thumb.jpg", processedUrl: "https://bello-storage.example/camera.jpg" }] } };
    },
  };
  const sources: Record<string, string> = {
    "next/server": 'export class NextResponse { static json(body, init={}) { return new Response(JSON.stringify(body), { ...init, headers: { "Content-Type":"application/json", ...init.headers } }); } }',
    "next/headers": 'export const cookies = () => ({});',
    "aws-amplify/storage/server": 'export const getUrl = async (_, {path}) => globalThis.ports.sign(path);',
    "@/lib/amplify/serverUtils": 'export const runWithAmplifyServerContext = ({operation}) => operation({});',
    "@/lib/mobile/session": 'export const getMobileSession = () => globalThis.ports.session();',
    "@/app/actions/photoRegistration": 'export const listInventoryPhotoAssetsAction = () => globalThis.ports.assets();',
    "@/app/actions/inventory": 'export const updateInventory = () => { throw new Error("Read verification must never write"); };',
    "@/lib/inventory/queries": 'export const getInventoryDetail = id => globalThis.ports.detail(id); export const listCategories = async () => [{id:"category",name:"販売中"}]; export const listLocations = async () => [{id:"location",name:"倉庫"}]; export const listStatuses = async () => [{id:"status",label:"既存の状態"}];',
  };
  const bundled = await build({ entryPoints: ["app/api/mobile/inventory/[id]/route.ts"], bundle: true, write: false, platform: "node", format: "cjs", plugins: [{ name: "isolated-detail", setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => sources[args.path] ? { path: args.path, namespace: "stub" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "stub" }, args => ({ contents: sources[args.path], loader: "js" }));
  }}] });
  const module = { exports: {} as { GET(request: Request, context: { params: { id: string } }): Promise<Response>; POST?: unknown } };
  vm.runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, ports, Response, Date, require: createRequire(import.meta.url) });
  const get = (requested = id) => module.exports.GET(new Request("https://bello.example/api/mobile/inventory/test"), { params: { id: requested } });
  assert.equal(module.exports.POST, undefined);
  for (const status of [401, 403, 503]) {
    session = { ok: false, status, error: "FORBIDDEN" }; calls = 0;
    assert.equal((await get()).status, status); assert.equal(calls, 0);
  }
  session = { ok: true, owner: "staff", role: "EDITOR", features: { ecListing: false, sales: false } };
  assert.equal((await get("../admin")).status, 400); assert.equal(calls, 0);
  const response = await get(); const { item } = await response.json();
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(item.quantity, 11); assert.equal(item.details.purchaseQuantity, "3");
  assert.equal(item.displayId, "73770285"); assert.equal(item.sku, "SAMPLE");
  assert.equal(item.plannedSalePrice, 29800); assert.equal(item.details.purchasePrice, "5940");
  assert.equal(item.condition, "既存の状態"); assert.equal(item.statusId, "status"); assert.deepEqual(item.statusOptions, [{ id: "status", label: "既存の状態" }]); assert.equal(item.details.conditionRating, "3.5");
  assert.equal(item.details.depth, "54.5"); assert.equal(item.details.seatDimensions, "幅46 奥行40 高さ45");
  for (const key of ["salePrice", "saleCommission", "listingNotes", "unexpectedToken"]) assert.equal(key in item.details, false);
  assert.equal("customFields" in item, false);
  assert.equal(item.photosComplete, true);
  assert.equal(item.photos.length, 3);
  assert.equal(item.photos.filter((photo: { source: string }) => photo.source === "INVENTORY").length, 2);
  assert.equal(item.photos.filter((photo: { source: string }) => photo.source === "PHOTO_ASSET").length, 1);
  assert.equal(item.photos.filter((photo: { type: string }) => photo.type === "DAMAGE").length, 1);
  assert.deepEqual([...new Set(signedPaths)].sort(), ["inventory/damage.jpg", "inventory/product.jpg"]);
  assetsUnavailable = true;
  const degraded = await (await get()).json();
  assert.equal(degraded.item.photos.length, 2); assert.equal(degraded.item.photosComplete, false);
  // No fetch is supplied to the isolated runtime: a direct external fallback cannot succeed.
  assert.ok(degraded.item.photos.every((photo: { url: string }) => photo.url.startsWith("https://bello-storage.example/")));
  assetsUnavailable = false;
  session.features = { ecListing: true, sales: true };
  const admin = await (await get()).json(); assert.equal(admin.item.details.salePrice, "40000"); assert.equal(admin.item.details.listingNotes, "restricted listing text");
  found = false; assert.equal((await get()).status, 404);
  unavailable = true; const failed = await get(); assert.equal(failed.status, 503); assert.deepEqual(await failed.json(), { error: "INVENTORY_UNAVAILABLE" });
  console.log("PASS: BELLO-only image sources and partial-source failure, detail access, field mapping, staff redaction, 404/errors and no writes; synthetic fixtures only.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
