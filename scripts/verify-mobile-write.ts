import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";
import { createRequire } from "node:module";
import { normalizeImageRecord } from "../lib/inventory/imageTypes";
import { mobileInventoryDetail } from "../lib/mobile/inventoryDetail";
import { draftFor } from "../mobile/src/domain/inventory";
import type { InventoryDetail } from "../lib/inventory/queries";
import { mergeZaicoUpdate } from "../lib/inventory/zaicoSyncMerge";

async function main() {
  const id = "11111111-1111-4111-8111-111111111111";
  const firstVersion = "2026-10-17T00:00:00.000Z";
  const categories = [{ id: "category", name: "販売中", parentId: null, sortOrder: 0 }], locations = [{ id: "location", name: "倉庫", parentId: null, sortOrder: 0 }], statuses = [{ id: "status", code: "SYNTHETIC", label: "既存状態", sortOrder: 0 }];
  const features = { ecListing: false, sales: false };
  const initial = {
    id, sku: "SYNTHETIC", displayId: "123", name: "Synthetic chair", quantity: 11, unit: "脚", categoryId: "category", locationId: "location", statusId: "status",
    note: "existing note", barcode: "0000123", plannedSalePrice: 29800, purchasePrice: 5940, purchaseQuantity: 3, salePrice: 40000, saleCommission: 4000,
    listingNotes: "restricted listing", shippingCost: 200, width: "46", transactionDate: "2026-08-28", updatedAt: firstVersion,
    images: [normalizeImageRecord({ storageKey: "inventory/synthetic.jpg", sortOrder: 0, type: "NORMAL", isPrimary: true })],
    customFields: { seatDimensions: "幅46 奥行40 高さ45", unknownExistingField: "must-preserve" },
  };
  let row: Record<string, any> = structuredClone(initial);
  let session: Record<string, any> = { ok: true, owner: "test-staff", role: "EDITOR", features };
  let exists = true, allowImages = false;
  let writes = 0, reads = 0, lostReply = false, failBeforeWrite = false, failReadAfterWrite = false;
  let history: any[] = [], triggers = 0;
  const env: Record<string, string> = { BELLO_MOBILE_WRITES_ENABLED: "true" };
  const ports = {
    session: async () => session,
    detail: async (requested: string) => { assert.equal(requested, id); reads++; if (writes && failReadAfterWrite) throw Error("private read error"); return exists ? structuredClone(row) : null; },
    write: async (request: any) => {
      assert.equal(request.authMode, "userPool"); assert.match(request.query, /condition: \$condition/);
      if (failBeforeWrite) throw Error("private unknown transport error");
      if (row.updatedAt !== request.variables.condition.updatedAt.eq) return { errors: [{ errorType: "DynamoDB:ConditionalCheckFailedException" }] };
      const input = request.variables.input;
      writes++;
      row = { ...row, ...input, customFields: JSON.parse(input.customFields), updatedAt: `2026-10-17T00:00:0${writes}.000Z` };
      if (lostReply) { lostReply = false; throw Error("private response lost after commit"); }
      return { data: { updateInventory: { id: row.id, updatedAt: row.updatedAt } } };
    },
    create: async (input:any) => {
      assert.equal(input.id,id,"Client identity must be preserved by the actual shared create action");
      if(exists)return {errors:[{errorType:"DynamoDB:ConditionalCheckFailedException"}]};
      exists=true;writes++;row={...input,customFields:JSON.parse(input.customFields),updatedAt:"2026-10-17T01:00:00.000Z"};
      if(lostReply){lostReply=false;throw Error("Lost create reply");}
      return {data:{id:input.id}};
    },
    image: async () => {if(!allowImages)throw Error("Unexpected image operation");return null;},
    history: async (...args: any[]) => { history.push(args); },
    trigger: async () => { triggers++; },
  };
  const sources: Record<string, string> = {
    "server-only": "",
    "next/server": 'export class NextResponse { static json(body, init={}) { return new Response(JSON.stringify(body), { ...init, headers: { "Content-Type":"application/json", ...init.headers } }); } }',
    "next/headers": 'export const cookies = () => ({});',
    "next/cache": 'export const revalidatePath = () => {};',
    "next/navigation": 'export const redirect = () => { throw Error("Unexpected redirect"); };',
    "aws-amplify/storage/server": 'export const getUrl = async (_, {path}) => ({url:`https://bello-storage.example/${path}`});',
    "@/lib/amplify/serverUtils": 'export const runWithAmplifyServerContext = ({operation}) => operation({});',
    "@/lib/mobile/session": 'export const getMobileSession = () => globalThis.ports.session();',
    "@/lib/amplify/requireInventoryUser": 'export const getInventoryRole = async () => (await globalThis.ports.session()).role; export const canEditInventory = role => ["EDITOR","ADMIN"].includes(role); export const canHardDeleteInventory = () => false; export const getCurrentInventoryUserEmail = async () => "synthetic-staff";',
    "@/lib/amplify/dataClient": 'export const inventoryAuthMode = {authMode:"userPool"}; export const serverDataClient = {graphql: request => globalThis.ports.write(request), mutations:{generateInventorySku:async()=>({data:"TEST-NEW"})},models:{Inventory:{create:input=>globalThis.ports.create(input)}}};',
    "@/lib/inventory/queries": `export const getInventoryDetail = id => globalThis.ports.detail(id); export const getInventoryHistory = async () => []; export const listCategories = async () => ${JSON.stringify(categories)}; export const listLocations = async () => ${JSON.stringify(locations)}; export const listStatuses = async () => ${JSON.stringify(statuses)};`,
    "@/lib/inventory/inventoryPage": 'export const clearInventoryCountCache = () => {};',
    "@/lib/inventory/imageServerOps": 'const forbidden = () => { throw Error("Unexpected image write"); }; export const computeOriginalHashForPath = ()=>globalThis.ports.image(), copyInventoryImage = forbidden, removeInventoryImage = forbidden;',
    "@/lib/inventory/thumbnail": 'const forbidden = () => { throw Error("Unexpected image processing"); }; export const copyInventoryMedium = forbidden, copyInventoryThumbnail = forbidden, generateInventoryDerivatives = async()=>{await globalThis.ports.image();return {thumbnailKey:null,mediumKey:null};}, generateInventoryMedium = forbidden, generateInventoryThumbnail = forbidden;',
    "@/lib/inventory/history": 'export const logInventoryHistory = (...args) => globalThis.ports.history(...args); export const diffField = (fieldName, oldValue, newValue) => oldValue === newValue ? null : {fieldName,oldValue,newValue};',
    "@/lib/imageProcessing/jobService": 'export const triggerImageProcessingIfNeeded = () => globalThis.ports.trigger();',
    "@/app/actions/photoRegistration": 'export const listInventoryPhotoAssetsAction = async () => ({ok:true,value:{assets:[],truncated:false}});',
  };
  // The real mobile handler, mapper, existing Web save action, and conditional-write helper run together.
  // Only storage/auth/framework ports are simulated; no remote network or production data is used.
  const bundled = await build({ entryPoints: ["app/api/mobile/inventory/[id]/route.ts"], bundle: true, write: false, platform: "node", format: "cjs", plugins: [{ name: "mobile-write-boundary", setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(sources, args.path) ? { path: args.path, namespace: "stub" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "stub" }, args => ({ contents: sources[args.path], loader: "js" }));
  }}] });
  const module = { exports: {} as { POST(request: Request, context: { params: { id: string } }): Promise<Response>; PATCH(request: Request, context: { params: { id: string } }): Promise<Response> } };
  vm.runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, ports, Response, Date, URL, Buffer, process: {env}, require: createRequire(import.meta.url) });
  let nonce = 0;
  const body = () => ({ id, expectedUpdatedAt: row.updatedAt, mutationId: `00000000-0000-4000-8000-${String(++nonce).padStart(12, "0")}`,
    draft: draftFor(mobileInventoryDetail(row as InventoryDetail, categories, locations, statuses, features, [], firstVersion)) });
  const patch = (value: unknown, headers: Record<string, string> = {}) => module.exports.PATCH(new Request(`https://bello.example/api/mobile/inventory/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json", "X-Bello-Mobile": "1", ...headers }, body: JSON.stringify(value),
  }), { params: { id } });
  const reset = () => { row = structuredClone(initial); writes = 0; reads = 0; history = []; triggers = 0; failReadAfterWrite = false; failBeforeWrite = false; lostReply = false; };

  for (const status of [401, 403, 503]) { session = { ok: false, status, error: "TEST" }; assert.equal((await patch(body())).status, status); assert.equal(reads, 0); }
  session = { ok: true, owner: "test-staff", role: "VIEWER", features };
  assert.equal((await patch(body())).status, 403); assert.equal(reads, 0);
  session.role = "EDITOR"; env.BELLO_MOBILE_WRITES_ENABLED = "false";
  assert.equal((await patch(body())).status, 403); env.BELLO_MOBILE_WRITES_ENABLED = "true";
  for (const headers of [{ Origin: "https://unrelated.example" }, { "X-Bello-Mobile": "" }, { "Sec-Fetch-Site": "cross-site" }] as Record<string, string>[]) assert.equal((await patch(body(), headers)).status, 403);
  assert.equal((await patch(body(), { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await patch({ invalid: "x".repeat(66000) })).status, 413); assert.equal(writes, 0);
  for (const change of [{ quantity: "-1" }, { quantity: "2147483648" }, { details: { unknown: "no" } }, { category: "nonexistent" }, { statusId: "nonexistent" }]) {
    const request = body(); Object.assign(request.draft, change); assert.equal((await patch(request)).status, 422);
  }
  for (const change of [{ salePrice: "1" }, { listingNotes: "not allowed" }, { shippingCost: "1" }]) {
    const request = body(); Object.assign(request.draft.details, change); assert.equal((await patch(request)).status, 403);
  }
  assert.equal(writes, 0);

  const request = body(); request.draft.quantity = "12"; request.draft.note = ""; request.draft.unit = "";
  request.draft.category = ""; request.draft.location = ""; request.draft.statusId = "";
  request.draft.details.width = "47"; request.draft.details.seatDimensions = "changed dimensions";
  request.draft.details.purchasePrice = "";
  // Amplify's SSR internal URL can differ from the browser's public origin.
  env.BELLO_MOBILE_PUBLIC_ORIGIN = "https://public-bello.example";
  assert.equal((await patch(request, { Origin: "https://bello.example" })).status, 403);
  const response = await patch(request, { Origin: "https://public-bello.example", "Sec-Fetch-Site": "same-origin" }); assert.equal(response.status, 200);
  delete env.BELLO_MOBILE_PUBLIC_ORIGIN;
  const saved = await response.json(); assert.equal(saved.owner, "test-staff"); assert.equal(saved.mutationId, request.mutationId); assert.equal(saved.item.quantity, 12);
  assert.equal(row.note, null); assert.equal(row.unit, null); assert.equal(row.categoryId, null); assert.equal(row.locationId, null); assert.equal(row.statusId, null); assert.equal(row.purchasePrice, null);
  assert.equal(row.salePrice, 40000); assert.equal(row.saleCommission, 4000); assert.equal(row.listingNotes, "restricted listing"); assert.equal(row.shippingCost, 200);
  assert.equal(row.customFields.unknownExistingField, "must-preserve"); assert.equal(row.customFields.seatDimensions, "changed dimensions"); assert.equal(row.width, "47");
  assert.deepEqual(JSON.parse(JSON.stringify(row.images)), initial.images); assert.equal(writes, 1); assert.equal(history.length, 1); assert.equal(triggers, 1);
  assert.equal(JSON.stringify(history).includes("__bello"), false);
  assert.equal(saved.item.details.salePrice, undefined); assert.equal(saved.item.customFields, undefined);
  const syncInput = { zaico: { name: initial.name, quantity: initial.quantity, note: initial.note, extendedFields: { width: initial.width }, customFields: initial.customFields },
    bello: { name: row.name, quantity: row.quantity, note: row.note, extendedFields: { width: row.width }, customFields: row.customFields }, snapshotJson: null, isNewRecord: false };
  const sync = mergeZaicoUpdate(syncInput);
  assert.equal(sync.updates.quantity, undefined); assert.equal(sync.updates.note, undefined); assert.equal(sync.extendedFields.width, undefined);
  assert.equal(sync.customFields.seatDimensions, "changed dimensions");
  for (const field of ["quantity", "note", "width", "customFields.seatDimensions"]) assert.ok(sync.conflicts.some(conflict => conflict.field === field));
  // Agreement releases only that field, allowing subsequent external changes to follow existing policy.
  const agreed = mergeZaicoUpdate({ ...syncInput, zaico: { ...syncInput.zaico, quantity: row.quantity } });
  assert.equal((agreed.customFields.__belloEditedFields as string[]).includes("quantity"), false);
  const subsequent = mergeZaicoUpdate({ ...syncInput, bello: { ...syncInput.bello, customFields: agreed.customFields }, zaico: { ...syncInput.zaico, quantity: 10 } });
  assert.equal(subsequent.updates.quantity, 10);
  assert.equal((await patch(request)).status, 200); assert.equal(writes, 1); assert.equal(history.length, 1);
  const differentBody = structuredClone(request); differentBody.draft.quantity = "500";
  assert.equal((await patch(differentBody)).status, 409); assert.equal(row.quantity, 12); assert.equal(writes, 1);

  reset(); const old = body(); row.updatedAt = "2026-10-17T00:00:01.000Z"; row.quantity = 20;
  assert.equal((await patch(old)).status, 409); assert.equal(writes, 0); assert.equal(row.quantity, 20);
  reset(); const a = body(), b = body(); a.draft.quantity = "12"; b.draft.quantity = "20";
  const concurrent = await Promise.all([patch(a), patch(b)]);
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409]); assert.equal(writes, 1);
  reset(); const retry = body(); retry.draft.quantity = "14";
  const duplicates = await Promise.all([patch(retry), patch(retry)]);
  assert.deepEqual(duplicates.map(result => result.status), [200, 200]); assert.equal(writes, 1);
  reset(); lostReply = true; const lost = body(); lost.draft.quantity = "15";
  assert.equal((await patch(lost)).status, 200); assert.equal(writes, 1); assert.equal(row.quantity, 15);
  reset(); failReadAfterWrite = true; const uncertain = body(); uncertain.draft.quantity = "16";
  const failedReadback = await patch(uncertain); assert.equal(failedReadback.status, 503); assert.deepEqual(await failedReadback.json(), {error:"UNCONFIRMED"}); assert.equal(writes, 1);
  failReadAfterWrite = false; assert.equal((await patch(uncertain)).status, 200); assert.equal(writes, 1);
  reset(); failBeforeWrite = true;
  const unknown = await patch(body()); assert.equal(unknown.status, 503); assert.deepEqual(await unknown.json(), {error:"UNCONFIRMED"}); assert.equal(writes, 0);
  reset();exists=false;allowImages=true;
  const fresh=body() as ReturnType<typeof body> & {create:boolean;uploads:{storageKey:string;type:string}[]}; fresh.create=true;
  fresh.draft.details={width:"12.5",transactionDate:"2026-10-17"};
  fresh.uploads=[{storageKey:'inventory/mobile/test-staff/11111111-1111-4111-8111-111111111111/'+"a".repeat(64)+'.jpg',type:"NORMAL"}];
  const post=(value:unknown)=>module.exports.POST(new Request('https://bello.example/api/mobile/inventory/'+id,{method:"POST",headers:{"Content-Type":"application/json","X-Bello-Mobile":"1"},body:JSON.stringify(value)}),{params:{id}});
  assert.equal((await patch(fresh)).status,422);
  session.role="VIEWER";assert.equal((await post(fresh)).status,403);session.role="EDITOR";
  const wrongOwner=structuredClone(fresh);wrongOwner.uploads[0].storageKey=wrongOwner.uploads[0].storageKey.replace('test-staff','another-staff');
  assert.equal((await post(wrongOwner)).status,403);assert.equal(writes,0);
  const before=structuredClone(fresh);lostReply=true;
  assert.equal((await post(fresh)).status,200);assert.equal(writes,1);assert.equal(row.id,id);assert.equal(row.images.length,1);assert.equal(row.images[0].isPrimary,true);assert.equal(row.width,"12.5");
  assert.equal((await post(before)).status,200);assert.equal(writes,1);
  const conflict=structuredClone(fresh);conflict.draft.name="different";assert.equal((await post(conflict)).status,409);assert.equal(writes,1);
  reset();exists=false;allowImages=true;
  const concurrentCreates=await Promise.all([post(fresh),post(fresh)]);assert.deepEqual(concurrentCreates.map(r=>r.status),[200,200]);assert.equal(writes,1);
  console.log("PASS: real shared create action preserves client ID; images, ownership, permissions, concurrent and lost-response create retries are verified with synthetic storage.");
  console.log("PASS: actual BELLO save action, field/image preservation and clearing, permissions, CSRF/body bounds, atomic conflicts, duplicate retry and lost-response reconciliation; synthetic storage only.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
