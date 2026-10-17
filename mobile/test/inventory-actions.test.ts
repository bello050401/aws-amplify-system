import assert from "node:assert/strict";
import test from "node:test";
import { inventoryCopyDraft, removeConfirmedInventory, deletionWarning } from "../src/domain/inventoryActions";
import { InventoryEditor, InventoryWriteError, type SaveRequest } from "../src/domain/editor";
import { previewItems } from "../src/preview/fixture";

test("copy opens an independent new draft; leaving requires confirmation and saving never changes source", async () => {
  const source = previewItems[0], before = structuredClone(source);
  const copy = inventoryCopyDraft(source,"new-id","2026-10-17T03:00:00Z");
  const requests: SaveRequest[] = [];
  const editor = new InventoryEditor(copy,{online:async()=>true,newMutationId:()=>"mutation",save:async value=>{requests.push(value);return {...copy,sku:"NEW-SKU"};}},true,{id:source.id,updatedAt:source.updatedAt});
  assert.equal(editor.requestLeave(), false);
  assert.equal(requests.length,0);
  editor.changeDetail("shippingCost","1200");
  await editor.save();
  assert.equal(requests[0]?.create,true); assert.equal(requests[0]?.id,"new-id");
  assert.equal(requests[0]?.copyFrom?.id,source.id); assert.equal(requests[0]?.draft.details.shippingCost,"1200");
  assert.equal(copy.displayId,undefined); assert.deepEqual(source,before);
});

test("deleting offline sends nothing and does not resume automatically", async () => {
  let online=false,writes=0;
  const ports={online:async()=>online,removeInventory:async()=>{writes++;}};
  await assert.rejects(removeConfirmedInventory(previewItems[0],ports),error=>deletionWarning(error)==="【圏外です】");
  online=true;await Promise.resolve();assert.equal(writes,0);
  await removeConfirmedInventory(previewItems[0],ports);assert.equal(writes,1);
});

test("deletion sends the displayed version and does not swallow conflicts or unknown outcomes",async()=>{
  for(const kind of ["conflict","uncertain","forbidden"] as const) {
    await assert.rejects(removeConfirmedInventory(previewItems[0],{online:async()=>true,removeInventory:async request=>{
      assert.equal(request.id,previewItems[0].id);assert.equal(request.expectedUpdatedAt,previewItems[0].updatedAt);throw new InventoryWriteError(kind);
    }}),error=>error instanceof InventoryWriteError&&error.kind===kind);
  }
});
