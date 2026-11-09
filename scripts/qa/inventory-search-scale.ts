// Same-region AWS scale test. The only writable table is disposable and anonymous.
import assert from 'node:assert/strict';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,BatchWriteCommand,ScanCommand} from '@aws-sdk/lib-dynamodb';
import {readCompactSearch} from '../../lib/inventory/readCompactSearch';
import {createQuickSearchMatcher} from '../../lib/inventory/advancedSearch';
import {compareInventoryDateDesc} from '../../lib/inventory/productDates';
import {boundedMap} from '../../lib/inventory/editJobsCore';
const table='InventorySearchQA20261109',raw=DynamoDBDocumentClient.from(new DynamoDBClient({region:'us-west-2'}));
const pct=(xs:number[])=>{const a=[...xs].sort((a,b)=>a-b);return {n:a.length,p50:a[Math.ceil(a.length*.5)-1],p95:a[Math.ceil(a.length*.95)-1],p99:a[Math.ceil(a.length*.99)-1]};};
export async function handler(event:{count:number;previous:number;repeats?:number}) {
 assert([5645,16935,56450].includes(event.count));assert(event.previous>=0&&event.previous<event.count);
 process.env.BELLO_COMPACT_SEARCH_INDEX='1';
 const records=Array.from({length:event.count},(_,i)=>({id:'qa-'+String(i).padStart(6,'0'),name:['チェア','テーブル','キャビネット','arper'][i%4]+' 北欧 モダン 家具 匿名試験 '.repeat(4),sku:'QA'+i,quantity:i%5,categoryIds:['qa-'+i%3],listingPartition:'ACTIVE',updatedAt:new Date(1700000000000+i).toISOString(),listUpdatedAt:new Date(1700000000000+i).toISOString(),note:'匿名の長文 '.repeat(200)}));
 const chunks=[];for(let i=event.previous;i<records.length;i+=25)chunks.push(records.slice(i,i+25));
 await boundedMap(chunks,2,async rows=>{let requests=rows.map(Item=>({PutRequest:{Item}}));for(let attempt=0;requests.length;attempt++){assert(attempt<12);try{const res=await raw.send(new BatchWriteCommand({RequestItems:{[table]:requests}}));requests=(res.UnprocessedItems?.[table]??[]) as typeof requests;}catch(error){if(!['ThrottlingException','ProvisionedThroughputExceededException'].includes((error as Error).name))throw error;}if(requests.length)await new Promise(r=>setTimeout(r,Math.min(3000,150*2**attempt)));}});
 const fields=['id','name','sku','quantity','updatedAt','listUpdatedAt','categoryIds'];
 const input={TableName:table,ProjectionExpression:fields.map((_,i)=>'#f'+i).join(','),ExpressionAttributeNames:Object.fromEntries(fields.map((f,i)=>['#f'+i,f]))};
 let reads=0,bytes=0;
 const db={send:async (command:any)=>{const result=await raw.send(command) as any;reads++;bytes+=Buffer.byteLength(JSON.stringify(result.Items??[]));return result;}};
 // Index propagation is verified before timing. Incomplete data never counts as a pass.
 for(let n=0;;n++){const rows=await readCompactSearch(db as any,input,fields);if(rows?.length===event.count)break;assert(n<30,'Index did not become complete');await new Promise(r=>setTimeout(r,1000));}
 const results=[];
 for(const users of [1,5,10]) {
  const times:number[]=[],dbTimes:number[]=[];reads=0;bytes=0;
  const requests=Array.from({length:event.repeats??100},(_,i)=>i);
  await boundedMap(requests,users,async i=>{
   const q=['チェア','テーブル','あるペール','該当なし'][i%4];const expected=records.filter(createQuickSearchMatcher(q) as any).sort(compareInventoryDateDesc).slice(0,50).map(r=>r.id);
   const start=performance.now(),rows=await readCompactSearch(db as any,input,fields);dbTimes.push(performance.now()-start);assert.equal(rows?.length,event.count);
   const result=rows!.filter(createQuickSearchMatcher(q) as any).sort(compareInventoryDateDesc as any).slice(0,50).map(r=>r.id);
   times.push(performance.now()-start);assert.deepEqual(result,expected);
  });
  results.push({users,coldSearch:pct(times),db:pct(dbTimes),requests:reads,transferredBytes:bytes});
 }
 return {count:event.count,scope:'Anonymous DynamoDB with the same compact GSI, cold reads + search + sort; excludes browser/HTTP; no cache',results,memory:process.memoryUsage()};
}
