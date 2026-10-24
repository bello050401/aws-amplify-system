import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOutboundFixture} from '../../scripts/qa/outbound-preserve-fixture.mjs';
import {arrivalStatus,arrivalFailureMessage} from './arrivalTypes.ts';

test('権限不足は再試行を繰り返す案内にせず設定修正が必要と示す',()=>{
 assert.match(arrivalFailureMessage({name:'AccessDeniedException',message:'private ARN'}),/更新権限が不足/);
 assert.doesNotMatch(arrivalFailureMessage({name:'AccessDeniedException',message:'private ARN'}),/private ARN/);
 assert.match(arrivalFailureMessage(Error('timeout')),/「確認」/);
});

async function dispatch(f,quantity=5){const b=await f.prepare(quantity);return f.api.emailOutbound(b.id,'QA');}
async function plan(f,batch){const p=await f.api.previewOutboundArrival(batch.id);return p.items.map(i=>({rowId:i.rowId,inventoryId:i.inventoryId,expectedUpdatedAt:i.updatedAt,locationId:'kawagoe',categoryIds:i.defaultCategoryIds}));}

test('簡易確認は出庫先マスタの保管場所を使用し、出庫後に追加したカテゴリも維持する',async()=>{
 const f=createOutboundFixture(),b=await dispatch(f),stock=f.read('Inventory',f.itemId);
 f.put('Inventory',{...stock,categoryIds:['sale','move'],updatedAt:new Date(Date.parse(stock.updatedAt)+1).toISOString()});
 const cmd=randomUUID(),done=await f.api.confirmDefaultOutboundArrival(b.id,cmd,'QA');
 assert.equal(done.arrivalStatus,'COMPLETED');assert.equal(f.read('Inventory',f.itemId).locationId,'kawagoe');assert.deepEqual(f.read('Inventory',f.itemId).categoryIds,['sale','move']);
 const before=f.read('Inventory',f.itemId);await f.api.confirmDefaultOutboundArrival(b.id,cmd,'QA');assert.deepEqual(f.read('Inventory',f.itemId),before);
});

test('簡易確認は旧履歴の移動予定だけを解除して復旧する',async()=>{
 const f=createOutboundFixture(),b=await dispatch(f),row=b.rows[0],raw=f.read('OutboundItem',row.id),snapshot=JSON.parse(raw.snapshot);
 delete snapshot.movementCategoryRemoved;f.put('OutboundItem',{...raw,snapshot:JSON.stringify(snapshot)});f.put('Inventory',{...f.read('Inventory',f.itemId),categoryIds:['sale','move']});
 await f.api.confirmDefaultOutboundArrival(b.id,randomUUID(),'QA');assert.deepEqual(f.read('Inventory',f.itemId).categoryIds,['sale']);assert.equal(f.read('Inventory',f.itemId).locationId,'kawagoe');
});

test('出庫時は維持、到着確定でカテゴリ・保管場所・更新日時と変更履歴を保存する',async()=>{
 const f=createOutboundFixture(),b=await dispatch(f);assert.equal(arrivalStatus(b),'WAITING');
 const changes=await plan(f,b),cmd=randomUUID(),done=await f.api.confirmOutboundArrival(b.id,cmd,changes,'受取担当');
 assert.equal(arrivalStatus(done),'COMPLETED');assert.equal(done.arrivalBy,'受取担当');
 const stock=f.read('Inventory',f.itemId);assert.equal(stock.locationId,'kawagoe');assert.deepEqual(stock.categoryIds,['sale']);assert.equal(stock.quantity,5);assert.ok(stock.updatedAt>f.original.updatedAt);assert.equal(stock.outboundArrivalBatchId,undefined);
 assert.equal(f.rows('InventoryCategory').size,1);assert.equal(f.rows('InventoryHistory').size,2);
 const row=done.rows[0],journal=JSON.parse(row.arrivalChanges);assert.deepEqual(journal.before,{categoryIds:['sale'],locationId:'office'});assert.equal(journal.after.locationId,'kawagoe');assert.equal(row.arrivalBy,'受取担当');
 await f.api.confirmOutboundArrival(b.id,cmd,changes,'再操作');assert.equal(f.rows('InventoryHistory').size,2);assert.equal(f.effects.emails.length,1);
});

test('5点中3点の到着確認は分割先3点のみ更新し、残り2点は変更しない',async()=>{
 const f=createOutboundFixture(),b=await dispatch(f,3),parent=f.read('Inventory',f.itemId),childId=b.rows[0].splitInventoryId;
 assert.equal((await f.api.outboundProducts(f.destinationId)).length,1);
 const changes=await plan(f,b);assert.equal(changes[0].inventoryId,childId);
 await f.api.confirmOutboundArrival(b.id,randomUUID(),changes,'QA');assert.deepEqual(f.read('Inventory',f.itemId),parent);assert.equal(f.read('Inventory',childId).locationId,'kawagoe');assert.equal(f.read('Inventory',childId).quantity,3);assert.equal(f.effects.merges,0);
});

