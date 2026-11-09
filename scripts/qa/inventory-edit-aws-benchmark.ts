import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,ScanCommand,BatchGetCommand,BatchWriteCommand} from '@aws-sdk/lib-dynamodb';
import {createInventoryPersistence} from '../../lib/inventory/categoryPersistenceCore';
import {createInventoryEditJobs} from '../../lib/inventory/editJobsCore';
import {SEARCH_SCALAR_FIELDS} from '../../lib/inventory/searchProjection';
import {createQuickSearchMatcher} from '../../lib/inventory/advancedSearch';
import {readEditHistory} from '../../lib/inventory/reversibleHistory';

const region='us-west-2',suffix='BELLO-EditQA-20261109',table=(model:string)=>model+'-'+suffix;
const real=DynamoDBDocumentClient.from(new DynamoDBClient({region}),{marshallOptions:{removeUndefinedValues:true}});
const prod='Inventory-j6up24p7lnczdmklzjdt3vrp4y-NONE';
const pct=(v:number[])=>{const s=[...v].sort((a,b)=>a-b);return {n:s.length,p50:s[Math.ceil(s.length*.5)-1],p95:s[Math.ceil(s.length*.95)-1],p99:s[Math.ceil(s.length*.99)-1]};};
const projection=(fields:string[])=>({ProjectionExpression:fields.map((_,i)=>'#p'+i).join(','),ExpressionAttributeNames:Object.fromEntries(fields.map((f,i)=>['#p'+i,f]))});
async function batch(ids:string[],fields?:string[]){const items=new Map<string,Record<string,any>>();for(let at=0;at<ids.length;at+=100){let keys=ids.slice(at,at+100).map(id=>({id}));for(let attempt=0;keys.length;attempt++){
 if(attempt>5)throw Error('BATCH_READ_INCOMPLETE');
 const r=await real.send(new BatchGetCommand({RequestItems:{[table('Inventory')]:{Keys:keys,ConsistentRead:true,...(fields?projection(fields):{})}}}));
 for(const row of r.Responses?.[table('Inventory')]??[])items.set(row.id,row);
 keys=(r.UnprocessedKeys?.[table('Inventory')]?.Keys??[]) as {id:string}[];
}}return items;}
export async function handler(event:{kind:'reads'|'edits';repeats?:number;users?:number}) {
 const start=performance.now(),repeats=Math.min(1000,Math.max(1,event.repeats??100));
 if(event.kind==='reads') {
  const fields=['id','name','sku','sourceInventoryId','sourceSystem','quantity','updatedAt','listUpdatedAt'];
  const scan=async(index:boolean)=>{let requests=0,bytes=0;const parts=await Promise.all(Array.from({length:index?4:8},async(_,segment)=>{
   const result:Record<string,any>[]=[];let key:Record<string,any>|undefined;do{const r=await real.send(new ScanCommand({TableName:prod,...projection(fields),...(index?{IndexName:'inventorySearchCompactV1'}:{}),Segment:segment,TotalSegments:index?4:8,ExclusiveStartKey:key}));
    requests++;bytes+=Buffer.byteLength(JSON.stringify(r.Items??[]));result.push(...(r.Items??[]));key=r.LastEvaluatedKey;
   }while(key);return result;}));return {rows:parts.flat(),requests,bytes};};
  const scanMetrics:Record<string,unknown>={};let catalogue:Record<string,any>[]=[];
  for(const index of [false,true]){const times=[];let last;for(let i=0;i<5;i++){const at=performance.now();last=await scan(index);times.push(performance.now()-at);}catalogue=last!.rows;scanMetrics[index?'compactIndex':'baseProjection']={...pct(times),requests:last!.requests,bytes:last!.bytes,count:catalogue.length};}
  const ids=catalogue.slice(0,50).map(r=>r.id),hydration:Record<string,unknown>={};
  for(const projected of [false,true]){const times=[],sizes=[];for(let i=0;i<repeats;i++){
    const at=performance.now();const response=await real.send(new BatchGetCommand({RequestItems:{[prod]:{Keys:ids.map(id=>({id})),ConsistentRead:true,...(projected?projection([...new Set(['id',...SEARCH_SCALAR_FIELDS,'images','listingPartition'])]):{})}}}));
    assert.equal(response.UnprocessedKeys?.[prod]?.Keys?.length??0,0);times.push(performance.now()-at);sizes.push(Buffer.byteLength(JSON.stringify(response.Responses?.[prod]??[])));
   }hydration[projected?'displayProjection':'fullRecord']={...pct(times),meanBytes:Math.round(sizes.reduce((a,b)=>a+b,0)/sizes.length)};}
  // In-memory workload only: generated names preserve the observed length
  // distribution without retaining actual titles or identifiers in test output.
  const cpu=[];for(const scale of [1,3,10]){const rows=Array.from({length:catalogue.length*scale},(_,i)=>({id:'synthetic-'+i,name:['チェア','テーブル','キャビネット','arper'][i%4]+' 匿名商品 '.repeat(Math.ceil(String(catalogue[i%catalogue.length].name).length/6)),sku:'QA'+i,quantity:i%5,updatedAt:new Date(1700000000000+i).toISOString()}));
   const times=[];let matched=0;for(let n=0;n<1000;n++){const at=performance.now(),match=createQuickSearchMatcher(['チェア','テーブル','arper','該当なし'][n%4]);const found=rows.filter(match as any);found.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));matched+=found.slice(0,50).length;times.push(performance.now()-at);}cpu.push({scale,count:rows.length,...pct(times),matched});
  }
  return {scope:'Lambda us-west-2 read-only live inventory; API DB and CPU only, no browser/network rendering',scanMetrics,hydration,cpu,elapsedMs:performance.now()-start,memory:process.memoryUsage()};
 }
 assert.equal(event.kind,'edits');process.env.INVENTORY_EDIT_JOBS_TABLE=table('InventoryEditJobs');process.env.INVENTORY_HISTORY_TABLE=table('Inventory');
 const store=createInventoryPersistence(real,table),runtime=createInventoryEditJobs({db:real,table,jobsTable:table('InventoryEditJobs'),readBatch:batch,enqueue:async()=>{},authorizeWorker:async()=>true});
 const metrics=[];const owner='QA_BENCHMARK';
 for(const users of [event.users??1]){
  assert([1,5,10].includes(users));
  const groups=await Promise.all(Array.from({length:users},async()=>{const ids=Array.from({length:100},()=>randomUUID());for(let at=0;at<100;at+=25){const r=await real.send(new BatchWriteCommand({RequestItems:{[table('Inventory')]:ids.slice(at,at+25).map((id,i)=>({PutRequest:{Item:{id,name:'試験用チェア'+i,quantity:5,categoryIds:[],updatedAt:new Date().toISOString(),listingPartition:'ACTIVE'}}}))}}));assert(!r.UnprocessedItems?.[table('Inventory')]?.length);}return ids;}));
  const saves:number[]=[],previews:number[]=[],applies:number[]=[],undos:number[]=[],redos:number[]=[];
  await Promise.all(groups.map(async(ids)=>{for(let n=0;n<repeats;n++){
    const current=(await batch([ids[0]])).get(ids[0])!;let at=performance.now();await store.persistInventoryWithCategories({id:ids[0],name:'試験用変更'+n},String(current.updatedAt),{current});saves.push(performance.now()-at);
    for(const mode of ['undo','redo'] as const){at=performance.now();const id=randomUUID();await runtime.create({id,ids:[ids[0]],mode},owner,owner);await runtime.run(id);await runtime.apply(id,owner);await runtime.run(id);const result=await runtime.status(id,owner);assert.equal(result.job.counts.SAVED,1);(mode==='undo'?undos:redos).push(performance.now()-at);}
    if(n<Math.ceil(100/users)){let id=randomUUID();at=performance.now();await runtime.create({id,ids,mode:'edit',rules:{categories:{mode:'keep'},names:[{kind:'prefix',text:'【'+n+'】',skipExisting:true}]}},owner,owner);await runtime.run(id);previews.push(performance.now()-at);
      at=performance.now();await runtime.apply(id,owner);await runtime.run(id);const result=await runtime.status(id,owner);assert.equal(result.job.counts.SAVED,100);applies.push(performance.now()-at);}
  }}));
  const persisted=await batch(groups.flat());for(const row of persisted.values()){assert.equal(row.quantity,5);assert(readEditHistory(row).entries.length<=2);}
  metrics.push({users,save:pct(saves),undo:pct(undos),redo:pct(redos),preview100:pct(previews),apply100:pct(applies)});
 }
 return {scope:'isolated AWS DynamoDB via same-region Lambda; excludes SQS dispatch and browser. No external EC or inventory sync',metrics,elapsedMs:performance.now()-start,memory:process.memoryUsage()};
}
