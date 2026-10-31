import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GetCommand,PutCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {createCandidateStore} from '../lib/saleCandidates/storeCore';
import {deletedCandidateRecord} from '../lib/saleCandidates/deletion';
import {candidateKey} from '../lib/saleCandidates/identity';
import type {SaleCandidate} from '../lib/saleCandidates/model';

const candidate:SaleCandidate={id:candidateKey('YAHOO','x1234567890','0'),state:'PENDING',channel:'YAHOO',source:'GMAIL',name:'PRIVATE_PRODUCT',quantity:5,unitPrice:13000,orderId:'x1234567890',identifierType:'AUCTION',saleDate:'2026-11-01',receivedAt:'2026-11-01T00:00:00Z',createdAt:'2026-11-01T00:00:00Z',updatedAt:'2026-11-01T00:00:00Z',shipping:999,orderTotal:65999,payment:'PRIVATE_PAYMENT',warnings:[],orderLineCount:1,yahooStatus:'WON'};
function memory(){
 const rows=new Map<string,any>([[candidate.id,structuredClone(candidate)]]),writes:any[]=[];
 let beforeWrite:(()=>void)|undefined;
 const db={send:async(c:any)=>{
  const p=c.input;assert.equal(p.TableName,'isolated-candidates');
  if(c instanceof GetCommand){assert.equal(p.ConsistentRead,true);return {Item:structuredClone(rows.get(p.Key.id))};}
  assert(c instanceof PutCommand,'Deletion must never mutate inventory, mail, images or EC');
  beforeWrite?.();beforeWrite=undefined;
  const old=rows.get(p.Item.id),v=p.ExpressionAttributeValues;
  const allowed=p.ConditionExpression==='attribute_not_exists(id)'?!old:old?.state===v[':state']&&old?.updatedAt===v[':version'];
  if(!allowed)throw Object.assign(Error('conflict'),{name:'ConditionalCheckFailedException'});
  writes.push(p);rows.set(p.Item.id,structuredClone(p.Item));return {};
 }} as unknown as DynamoDBDocumentClient;
 return {rows,writes,store:createCandidateStore(db,'isolated-candidates'),beforeWrite:(f:()=>void)=>{beforeWrite=f;}};
}
test('delete replaces all candidate content with a fixed suppression allowlist',async()=>{
 const m=memory();m.rows.get(candidate.id).unexpectedFuturePayload={private:'PRIVATE_EXTRA'};
 await m.store.remove(candidate.id,'admin');const row=m.rows.get(candidate.id);
 assert.deepEqual(Object.keys(row).sort(),['id','state','channel','orderHash','deletedAt','deletedBy','updatedAt','deletionVersion'].sort());
 assert.equal(row.orderHash,candidateKey('YAHOO',candidate.orderId,'order'));assert(!JSON.stringify(row).includes('PRIVATE'));assert(!JSON.stringify(row).includes(candidate.orderId));assert.equal(row.ttl,undefined);
 assert.equal(await m.store.put(candidate),false);assert.equal(await m.store.receiveYahoo({...candidate,yahooStatus:'AWAITING_SHIPMENT'}),'unchanged');
});
test('retry after response loss succeeds and missing candidate creates no record',async()=>{
 const m=memory();await m.store.remove(candidate.id,'admin');const first=m.rows.get(candidate.id);await m.store.remove(candidate.id,'admin2');assert.equal(m.rows.get(candidate.id).deletedBy,'admin');assert.equal(m.rows.get(candidate.id).deletedAt,first.deletedAt);await m.store.remove('missing','admin');assert.equal(m.rows.size,1);
});
test('legacy deleted payload is scrubbed while deletion audit identity is kept',async()=>{
 const m=memory();Object.assign(m.rows.get(candidate.id),{state:'DELETED',deletedAt:'2026-10-28T01:00:00Z',deletedBy:'original-admin'});await m.store.remove(candidate.id,'migration');assert.equal(m.rows.get(candidate.id).deletedBy,'original-admin');assert.equal(m.rows.get(candidate.id).name,undefined);
});
test('completed sale is never deleted',async()=>{
 const m=memory();m.rows.get(candidate.id).state='DONE';await assert.rejects(m.store.remove(candidate.id,'admin'),{name:'ConditionalCheckFailedException'});assert.equal(m.writes.length,0);assert.equal(m.rows.get(candidate.id).name,candidate.name);
});
test('concurrent sale confirmation wins safely over stale deletion',async()=>{
 const m=memory();m.beforeWrite(()=>Object.assign(m.rows.get(candidate.id),{state:'DONE',result:{soldId:'sold'}}));await assert.rejects(m.store.remove(candidate.id,'admin'),{name:'ConditionalCheckFailedException'});assert.equal(m.rows.get(candidate.id).state,'DONE');assert.equal(m.writes.length,0);
});
test('concurrent mail refresh wins safely over stale deletion',async()=>{
 const m=memory();m.beforeWrite(()=>Object.assign(m.rows.get(candidate.id),{updatedAt:'2026-11-01T01:00:00Z',yahooStatus:'AWAITING_SHIPMENT'}));await assert.rejects(m.store.remove(candidate.id,'admin'),{name:'ConditionalCheckFailedException'});assert.equal(m.rows.get(candidate.id).yahooStatus,'AWAITING_SHIPMENT');
});
test('direct/invoice suppression never includes blank clear-text order data',()=>{
 const row=deletedCandidateRecord({...candidate,channel:'DIRECT',orderId:''},'admin','2026-11-01T00:00:00Z');assert.equal(row.orderHash,undefined);assert.equal(Object.keys(row).length,7);
});
