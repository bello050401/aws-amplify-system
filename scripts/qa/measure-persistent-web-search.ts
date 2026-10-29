// Read-only measurements. Do not persist inventory records.
import assert from 'node:assert/strict';
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient,ScanCommand} from '@aws-sdk/lib-dynamodb';
import {gzipSync} from 'node:zlib';
import {mkdirSync,writeFileSync} from 'node:fs';
import {ensureConversationTableName} from '../lib/resolveStagingTables';
import {QuickSearchCatalog} from '../../mobile/src/domain/quickSearch';
import {buildCatalogDelta} from '../../lib/mobile/catalogDelta';
import {buildSearchFieldDefs} from '../../lib/inventory/advancedSearch';
async function main(){
 await ensureConversationTableName();
 const {directTableName}=await import('../../lib/amplify/directData');
 const {readSearchCatalog}=await import('../../lib/mobile/searchCatalog');
 const {searchInventoryFast}=await import('../../lib/inventory/inventorySearchFast');
 const db=DynamoDBDocumentClient.from(new DynamoDBClient({region:'us-west-2'}));
 async function master(name:string){const r=await db.send(new ScanCommand({TableName:directTableName(name)}));assert(!r.LastEvaluatedKey);return r.Items??[];}
 const [categories,locations,statuses]=await Promise.all(['Category','Location','StatusMaster'].map(master));
 const masters={categories,locations,statuses} as Parameters<typeof readSearchCatalog>[0];
 const fields=buildSearchFieldDefs([],masters),map=new Map(fields.map(f=>[f.key,f]));
 const start=performance.now(),rows=await readSearchCatalog(masters),prepareMs=Math.round(performance.now()-start);
 const catalogue=new QuickSearchCatalog(),delta=buildCatalogDelta(rows,undefined,new Date().toISOString());catalogue.accept(delta,catalogue.version());
 const results=[];
 for(const q of ['チェア','カリモク','Cassina']){
  const input={q,sort:{field:'updatedAt',direction:'desc' as const}};
  let began=performance.now();const remote=await searchInventoryFast({...input,nameOnly:true,fieldsByKey:map},{offset:0,limit:50});const serverMs=Math.round(performance.now()-began);
  assert(remote);began=performance.now();const local=catalogue.search(input,fields)!;const localMs=+(performance.now()-began).toFixed(2);
  assert.deepEqual(local.items.map(r=>r.id),remote.rawItems.map(r=>r.id));assert.equal(local.total,remote.total);assert.equal(local.totalQuantity,remote.totalQuantity);
  results.push({query:q,matches:local.total,serverMs,localMs});
 }
 const warmTimes=[];for(let n=0;n<30;n++){const started=performance.now();catalogue.search({q:['チェア','カリモク','Cassina'][n%3],sort:{field:'updatedAt',direction:'desc'}},fields);warmTimes.push(performance.now()-started);}
 const changed=rows.map((r,n)=>n===0?{...r,quantity:r.quantity+1}:r),noChange=buildCatalogDelta(rows,delta.hashes,new Date().toISOString()),oneChange=buildCatalogDelta(changed,delta.hashes,new Date().toISOString());
 const output={scope:'same PC / read-only live data / data-processing time; excludes browser rendering and mobile-network latency',rows:rows.length,prepareMs,persistedBytes:Buffer.byteLength(JSON.stringify({owner:'account',state:catalogue.state()})),initialGzipBytes:gzipSync(JSON.stringify(delta)).length,noChangeBytes:Buffer.byteLength(JSON.stringify(noChange)),oneChangeGzipBytes:gzipSync(JSON.stringify(oneChange)).length,warmQueryMaxMs:Math.max(...warmTimes),results};
 const dir='artifacts/persistent-web-search-20261029';mkdirSync(dir,{recursive:true});writeFileSync(dir+'/search-timings.json',JSON.stringify(output,null,2));console.log(JSON.stringify(output,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