test('到着待ちの商品は再出庫できず、履歴には件数・数量・確認状況が出る',async()=>{
 const f=createOutboundFixture(),b=await dispatch(f);assert.equal((await f.api.outboundProducts(f.destinationId)).length,0);
 const second=await f.prepare();assert.equal(second.rows[0].status,'SKIPPED');
 const history=(await f.api.outboundHistory()).find(h=>h.id===b.id);assert.equal(history.productCount,1);assert.equal(history.quantity,5);assert.equal(history.arrivalStatus,'WAITING');assert.ok(history.dispatchedAt);
});

test('複数商品の個別設定と空カテゴリを保存し、同じQRの別在庫は変更しない',async()=>{
 const f=createOutboundFixture(),other=randomUUID();f.put('Inventory',{...f.original,id:other,sku:'QA-OTHER',quantity:2});
 let b=await f.api.prepareOutbound(randomUUID(),f.destinationId,[{id:f.itemId,updatedAt:f.original.updatedAt,quantity:5},{id:other,updatedAt:f.original.updatedAt,quantity:2}],'QA','2026-10-23');b=await f.api.emailOutbound(b.id,'QA');
 const untouched=randomUUID();f.put('Inventory',{...f.original,id:untouched,sku:'QA-UNRELATED'});
 const changes=await plan(f,b);Object.assign(changes.find(i=>i.inventoryId===other),{locationId:'office',categoryIds:[]});
 await f.api.confirmOutboundArrival(b.id,randomUUID(),changes,'QA');assert.deepEqual(f.read('Inventory',other).categoryIds,[]);assert.equal(f.read('Inventory',other).categoryId,undefined);assert.equal(f.read('Inventory',other).locationId,'office');assert.deepEqual(f.read('Inventory',untouched),{...f.original,id:untouched,sku:'QA-UNRELATED'});
});

test('確認後の他端末編集・不正な対象・対象漏れ・無効マスタは変更前に止める',async()=>{
 const f=createOutboundFixture(),b=await dispatch(f),changes=await plan(f,b);
 for(const invalid of [[],[...changes,...changes],[{...changes[0],inventoryId:randomUUID()}],[{...changes[0],categoryIds:['missing']}],[{...changes[0],locationId:'missing'}]])await assert.rejects(f.api.confirmOutboundArrival(b.id,randomUUID(),invalid,'QA'));
 const stock={...f.read('Inventory',f.itemId),updatedAt:'2026-10-23T12:00:00Z'};f.put('Inventory',stock);
 await assert.rejects(f.api.confirmOutboundArrival(b.id,randomUUID(),changes,'QA'),/変更されています/);assert.deepEqual(f.read('Inventory',f.itemId),stock);assert.equal(f.rows('InventoryHistory').size,1);
});

test('部分失敗から再開：更新済みの商品を二重更新せず、失敗分だけ完了する',async()=>{
 const f=createOutboundFixture(),other=randomUUID();f.put('Inventory',{...f.original,id:other,sku:'QA-SECOND'});
 let b=await f.api.prepareOutbound(randomUUID(),f.destinationId,[f.itemId,other].map(id=>({id,updatedAt:f.original.updatedAt,quantity:5})),'QA','2026-10-23');b=await f.api.emailOutbound(b.id,'QA');
 const changes=await plan(f,b),cmd=randomUUID();f.effects.failArrivalFor=other;
 const partial=await f.api.confirmOutboundArrival(b.id,cmd,changes,'QA');assert.equal(arrivalStatus(partial),'PARTIAL');assert.equal(f.read('Inventory',f.itemId).locationId,'kawagoe');assert.equal(f.read('Inventory',other).locationId,'office');assert.ok(partial.rows.find(r=>r.inventoryId===other).arrivalError);
 const first=f.read('Inventory',f.itemId),hist=f.rows('InventoryHistory').size;f.effects.failArrivalFor=null;
 const done=await f.api.confirmOutboundArrival(b.id,cmd,[],'QA');assert.equal(arrivalStatus(done),'COMPLETED');assert.deepEqual(f.read('Inventory',f.itemId),first);assert.equal(f.rows('InventoryHistory').size,hist+1);
});

