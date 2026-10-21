import assert from 'node:assert/strict';
import {sourceIdentityUpdate} from '../lib/zaico/transition/identity';
import {harness} from './verify-zaico-transition-runner';

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
 const h=harness();h.control={...h.control,phase:'ACTIVE',initialCompletedAt:'2026-10-20T00:00:00Z'};
 const version='2026-10-20T12:00:00Z';
 h.rows.set('local',{id:'local',sku:'QA-TIME',name:'UI test',quantity:1,categoryIds:[],createdAt:version,updatedAt:version,listUpdatedAt:version});
 const normalSave=h.port.saveInventory;
 h.port.saveInventory=async(row,expected)=>{
   const attachment=sourceIdentityUpdate('t',row,expected);
   if(!attachment)return normalSave(row,expected);
   const current=h.rows.get(row.id)!;assert.equal(current.updatedAt,expected);
   const saved={...current,...row};h.rows.set(row.id,saved);return structuredClone(saved);
 };
 await h.run();
 const linked=h.rows.get('local')!;
 assert.equal(linked.sourceInventoryId,'999');
 assert.equal(linked.createdAt,version);assert.equal(linked.updatedAt,version);assert.equal(linked.listUpdatedAt,version);
 // A delete dialog opened before the automatic provider link remains usable.
 await h.port.deleteInventory({id:'local',updatedAt:version});
 await h.tick();
 assert.equal(h.rows.has('local'),false);assert.equal(h.states.get('local')?.status,'DELETED');
 console.log('PASS provider-link timestamps, narrow field guard, edit-version guard and delete after sync');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
