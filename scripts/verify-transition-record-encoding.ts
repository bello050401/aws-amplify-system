import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {marshall,unmarshall} from '@aws-sdk/util-dynamodb';
import {decodeTransitionRecord as decode,encodeTransitionRecord as encode} from '../lib/zaico/transition/recordEncoding';
import {transitionStore} from '../lib/zaico/transition/store';
import type {DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import type {Row} from '../lib/zaico/transition/mapping';
const roundtrip=(r:Row)=>unmarshall(marshall(r,{removeUndefinedValues:true}));
const base={title:'【在庫５】椅子 🪑',quantity:5,blank:null,empty:'',zero:0,no:false,
  categoryIds:['repair','sale'],fields:{'出庫時の名前':'椅子','購入価格':'１２，０００'},text:'商品情報。'.repeat(100)};
const sample:Row={id:'transition#item#one',version:'version-1',updatedAt:'2026-11-07T00:00:00Z',status:'OK',inventoryId:'one',sourceId:'123',
 remote:{id:123,...base,optional_attributes:{日本語:'𠮷野',nested:{a:[1,null,'']}}},localBase:base,remoteBase:base,
 rawValues:{field:{value:'not-number'}},desired:{quantity:4},rejectedDesired:null,
 conflict:{fields:[{field:'quantity',bello:4,zaico:5}]},imageExport:{fingerprint:'unchanged',url:'https://example.test/image.jpg'}};
let count=0;const check=(name:string,fn:()=>void)=>{fn();console.log('PASS '+name);count++;};
async function main(){
 check('Lossless real DynamoDB document roundtrip, Unicode, null, empty, booleans, arrays',()=>assert.deepEqual(decode(roundtrip(encode(sample))),roundtrip(sample)));
 check('Snapshot fields compressed; keys/versions/status/photo metadata stay unchanged',()=>{const c=encode(sample);assert.equal(c.snapshotEncoding,'gzip-json-v1');assert.equal(c.localBase,undefined);for(const key of ['id','version','status','updatedAt','inventoryId','sourceId','imageExport'])assert.deepEqual(c[key],sample[key]);});
 check('Plain and tiny historical records remain readable',()=>{assert.deepEqual(decode(sample),sample);const row={id:'transition#item#tiny',localBase:{quantity:1}};assert.deepEqual(encode(row),row);});
 check('Control and lease are never encoded',()=>{for(const id of ['transition#control','transition#lease'])assert.deepEqual(encode({...sample,id}),{...sample,id});});
 check('Encoding does not mutate input and supports repeat encoding',()=>{const before=structuredClone(sample);assert.deepEqual(decode(encode(encode(sample))),sample);assert.deepEqual(sample,before);});
 check('Corruption fails closed',()=>{const bad=encode(sample);bad.snapshotGzip=Buffer.from('broken');assert.throws(()=>decode(bad));});
 check('Wrong checksum fails closed',()=>assert.throws(()=>decode({...encode(sample),snapshotSha256:'0'.repeat(64)})));
 check('Unknown format and incomplete envelope fail closed',()=>{assert.throws(()=>decode({...encode(sample),snapshotEncoding:'future'}));assert.throws(()=>decode({id:sample.id,snapshotSha256:'x'}));});
 check('Duplicate payload field fails closed',()=>assert.throws(()=>decode({...encode(sample),remoteBase:{quantity:999}})));
 check('Injected keys cannot replace record identity',()=>{const bytes=Buffer.from(JSON.stringify({id:'wrong'}));assert.throws(()=>decode({id:sample.id,snapshotEncoding:'gzip-json-v1',snapshotGzip:gzipSync(bytes),snapshotSha256:createHash('sha256').update(bytes).digest('hex')}));});
 check('Oversized decompression rejected',()=>{const bytes=Buffer.from('a'.repeat(2*1024*1024+1));assert.throws(()=>decode({id:sample.id,snapshotEncoding:'gzip-json-v1',snapshotGzip:gzipSync(bytes),snapshotSha256:createHash('sha256').update(bytes).digest('hex')}));});
 const calls:{kind:string;input:Row}[]=[];const records=new Map<string,Row>([[sample.id,roundtrip(encode(sample))]]);
 const db={send:async(c:{constructor:{name:string};input:Row})=>{calls.push({kind:c.constructor.name,input:c.input});
  if(c.constructor.name==='GetCommand')return {Item:records.get(c.input.Key.id)};
  if(c.constructor.name==='PutCommand'){
   const old=records.get(c.input.Item.id),expected=c.input.ExpressionAttributeValues?.[':v'];
   if(expected?old?.version!==expected:old!==undefined)throw Object.assign(Error('stale'),{name:'ConditionalCheckFailedException'});
   records.set(c.input.Item.id,roundtrip(c.input.Item));return {};
  }
  if(c.constructor.name==='ScanCommand')return c.input.ExclusiveStartKey?{Items:[{id:'transition#item#legacy',localBase:{quantity:3}}],ConsumedCapacity:{CapacityUnits:2}}:
   {Items:[records.get(sample.id)],LastEvaluatedKey:{id:'last'},ConsumedCapacity:{CapacityUnits:3}};
  throw Error('Unexpected operation');
 }} as unknown as DynamoDBDocumentClient;
 let metrics:unknown;const store=transitionStore(db,'fixture',{compactItemPayloads:true,onListRead:m=>metrics=m});
 assert.deepEqual(await store.get(sample.id),sample);count++;console.log('PASS Store get decodes strongly consistent record');
 const next=await store.put({...sample,localBase:{...base,quantity:4}},sample.version);
 assert.equal(records.get(sample.id)!.snapshotEncoding,'gzip-json-v1');assert.deepEqual(await store.get(sample.id),next);assert.equal(next.localBase.quantity,4);count++;console.log('PASS Store write/read uses compressed bytes with current optimistic lock');
 await assert.rejects(store.put(sample,sample.version));count++;console.log('PASS Stale version rejected without overwriting');
 const rows=await store.list();assert.equal(rows.length,2);assert.equal(rows[0].localBase.quantity,4);assert.equal(rows[1].localBase.quantity,3);
 assert.deepEqual({...metrics as Row,durationMs:0},{count:2,pages:2,readUnits:5,compressedItems:1,durationMs:0});
 assert(calls.filter(c=>['GetCommand','ScanCommand'].includes(c.kind)).every(c=>c.input.ConsistentRead===true));count++;console.log('PASS Mixed format pagination and read metrics; strong reads retained');
 const plainStore=transitionStore(db,'fixture');const plain=await plainStore.put(next,next.version);assert.equal(records.get(sample.id)!.snapshotEncoding,undefined);assert.deepEqual(await plainStore.get(sample.id),plain);count++;console.log('PASS Rollback writer restores plain format without business data changes');
 records.set(sample.id,{...encode(sample),snapshotSha256:'corrupt'});await assert.rejects(store.list());count++;console.log('PASS Corrupt page aborts entire list instead of returning incomplete data');
 console.log(`PASS ${count} record encoding/store checks`);
}
main().catch(e=>{console.error(e);process.exitCode=1});
