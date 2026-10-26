import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {GetCommand,TransactWriteCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {createStockSplitService} from '../lib/inventory/stockSplitCore';
import type {StockSplitRequest} from '../lib/inventory/stockSplitInput';

function fixture(quantity=5) {
 const owner=randomUUID(),id=randomUUID(),time='2026-10-24T01:00:00Z';
 const source={id,sku:'QA-SOURCE',name:'元の商品',barcode:'SAME',quantity,updatedAt:time,createdAt:'2026-01-01T00:00:00Z',categoryIds:['sale','other'],categoryId:'sale',locationId:'office',purchasePrice:1200,transactionDate:'2026-01-01',salePrice:4000,damageNotes:'元のメモ',sourceSystem:'ZAICO',sourceInventoryId:'123',images:[{storageKey:'inventory/source.jpg',type:'NORMAL'}],customFields:JSON.stringify({material:'木',__belloEditedFields:['note']})};
 let rows=new Map<string,any>([[`Inventory/${id}`,structuredClone(source)],['Category/sale',{id:'sale'}],['Category/other',{id:'other'}]]);
 const state={fail:false,lost:false,copyFailure:false,copies:0,deleted:0,transactions:0};
 const db={send:async(c:any)=>{
  const p=c.input;if(c instanceof GetCommand)return {Item:structuredClone(rows.get(p.TableName+'/'+p.Key.id))};
  assert.ok(c instanceof TransactWriteCommand);state.transactions++;const staged=new Map(rows);
  const reject=()=>{throw Object.assign(Error('conflict'),{name:'TransactionCanceledException'});};
  for(const op of p.TransactItems){
   if(op.Update){const u=op.Update,key=u.TableName+'/'+u.Key.id,r=staged.get(key),v=u.ExpressionAttributeValues;
    if(!r||r.updatedAt!==v[':version']||r.quantity!==v[':quantity']||r.deletedAt||r.outboundBatchId||r.outboundArrivalBatchId)reject();
    const next={...r};for(const [alias,key] of Object.entries(u.ExpressionAttributeNames))next[key as string]=v[alias.replace('#f',':v')];staged.set(key,next);
   }else if(op.Put){const key=op.Put.TableName+'/'+op.Put.Item.id;if(op.Put.ConditionExpression&&staged.has(key))reject();staged.set(key,structuredClone(op.Put.Item));}
   else if(op.Delete)staged.delete(op.Delete.TableName+'/'+op.Delete.Key.id);
  }
  if(state.fail)reject();rows=staged;if(state.lost)throw Error('connection lost');return {};
 }} as unknown as DynamoDBDocumentClient;
 const run=createStockSplitService({db,table:n=>n,nextSku:async()=>randomUUID(),now:()=>time,copyPhotos:async(row,attempt)=>{state.copies++;if(state.copyFailure)throw Error('photo failed');return (row.images as Record<string,unknown>[]).map((image:any,i:number)=>({...image,storageKey:`inventory/${attempt}/${i}.jpg`}));},discardPhotos:async()=>{state.deleted++;}});
 const request:StockSplitRequest={inventoryId:id,mutationId:randomUUID(),expectedUpdatedAt:time,quantity:2,damageNotes:'右側に傷',barcode:'SAME',photos:[{storageKey:`inventory/mobile/${owner}/${randomUUID()}/${'a'.repeat(64)}.jpg`,type:'DAMAGE'}]};
 return {owner,source,state,request,run,get:(id:string)=>rows.get('Inventory/'+id),stocks:()=>[...rows].filter(([k])=>k.startsWith('Inventory/')).map(([,r])=>r),set:(r:any)=>rows.set('Inventory/'+r.id,r)};
}
test('残り3点と分割2点のタイトルを別々に保存・再送しても2件だけ',async()=>{const f=fixture(),r={...f.request,sourceName:'商品B',splitName:'商品C'};const a=await f.run(r,f.owner);assert.equal(f.get(a.sourceId).name,'商品B');assert.equal(f.get(a.splitId).name,'商品C');assert.equal(f.get(a.sourceId).quantity,3);assert.equal(f.get(a.splitId).quantity,2);assert.deepEqual(await f.run(r,f.owner),a);assert.equal(f.stocks().length,2);await assert.rejects(f.run({...r,splitName:'別名'},f.owner));});
test('タイトル変更を含む処理失敗では元の名前と数量を維持',async()=>{const f=fixture();f.state.fail=true;await assert.rejects(f.run({...f.request,sourceName:'商品B',splitName:'商品C'},f.owner));assert.deepEqual(f.get(f.source.id),f.source);assert.equal(f.stocks().length,1);});
test('空タイトルと長すぎるタイトルを拒否',async()=>{for(const change of [{sourceName:' '},{splitName:''},{splitName:'あ'.repeat(2001)}]){const f=fixture();await assert.rejects(f.run({...f.request,...change},f.owner));assert.equal(f.state.transactions,0);}});
test('カテゴリ未設定でも sparse index に NULL を書かず分割できる',async()=>{const f=fixture();f.set({...f.source,categoryId:null,categoryIds:[],locationId:null,statusId:null});const r=await f.run(f.request,f.owner),child=f.get(r.splitId);for(const key of ['categoryId','locationId','statusId'])assert(!Object.hasOwn(child,key));assert.equal(f.get(r.sourceId).quantity+child.quantity,5);});
for(const [qty,split] of [[5,2],[10,1],[2,2]])test(`在庫分け ${qty}→${split}: 数量・識別・写真・元情報`,async()=>{
 const f=fixture(qty),r=await f.run({...f.request,quantity:split},f.owner),source=f.get(r.sourceId),child=f.get(r.splitId);
 assert.notEqual(r.sourceId,r.splitId);assert.notEqual(source.sku,child.sku);assert.equal(source.quantity,qty-split);assert.equal(child.quantity,split);assert.equal(f.stocks().reduce((n,r)=>n+r.quantity,0),qty);
 for(const key of ['name','barcode','purchasePrice','transactionDate','salePrice','locationId','categoryIds'])assert.deepEqual(child[key],(f.source as any)[key]);
 assert.equal(child.damageNotes,'右側に傷');assert.equal(source.damageNotes,'元のメモ');assert.equal(child.images.length,2);assert.equal(child.images[1].type,'DAMAGE');assert.notEqual(child.images[0].storageKey,source.images[0].storageKey);assert.equal(child.images[1].storageKey,f.request.photos[0].storageKey);
 assert.equal(child.sourceInventoryId,undefined);assert.equal(child.sourceSystem,'BELLO');assert.equal(JSON.parse(child.customFields).material,'木');assert.ok(JSON.parse(source.customFields).__belloEditedFields.includes('quantity'));
});
test('無効数量・別人の写真・重複写真は書き込まない',async()=>{for(const input of [{quantity:6},{quantity:0},{quantity:-1},{quantity:1.5},{photos:[{storageKey:`inventory/mobile/${randomUUID()}/${randomUUID()}/${'b'.repeat(64)}.jpg`,type:'DAMAGE'}]}]){const f=fixture();await assert.rejects(f.run({...f.request,...input} as StockSplitRequest,f.owner));assert.deepEqual(f.get(f.source.id),f.source);assert.equal(f.state.transactions,0);}const f=fixture();await assert.rejects(f.run({...f.request,photos:[...f.request.photos,...f.request.photos]},f.owner));});
test('途中失敗で数量・複製・リンク・履歴を残さない',async()=>{const f=fixture();f.state.fail=true;await assert.rejects(f.run(f.request,f.owner));assert.deepEqual(f.get(f.source.id),f.source);assert.equal(f.stocks().length,1);assert.equal(f.state.deleted,1);});
test('写真保存失敗では数量を書き換えない',async()=>{const f=fixture();f.state.copyFailure=true;await assert.rejects(f.run(f.request,f.owner));assert.equal(f.state.transactions,0);assert.deepEqual(f.get(f.source.id),f.source);});
test('応答消失・同じ処理の再送で二重分割しない',async()=>{const f=fixture();f.state.lost=true;const a=await f.run(f.request,f.owner),b=await f.run(f.request,f.owner);assert.deepEqual(a,b);assert.equal(f.stocks().length,2);assert.equal(f.state.transactions,1);});
test('同時連打で数量を二重に減らさない',async()=>{const f=fixture();const r=await Promise.all([f.run(f.request,f.owner),f.run(f.request,f.owner)]);assert.deepEqual(r[0],r[1]);assert.equal(f.get(f.source.id).quantity,3);assert.equal(f.stocks().length,2);});
test('別端末の同時分割は片方だけ成功',async()=>{const f=fixture();const r=await Promise.allSettled([f.run(f.request,f.owner),f.run({...f.request,mutationId:randomUUID()},f.owner)]);assert.equal(r.filter(v=>v.status==='fulfilled').length,1);assert.equal(f.get(f.source.id).quantity,3);});
test('出庫中と到着待ちの在庫は分割しない',async()=>{for(const field of ['outboundBatchId','outboundArrivalBatchId']){const f=fixture();f.set({...f.source,[field]:'pending'});await assert.rejects(f.run(f.request,f.owner));assert.equal(f.state.transactions,0);}});
test('処理IDを変更内容や実行者のすり替えに使えない',async()=>{const f=fixture();await f.run(f.request,f.owner);await assert.rejects(f.run({...f.request,damageNotes:'変更'},f.owner));await assert.rejects(f.run({...f.request,photos:[]},randomUUID()));assert.equal(f.stocks().length,2);});

