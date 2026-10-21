import assert from 'node:assert/strict';
import {sourceIdentityUpdate} from '../lib/zaico/transition/identity';
import {harness} from './verify-zaico-transition-runner';
import {applyFields,RAW_VALUES} from '../lib/zaico/transition/mapping';
import type {V2Inventory} from '../lib/zaico/transition/v2Client';

async function main(){
 const input={id:'local',sourceSystem:'ZAICO',sourceInventoryId:'999'};
 const command=sourceIdentityUpdate('Inventory-test',input,'2026-10-21T09:00:00Z')!;
 assert.equal(command.UpdateExpression,'SET sourceSystem = :system, sourceInventoryId = :source');
 assert.match(command.ConditionExpression!,/updatedAt = :version/);
 assert.match(command.ConditionExpression!,/attribute_not_exists\(outboundBatchId\)/);
 assert.match(command.ConditionExpression!,/attribute_not_exists\(deletedAt\)/);
 assert.match(command.ConditionExpression!,/sourceInventoryId = :source/);
 for(const extra of [{name:'real edit'},{quantity:2},{listUpdatedAt:'now'},{updatedAt:'now'}])
   assert.equal(sourceIdentityUpdate('t',{...input,...extra},'version'),null);
 assert.equal(sourceIdentityUpdate('t',input),null);
 assert.equal(sourceIdentityUpdate('t',{...input,sourceInventoryId:''},'version'),null);
 assert.equal(sourceIdentityUpdate('t',{...input,barcode:'tw202610210933253430366'},'version'),null);
 assert.equal(applyFields({id:'x'},{},{}).customFields,undefined);
 const custom={b:2,a:1};
 assert.equal(applyFields({id:'x',customFields:custom},{},{}).customFields,custom);
 assert.equal(JSON.parse(applyFields({id:'x'},{},{price:{value:'invalid'}}).customFields)[RAW_VALUES].price.value,'invalid');
 const h=harness();h.control={...h.control,phase:'ACTIVE',initialCompletedAt:'2026-10-20T00:00:00Z'};
 h.port.api.create=async(body)=>{
   const created={optional_attributes:{},...body,code:body.code||'tw202610210933253430366',id:999,deleted:false} as V2Inventory;h.remotes.set('999',created);
   return {data:created};
 };
 const version='2026-10-20T12:00:00Z';
 h.rows.set('local',{id:'local',sku:'QA-TIME',name:'UI test',barcode:'BELLO-DATE-TEST',quantity:1,categoryIds:[],createdAt:version,updatedAt:version,listUpdatedAt:version});
 const normalSave=h.port.saveInventory;
 h.port.saveInventory=async(row,expected)=>{
   const attachment=sourceIdentityUpdate('t',row,expected);
   if(!attachment)return normalSave(row,expected);
   const current=h.rows.get(row.id)!;assert.equal(current.updatedAt,expected);
   const saved={...current,...row};h.rows.set(row.id,saved);return structuredClone(saved);
 };
 await h.run();
 assert.equal(h.states.get('local')?.status,'OK',h.states.get('local')?.error);
 const linked=h.rows.get('local')!;
 assert.equal(linked.sourceInventoryId,'999');
 assert.equal(linked.barcode,'BELLO-DATE-TEST');
 assert.equal(linked.createdAt,version);assert.equal(linked.updatedAt,version);assert.equal(linked.listUpdatedAt,version);
 // The inbound echo must not add an empty raw-values marker and touch dates.
 await h.tick();await h.tick();
 assert.equal(h.states.get('local')?.status,'OK',h.states.get('local')?.error);
 assert.equal(h.rows.get('local')!.updatedAt,version);assert.equal(h.rows.get('local')!.listUpdatedAt,version);
 // A delete dialog opened before the automatic provider link remains usable.
 await h.port.deleteInventory({id:'local',updatedAt:version});
 await h.tick();
 assert.equal(h.rows.has('local'),false);assert.equal(h.states.get('local')?.status,'DELETED',h.states.get('local')?.error);
 const blank=harness();blank.control={...blank.control,phase:'ACTIVE',initialCompletedAt:version};
 blank.port.api.create=h.port.api.create;
 blank.port.api.get=async()=>h.remotes.get('999')??null;
 blank.rows.set('blank',{id:'blank',sku:'QA-BLANK',name:'blank',quantity:1,categoryIds:[],createdAt:version,updatedAt:version});
 await blank.run();
 assert.equal(blank.states.get('blank')?.status,'OK',blank.states.get('blank')?.error);
 assert.equal(blank.rows.get('blank')!.barcode,'tw202610210933253430366');
 assert.equal(blank.rows.get('blank')!.createdAt,version);
 assert.notEqual(blank.rows.get('blank')!.updatedAt,version);
 await assert.rejects(blank.port.deleteInventory({id:'blank',updatedAt:version}),/CONFLICT/);
 // An older failed create is recovered even when it is outside the delta.
 blank.rows.get('blank')!.barcode=null;
 blank.states.get('blank')!.localBase.barcode=null;
 blank.states.get('blank')!.status='ERROR';
 blank.port.api.list=async()=>({data:[],pagination:{current_page:1,total_pages:1,total_count:0}});
 await blank.tick();
 assert.equal(blank.rows.get('blank')!.barcode,'tw202610210933253430366');
 assert.equal(blank.states.get('blank')!.status,'OK',blank.states.get('blank')?.error);
 assert.equal(blank.calls.filter(call=>call.method==='PATCH').length,0);
 console.log('PASS provider-link timestamps, narrow field guard, edit-version guard and delete after sync');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
