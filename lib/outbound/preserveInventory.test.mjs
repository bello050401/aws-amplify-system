import test from 'node:test';
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import {createOutboundFixture} from '../../scripts/qa/outbound-preserve-fixture.mjs';

for(const locationId of ['office','kawagoe'])test(`全数出庫は到着確認まで全カテゴリと保管場所を保持 (${locationId})`,async()=>{
  const f=createOutboundFixture({locationId}),batch=await f.prepare();
  assert.equal((await f.api.emailOutbound(batch.id,'QA')).status,'COMPLETED');
  const stock=f.read('Inventory',f.itemId);assert.deepEqual(stock.categoryIds,['sale','move']);assert.equal(stock.locationId,locationId);assert.equal(stock.quantity,5);assert.equal(stock.outboundArrivalBatchId,batch.id);assert.ok(stock.updatedAt>f.original.updatedAt);assert.equal(stock.customFields,f.original.customFields);
  assert.equal(f.rows('Inventory').size,1);assert.equal(f.rows('InventoryCategory').size,2);assert.equal(f.effects.merges,0);
  assert.equal(f.effects.emails.length,1);assert.equal(f.effects.emails[0].length,2);
  await f.api.emailOutbound(batch.id,'QA');assert.equal(f.effects.emails.length,1);assert.equal(f.rows('InventoryHistory').size,1);
});

test('5点中3点の分割後も、両商品の全カテゴリと保管場所を到着確認まで保持する',async()=>{
  const f=createOutboundFixture(),batch=await f.prepare(3);
  const done=await f.api.emailOutbound(batch.id,'QA'),child=f.read('Inventory',done.rows[0].splitInventoryId),parent=f.read('Inventory',f.itemId);
  assert.equal(done.status,'COMPLETED');assert.equal(parent.quantity,2);assert.equal(child.quantity,3);assert.equal(f.rows('Inventory').size,2);
  assert.deepEqual(parent.categoryIds,['sale','move']);assert.deepEqual(child.categoryIds,['sale','move']);
  for(const row of [parent,child]){assert.equal(row.categoryId,'sale');assert.equal(row.locationId,f.original.locationId);assert.equal(row.name,f.original.name);assert.equal(row.barcode,f.original.barcode);}
  assert.equal(f.rows('InventoryCategory').size,4);assert.equal(f.effects.merges,0);assert.equal(f.effects.mergeReads,0);
  assert.match(iconv.decode(f.effects.emails[0].find(a=>a.kind==='arrival').data,'cp932'),/202610220001,3,,確認用の備考/);
  assert.match(iconv.decode(f.effects.emails[0].find(a=>a.kind==='products').data,'cp932'),/送信データ用の商品名/);
  await f.api.emailOutbound(batch.id,'QA');assert.equal(f.rows('Inventory').size,2);assert.equal(f.read('Inventory',f.itemId).quantity,2);assert.equal(f.effects.emails.length,1);
});

test('メール失敗はカテゴリ・保管場所・数量を変更せず、取消で予約を解除する',async()=>{
  const f=createOutboundFixture(),batch=await f.prepare(3);f.effects.failEmail=true;
  assert.equal((await f.api.emailOutbound(batch.id,'QA')).status,'AWAITING_SEND');assert.equal(f.rows('Inventory').size,1);
  const expected={...f.original,outboundBatchId:batch.id};assert.deepEqual(f.read('Inventory',f.itemId),expected);
  await f.api.cancelUnsentOutbound(batch.id);assert.deepEqual(f.read('Inventory',f.itemId),f.original);
});

test('履歴保存失敗から再開してもメールは重複せず、元のカテゴリ・保管場所を維持する',async()=>{
  const f=createOutboundFixture(),batch=await f.prepare();f.effects.failCompletion=true;
  assert.equal((await f.api.emailOutbound(batch.id,'QA')).status,'PARTIAL');
  const interrupted=(await f.api.outboundHistory())[0];
  assert.equal(interrupted.productCount,1);assert.equal(interrupted.quantity,5);
  assert.equal(interrupted.dispatchedAt,f.read('OutboundBatch',batch.id).emailSentAt);
  assert.deepEqual(f.read('Inventory',f.itemId),{...f.original,outboundBatchId:batch.id});
  f.effects.failCompletion=false;assert.equal((await f.api.emailOutbound(batch.id,'QA')).status,'COMPLETED');
  assert.deepEqual(f.read('Inventory',f.itemId).categoryIds,['sale','move']);assert.equal(f.read('Inventory',f.itemId).locationId,f.original.locationId);assert.equal(f.effects.emails.length,1);
  assert.equal((await f.api.outboundHistory())[0].dispatchedAt,interrupted.dispatchedAt);
});

test('別端末の更新は上書きせず、出庫完了を保留する',async()=>{
  const f=createOutboundFixture({sender:'MANUAL'}),batch=await f.prepare();
  const changed={...f.read('Inventory',f.itemId),updatedAt:'2026-10-22T01:00:00Z',locationId:'changed'};f.put('Inventory',changed);
  const result=await f.api.confirmOutboundSent(batch.id,'QA');assert.equal(result.status,'PARTIAL');assert.deepEqual(f.read('Inventory',f.itemId),changed);
});

test('手動の送信済み確認と旧バッチの数量分割でも分類を保持する',async()=>{
  const f=createOutboundFixture({sender:'MANUAL'}),batch=await f.prepare(3),item=batch.rows[0];
  f.put('OutboundItem',{...f.read('OutboundItem',item.id),splitPrepared:true,splitSku:'QA-OLD-SPLIT',splitImages:'[]'});
  const done=await f.api.confirmOutboundSent(batch.id,'QA');assert.equal(done.status,'COMPLETED');
  assert.equal(f.read('Inventory',item.splitInventoryId).locationId,'office');assert.equal(f.read('Inventory',f.itemId).quantity,2);assert.equal(f.effects.emails.length,0);
});

test('新しい出庫は川越以外も到着確認まで保管場所を維持する',async()=>{
  const f=createOutboundFixture({templateType:'OTHER',sender:'MANUAL'}),batch=await f.prepare();
  assert.equal((await f.api.confirmOutboundSent(batch.id,'QA')).status,'COMPLETED');
  assert.equal(f.read('Inventory',f.itemId).locationId,'office');assert.deepEqual(f.read('Inventory',f.itemId).categoryIds,['sale','move']);
});
