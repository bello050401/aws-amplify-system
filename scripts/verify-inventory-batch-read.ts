import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {DynamoDBDocumentClient, BatchGetCommand} from '@aws-sdk/lib-dynamodb';
import {readInventoryBatch} from '../lib/inventory/batchRead';
function client(send:(c:BatchGetCommand)=>Promise<unknown>){return {send} as unknown as DynamoDBDocumentClient;}
test('batch reads unique IDs consistently, accepts unordered results and genuinely missing rows',async()=>{
 let calls=0;const db=client(async c=>{calls++;assert.equal(c.input.RequestItems!.inventory.ConsistentRead,true);assert.deepEqual(c.input.RequestItems!.inventory.Keys,[{id:'a'},{id:'b'},{id:'deleted'}]);return{Responses:{inventory:[{id:'b',name:'B'},{id:'a',name:'A'}]}};});
 const rows=await readInventoryBatch(db,'inventory',['a','b','a','deleted']);assert.equal(calls,1);assert.equal(rows.get('a')!.name,'A');assert.equal(rows.size,2);
});
test('more than 100 IDs uses bounded pages; empty request performs no call',async()=>{
 let calls=0;const db=client(async c=>{calls++;const keys=c.input.RequestItems!.inventory.Keys!;assert(keys.length<=100);return{Responses:{inventory:keys}};});
 assert.equal((await readInventoryBatch(db,'inventory',[])).size,0);assert.equal(calls,0);assert.equal((await readInventoryBatch(db,'inventory',Array.from({length:205},(_,n)=>String(n)))).size,205);assert.equal(calls,3);
});
test('retries only throttled keys and retains successful rows',async()=>{
 let calls=0;const waits:number[]=[];const db=client(async c=>{calls++;const keys=c.input.RequestItems!.inventory.Keys!;if(calls===1)return{Responses:{inventory:[{id:'a'}]},UnprocessedKeys:{inventory:{Keys:[{id:'b'}]}}};assert.deepEqual(keys,[{id:'b'}]);return{Responses:{inventory:[{id:'b'}]}};});
 assert.equal((await readInventoryBatch(db,'inventory',['a','b'],async ms=>{waits.push(ms);})).size,2);assert.equal(calls,2);assert.deepEqual(waits,[50]);
});
test('exhausted retries and unexpected rows never become a partial success',async()=>{
 let calls=0;const db=client(async c=>{calls++;return{UnprocessedKeys:c.input.RequestItems};});
 await assert.rejects(()=>readInventoryBatch(db,'inventory',['a'],async()=>{}),/INCOMPLETE/);assert.equal(calls,5);
 await assert.rejects(()=>readInventoryBatch(client(async()=>({Responses:{inventory:[{id:'wrong'}]}})),'inventory',['a']),/UNEXPECTED/);
 await assert.rejects(()=>readInventoryBatch(client(async()=>{throw Error('denied');}),'inventory',['a']),/denied/);
});
