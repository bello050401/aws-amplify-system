import assert from 'node:assert/strict';
import {test,afterEach} from 'node:test';
import {ScanCommand,BatchGetCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {readPriceEntryRecords} from '../lib/inventory/plannedPriceRead';
const original=process.env.BELLO_COMPACT_SEARCH_INDEX;
afterEach(()=>{if(original===undefined)delete process.env.BELLO_COMPACT_SEARCH_INDEX;else process.env.BELLO_COMPACT_SEARCH_INDEX=original;});
const row=(id:string,extra:Record<string,unknown>={})=>({id,sku:id,name:'椅子',categoryIds:['repair'],updatedAt:'2026-11-02T00:00:00.000Z',images:[],...extra});
const client=(fn:(c:any)=>Promise<any>)=>({send:fn} as unknown as DynamoDBDocumentClient);
test('index reads IDs then consistently hydrates current fields, handles deletions and changed prices/categories',async()=>{
 process.env.BELLO_COMPACT_SEARCH_INDEX='1';let scans=0,batches=0;
 const db=client(async c=>{if(c instanceof ScanCommand){scans++;assert(c.input.IndexName);assert.equal(c.input.ProjectionExpression,'id');return {Items:c.input.Segment===0?['a','deleted','merged','price','zero','category','missing'].map(id=>({id})):[]};}
  assert(c instanceof BatchGetCommand);batches++;const p=c.input.RequestItems!.inventory;assert(p.ConsistentRead);assert(Object.values(p.ExpressionAttributeNames!).includes('note'));assert(!Object.values(p.ExpressionAttributeNames!).includes('customFields'));
  return {Responses:{inventory:[row('a',{name:'最新の名称',note:'最新の備考'}),row('deleted',{deletedAt:'now'}),row('merged',{listingPartition:'MERGED'}),row('price',{plannedSalePrice:100}),row('zero',{plannedSalePrice:0}),row('category',{categoryIds:['sold']})]}};
 });
 const result=await readPriceEntryRecords(db,'inventory',['repair']);assert.equal(scans,4);assert.equal(batches,1);assert.equal(result.length,1);assert.equal(result[0].name,'最新の名称');assert.equal(result[0].note,'最新の備考');
});
test('240 candidates use 3 bounded consistent reads, preserving order',async()=>{
 process.env.BELLO_COMPACT_SEARCH_INDEX='1';const data=Array.from({length:240},(_,i)=>row(String(i).padStart(4,'0'),{updatedAt:new Date(1793577600000+i*1000).toISOString()}));let batches=0;
 const db=client(async c=>{if(c instanceof ScanCommand)return {Items:c.input.Segment===0?data.map(r=>({id:r.id})):[]};batches++;const ids=c.input.RequestItems.inventory.Keys.map((k:any)=>k.id);assert(ids.length<=100);return {Responses:{inventory:data.filter(r=>ids.includes(r.id)).reverse()}};});
 const result=await readPriceEntryRecords(db,'inventory',['repair']);assert.equal(result.length,240);assert.equal(result[0].id,'0239');assert.equal(result[239].id,'0000');assert.equal(batches,3);
});
test('index unavailable falls back to complete paginated scan, no partial index leaks',async()=>{
 process.env.BELLO_COMPACT_SEARCH_INDEX='1';let pages=0;
 const db=client(async c=>{assert(c instanceof ScanCommand);if(c.input.IndexName)throw Error('throttled');pages++;if(c.input.Segment)return {Items:[]};return c.input.ExclusiveStartKey?{Items:[row('b')]}:{Items:[row('a')],LastEvaluatedKey:{id:'a'}};});
 assert.deepEqual((await readPriceEntryRecords(db,'inventory',['repair'])).map(r=>r.id),['a','b']);assert.equal(pages,5);
});
test('empty category list makes zero reads and empty successful index is not mistaken for an outage',async()=>{
 process.env.BELLO_COMPACT_SEARCH_INDEX='1';let calls=0;const db=client(async c=>{calls++;assert(c.input.IndexName);return {Items:[]};});
 assert.deepEqual(await readPriceEntryRecords(db,'inventory',[]),[]);assert.equal(calls,0);
 assert.deepEqual(await readPriceEntryRecords(db,'inventory',['repair']),[]);assert.equal(calls,4);
});
test('failed hydration is an error, never an empty successful list',async()=>{
 process.env.BELLO_COMPACT_SEARCH_INDEX='1';const db=client(async c=>{if(c instanceof ScanCommand)return {Items:c.input.Segment===0?[{id:'a'}]:[]};throw Error('ACCESS_DENIED');});
 await assert.rejects(()=>readPriceEntryRecords(db,'inventory',['repair']),/ACCESS_DENIED/);
});
test('fallback failure and page limit remain errors',async()=>{
 process.env.BELLO_COMPACT_SEARCH_INDEX='0';
 await assert.rejects(()=>readPriceEntryRecords(client(async()=>{throw Error('READ_FAILED');}),'inventory',['repair']),/READ_FAILED/);
 await assert.rejects(()=>readPriceEntryRecords(client(async()=>({Items:[row('a')],LastEvaluatedKey:{id:'a'}})),'inventory',['repair']),/INCOMPLETE/);
});
test('business update date wins over synchronization timestamp and tied rows are stable',async()=>{
 process.env.BELLO_COMPACT_SEARCH_INDEX='0';const db=client(async c=>({Items:c.input.Segment===0?[row('z',{updatedAt:'2026-11-02',listUpdatedAt:'2026-10-01'}),row('b'),row('a')]:[]}));
 assert.deepEqual((await readPriceEntryRecords(db,'inventory',['repair'])).map(r=>r.id),['a','b','z']);
});