test('失敗後に最新内容を再確認して新しい計画で未完了分だけ変更できる',async()=>{
 const f=createOutboundFixture(),b=await dispatch(f),changes=await plan(f,b);f.effects.failArrivalFor=f.itemId;
 await f.api.confirmOutboundArrival(b.id,randomUUID(),changes,'QA');f.effects.failArrivalFor=null;
 f.put('Inventory',{...f.read('Inventory',f.itemId),name:'更新された商品名',updatedAt:'2026-10-23T12:00:00Z'});
 const latest=await plan(f,b);latest[0].categoryIds=['sale','move'];
 const done=await f.api.confirmOutboundArrival(b.id,randomUUID(),latest,'QA');assert.equal(arrivalStatus(done),'COMPLETED');assert.equal(f.read('Inventory',f.itemId).name,'更新された商品名');assert.deepEqual(f.read('Inventory',f.itemId).categoryIds,['sale','move']);
});

test('同じ確認の同時実行でも履歴は1回分だけ、数量を重複させない',async()=>{
 const f=createOutboundFixture(),b=await dispatch(f),changes=await plan(f,b),cmd=randomUUID();
 await Promise.allSettled([f.api.confirmOutboundArrival(b.id,cmd,changes,'A'),f.api.confirmOutboundArrival(b.id,cmd,changes,'B')]);
 assert.equal(arrivalStatus(await f.api.getOutboundBatch(b.id)),'COMPLETED');assert.equal(f.rows('InventoryHistory').size,2);assert.equal(f.read('Inventory',f.itemId).quantity,5);
});

test('以前の分類保持済み履歴は対応し、在庫変更済みの旧履歴は再更新しない',async()=>{
 const f=createOutboundFixture(),b=await dispatch(f),item=b.rows[0];
 const stock=f.read('Inventory',f.itemId);delete stock.outboundArrivalBatchId;f.put('Inventory',stock);
 const old=f.read('OutboundBatch',b.id);delete old.arrivalWorkflow;f.put('OutboundBatch',old);
 assert.equal(arrivalStatus(await f.api.getOutboundBatch(b.id)),'WAITING');await f.api.confirmOutboundArrival(b.id,randomUUID(),await plan(f,b),'QA');
 const record=f.read('OutboundItem',item.id),snapshot=JSON.parse(record.snapshot);delete snapshot.classificationPreserved;delete record.arrivalStatus;f.put('OutboundItem',{...record,snapshot:JSON.stringify(snapshot)});
 assert.equal(arrivalStatus(await f.api.getOutboundBatch(b.id)),undefined);await assert.rejects(f.api.confirmOutboundArrival(b.id,randomUUID(),[],'QA'),/到着確認待ち/);
});

test('送信前と削除された商品の到着確認はできない',async()=>{
 const f=createOutboundFixture(),b=await f.prepare();await assert.rejects(f.api.confirmOutboundArrival(b.id,randomUUID(),[],'QA'),/出庫の完了/);
 const done=await f.api.emailOutbound(b.id,'QA'),changes=await plan(f,done);f.rows('Inventory').delete(f.itemId);await assert.rejects(f.api.confirmOutboundArrival(b.id,randomUUID(),changes,'QA'),/削除/);
});

test('旧版の分類保持済み商品も再出庫を防ぎ、重複履歴がある場合は更新しない',async()=>{
 const f=createOutboundFixture(),b=await dispatch(f),stock=f.read('Inventory',f.itemId);delete stock.outboundArrivalBatchId;f.put('Inventory',stock);
 assert.equal((await f.api.outboundProducts(f.destinationId)).length,0);assert.equal((await f.prepare()).rows[0].status,'SKIPPED');
 const changes=await plan(f,b),otherBatch=randomUUID(),otherItem={...f.read('OutboundItem',b.rows[0].id),id:otherBatch+':'+f.itemId,batchId:otherBatch};f.put('OutboundItem',otherItem);
 await assert.rejects(f.api.confirmOutboundArrival(b.id,randomUUID(),changes,'QA'),/重複/);assert.deepEqual(f.read('Inventory',f.itemId),stock);
});

test('商品更新後に履歴の最終確定だけが失敗しても、再開で状態と日時を復旧する',async()=>{
 const f=createOutboundFixture(),b=await dispatch(f),changes=await plan(f,b),cmd=randomUUID();f.effects.failArrivalFinal=true;
 await assert.rejects(f.api.confirmOutboundArrival(b.id,cmd,changes,'QA'),/完了状態/);
 const stock=f.read('Inventory',f.itemId);assert.equal(stock.locationId,'kawagoe');assert.equal(arrivalStatus(await f.api.getOutboundBatch(b.id)),'APPLYING');
 f.effects.failArrivalFinal=false;const done=await f.api.confirmOutboundArrival(b.id,cmd,[],'QA');assert.equal(done.arrivalStatus,'COMPLETED');assert.ok(done.arrivalAt);assert.equal(arrivalStatus(done),'COMPLETED');assert.deepEqual(f.read('Inventory',f.itemId),stock);assert.equal(f.rows('InventoryHistory').size,2);
});
