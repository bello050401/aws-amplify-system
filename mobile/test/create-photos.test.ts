import test from "node:test";
import assert from "node:assert/strict";
import {InventoryEditor,InventoryWriteError,type SaveRequest} from "../src/domain/editor";
import type {InventoryItem} from "../src/domain/inventory";
const item:InventoryItem={id:"new-id",sku:"",name:"",quantity:1,unit:"",location:"",category:"",condition:"",note:"",barcode:"",plannedSalePrice:null,thumbnailUrl:null,updatedAt:"2026-10-17T00:00:00Z"};
test("new registration validates, retains photo offline, and only explicitly submits the same ID",async()=>{
  let online=false,writes=0,uploads=0;let received:SaveRequest|undefined;
  const editor=new InventoryEditor(item,{online:async()=>online,newMutationId:()=>"mutation",uploadPhoto:async()=>{uploads++;return{storageKey:"uploaded",type:"NORMAL"};},save:async request=>{writes++;received=request;return{...item,name:request.draft.name};}},true);
  editor.change("name","New inventory");editor.addPhotos([{id:"photo",uri:"local",type:"NORMAL"}]);
  assert.equal(await editor.save(),null);assert.equal(uploads,0);assert.equal(writes,0);assert.equal(editor.getSnapshot().photos.length,1);
  assert.equal(editor.requestLeave(),false);online=true;assert.equal(writes,0);
  await editor.save();assert.equal(received?.create,true);assert.equal(received?.id,item.id);assert.equal(received?.uploads?.length,1);assert.equal(writes,1);assert.equal(editor.getSnapshot().photos.length,0);
});
test("lost create response retains identical request and does not upload photos again",async()=>{
  let uploads=0;const attempts:SaveRequest[]=[];
  const editor=new InventoryEditor(item,{online:async()=>true,newMutationId:()=>"stable",uploadPhoto:async()=>{uploads++;return{storageKey:"key",type:"DAMAGE"};},save:async request=>{attempts.push(request);if(attempts.length===1)throw new InventoryWriteError("uncertain");return{...item,name:request.draft.name};}},true);
  editor.change("name","New");editor.addPhotos([{id:"p",uri:"local",type:"DAMAGE"}]);await editor.save();assert.equal(editor.getSnapshot().outcomeUncertain,true);await editor.save();assert.equal(uploads,1);assert.deepEqual(attempts[0],attempts[1]);
});
test("failed photo transfer never submits inventory, successful photos retained for explicit retry",async()=>{
  let failed=true,writes=0,uploads=0;
  const editor=new InventoryEditor({...item,name:"Existing"},{online:async()=>true,newMutationId:()=>"m",uploadPhoto:async()=>{uploads++;if(failed)throw Error("upload");return{storageKey:"key",type:"NORMAL"};},save:async()=>{writes++;return{...item,name:"Existing"};}});
  editor.addPhotos([{id:"p",uri:"local",type:"NORMAL"}]);await editor.save();assert.equal(writes,0);assert.equal(editor.getSnapshot().outcomeUncertain,false);assert.equal(editor.getSnapshot().dirty,true);failed=false;await editor.save();assert.equal(writes,1);assert.equal(uploads,2);
});
