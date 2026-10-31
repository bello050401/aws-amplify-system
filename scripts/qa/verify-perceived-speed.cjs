const assert=require('node:assert/strict'),vm=require('node:vm'),{build}=require('esbuild'),fs=require('node:fs');
async function load(file,ports={},globals={}) {
 const r=await build({entryPoints:[file],bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'ports',setup(b){b.onResolve({filter:/.*/},a=>a.path in ports?{path:a.path,external:true}:undefined)}}]});
 const m={exports:{}};vm.runInNewContext(r.outputFiles[0].text,{module:m,exports:m.exports,require:k=>{assert(k in ports,'Unapproved dependency '+k);return ports[k]},Buffer,console,Date,Map,Set,setTimeout,process:{env:{CONVERSATION_TABLE_NAME:'Conversation-test-NONE',AWS_REGION:'us-west-2'}},...globals});return m.exports;
}
const clean=x=>JSON.parse(JSON.stringify(x));
(async()=>{
 let time=0,reads=0;class Clock extends Date{static now(){return time}}
 const cache=await load('lib/inventory/searchCandidateCache.ts',{'server-only':{}},{Date:Clock});
 const read=()=>{reads++;return Promise.resolve([{id:'a'}])};
 await Promise.all([cache.readSearchCandidates('a',read),cache.readSearchCandidates('a',read)]);assert.equal(reads,1);
 await cache.readSearchCandidates('a',read);assert.equal(reads,1);
 time=15000;await cache.readSearchCandidates('a',read);assert.equal(reads,2);
 let finish;const old=cache.readSearchCandidates('b',()=>new Promise(r=>finish=r));await Promise.resolve();cache.invalidateSearchCandidates();finish([{id:'old'}]);await old;
 const next=await cache.readSearchCandidates('b',async()=>[{id:'new'}]);assert.equal(next[0].id,'new');
 await assert.rejects(()=>cache.readSearchCandidates('error',async()=>{throw Error('offline')}));await cache.readSearchCandidates('error',read);assert.equal(reads,3);
 cache.invalidateSearchCandidates();let largeReads=0;for(let i=0;i<2;i++)await cache.readSearchCandidates('large',async()=>{largeReads++;return[{v:'x'.repeat(9*1024*1024)}]});assert.equal(largeReads,2);
 for(let i=0;i<5;i++)await cache.readSearchCandidates(String(i),read);await cache.readSearchCandidates('0',read);assert.equal(reads,9);
 const masters=await load('lib/inventory/masterCache.ts',{'server-only':{}});let masterReads=0;
 await Promise.all(Array.from({length:8},()=>masters.cachedMaster('categories',async()=>{masterReads++;return['c']})));assert.equal(masterReads,1);
 let resolveMaster;const stale=masters.cachedMaster('locations',()=>new Promise(r=>resolveMaster=r));await Promise.resolve();masters.invalidateMasterCache();resolveMaster(['old']);await stale;
 assert.deepEqual(clean(await masters.cachedMaster('locations',async()=>['new'])),['new']);

 let scans=0,gets=0,fail=false;const items=[{id:'a',name:'Chair Alpha',sku:'A',quantity:5,updatedAt:'2026-10-31T10:00:00Z',categoryId:'selling',categoryIds:['selling']},{id:'b',name:'Table Beta',sku:'B',quantity:2,updatedAt:'2026-10-30T10:00:00Z',categoryIds:['sold']}];
 class ScanCommand{constructor(input){this.input=input}}class GetCommand{constructor(input){this.input=input}}
 const db={send:async cmd=>{if(fail)throw Error('temporary');if(cmd instanceof GetCommand){gets++;assert.equal(cmd.input.ConsistentRead,true);return{Item:items.find(x=>x.id===cmd.input.Key.id)}}scans++;return{Items:cmd.input.Segment===0?items.filter(x=>!x.deletedAt).map(item=>Object.fromEntries(Object.values(cmd.input.ExpressionAttributeNames).filter(k=>k in item).map(k=>[k,item[k]]))):[]}}};
 const search=await load('lib/inventory/inventorySearchFast.ts',{'server-only':{},'@aws-sdk/client-dynamodb':{DynamoDBClient:class{}},'@aws-sdk/lib-dynamodb':{ScanCommand,GetCommand,DynamoDBDocumentClient:{from:()=>db}},'@/lib/amplify/directData':{directTableName:()=> 'Inventory-test'},'@/lib/perf/queryTiming':{recordQuery:()=>{}}});
 const one=await search.searchInventoryFast({q:'Alpha'},{offset:0,limit:50});assert.equal(one.total,1);assert.equal(one.rawItems[0].quantity,5);assert.equal(scans,8);
 const two=await search.searchInventoryFast({q:'Beta'},{offset:0,limit:50});assert.equal(two.rawItems[0].id,'b');assert.equal(scans,8);assert.equal(gets,2);
 items[0].quantity=3;items[0].updatedAt='2026-10-31T11:00:00Z';const changed=await search.searchInventoryFast({q:'Alpha'},{offset:0,limit:50});assert.equal(changed.totalQuantity,3);assert.equal(changed.rawItems[0].quantity,3);assert.equal(scans,16);
 items[0].deletedAt='2026-10-31T12:00:00Z';const deleted=await search.searchInventoryFast({q:'Alpha'},{offset:0,limit:50});assert.equal(deleted.total,0);assert.equal(deleted.rawItems.length,0);
 const excluded=await search.searchInventoryFast({q:'Beta',saleRelevance:true,saleExcludeCategoryIds:['sold']},{offset:0,limit:50});assert.equal(excluded.total,0);
 const prior=scans;await search.searchInventoryFast({q:'Beta',filters:{locationId:'x'}},{offset:0,limit:50});assert(scans>prior);
 fail=true;await assert.rejects(()=>search.searchInventoryFast({q:'Beta'},{offset:0,limit:50}),/temporary/);fail=false;

 // Compact GSI may lag writes. Visible results must still come from a fresh
 // base-table read; retry the base table, never the same stale index.
 const current=[{id:'c',name:'Chair Gamma',quantity:3,updatedAt:'v2',categoryIds:['selling']}];
 const lagged=[{...current[0],quantity:5,updatedAt:'v1'}];let compactScans=0,baseScans=0,indexFails=false;
 const compactDb={send:async cmd=>{if(cmd instanceof GetCommand)return{Item:current.find(x=>x.id===cmd.input.Key.id)};
  const indexed=!!cmd.input.IndexName;if(indexed){compactScans++;if(indexFails)throw Error('index unavailable');}else baseScans++;
  const source=indexed?lagged:current;return{Items:cmd.input.Segment===0?source.filter(x=>!x.deletedAt).map(item=>Object.fromEntries(Object.values(cmd.input.ExpressionAttributeNames).filter(k=>k in item).map(k=>[k,item[k]]))):[]};}};
 const loadCompact=()=>load('lib/inventory/inventorySearchFast.ts',{'server-only':{},'@aws-sdk/client-dynamodb':{DynamoDBClient:class{}},'@aws-sdk/lib-dynamodb':{ScanCommand,GetCommand,DynamoDBDocumentClient:{from:()=>compactDb}},'@/lib/amplify/directData':{directTableName:()=> 'Inventory-test'},'@/lib/perf/queryTiming':{recordQuery:()=>{}}},{process:{env:{CONVERSATION_TABLE_NAME:'Conversation-test-NONE',BELLO_COMPACT_SEARCH_INDEX:'1'}}});
 let indexedSearch=await loadCompact();let indexedResult=await indexedSearch.searchInventoryFast({q:'Gamma'},{offset:0,limit:50});assert.equal(indexedResult.totalQuantity,3);assert.equal(indexedResult.rawItems[0].quantity,3);assert.equal(compactScans,4);assert.equal(baseScans,8);
 current[0].deletedAt='deleted';indexedSearch=await loadCompact();indexedResult=await indexedSearch.searchInventoryFast({q:'Gamma'},{offset:0,limit:50});assert.equal(indexedResult.total,0);assert.equal(compactScans,8);assert.equal(baseScans,16);
 delete current[0].deletedAt;indexFails=true;indexedSearch=await loadCompact();indexedResult=await indexedSearch.searchInventoryFast({q:'Gamma'},{offset:0,limit:50});assert.equal(indexedResult.totalQuantity,3);assert.equal(baseScans,24);
 indexFails=false;lagged[0]={...current[0]};indexedSearch=await loadCompact();indexedResult=await indexedSearch.searchInventoryFast({q:'Gamma'},{offset:0,limit:50});assert.equal(indexedResult.totalQuantity,3);assert.equal(baseScans,24,'healthy compact index must avoid the full inventory scan');

 let thumbReads=0,thumbFail=false;const thumbs=await load('lib/inventory/thumbnailRecords.ts',{'server-only':{},'../amplify/dataClient':{inventoryAuthMode:{authMode:'userPool'},serverDataClient:{models:{Inventory:{get:async({id},opts)=>{thumbReads++;assert.equal(opts.authMode,'userPool');assert.deepEqual(clean(opts.selectionSet),['id','updatedAt','deletedAt','images.*']);return thumbFail?{errors:['offline']}:{data:{id,updatedAt:'now',deletedAt:id==='deleted'?'yes':null,images:[{storageKey:'damage',sortOrder:0,type:'DAMAGE'},{storageKey:'normal',thumbnailKey:'small',sortOrder:1,isPrimary:true}]}}}}}}}});
 const out=await thumbs.readThumbnailRecords(['a','a','deleted']);assert.equal(thumbReads,2);assert.equal(out.length,1);assert.equal(out[0].mainImageThumbnailKey,'small');assert.equal(out[0].mainImageIsPrimary,true);
 thumbFail=true;await assert.rejects(()=>thumbs.readThumbnailRecords(['a']),/UNAVAILABLE/);

 let verified=false,directReads=0,directItem={id:'a',quantity:5},directFailure=false;
 const detail=await load('lib/inventory/detailRead.ts',{'server-only':{},'./mutationSession':{inventoryVerifiedReadSession:async()=>verified?{owner:'owner',role:'VIEWER'}:null},'../amplify/directData':{directTableName:model=>{assert.equal(model,'Inventory');return'Inventory-test'}},'@aws-sdk/client-dynamodb':{DynamoDBClient:class{}},'@aws-sdk/lib-dynamodb':{GetCommand,DynamoDBDocumentClient:{from:()=>({send:async cmd=>{directReads++;assert.equal(cmd.input.ConsistentRead,true);assert.equal(cmd.input.TableName,'Inventory-test');if(directFailure)throw Error('outage');return{Item:directItem}}})}}});
 assert.equal(await detail.readVerifiedInventoryDetail('a'),undefined);assert.equal(directReads,0);
 verified=true;assert.equal(await detail.readVerifiedInventoryDetail('../invalid'),undefined);assert.equal(directReads,0);
 assert.equal((await detail.readVerifiedInventoryDetail('a')).quantity,5);
 directItem={id:'a',quantity:3};assert.equal((await detail.readVerifiedInventoryDetail('a')).quantity,3);assert.equal(directReads,2);
 directItem=undefined;assert.equal(await detail.readVerifiedInventoryDetail('a'),null);
 directItem={id:'different'};assert.equal(await detail.readVerifiedInventoryDetail('a'),undefined);
 directFailure=true;assert.equal(await detail.readVerifiedInventoryDetail('a'),undefined);
 verified=false;const last=directReads;assert.equal(await detail.readVerifiedInventoryDetail('a'),undefined);assert.equal(directReads,last);

 // Contract of the real HTTP route: unauthorized callers trigger no reads;
 // photo reads start before the still-pending inventory read resolves.
 let permitted=true,photoStarted=false,rowResolve,categoryCalls=[],locationCalls=[],statusReads=0;const rowPromise=new Promise(r=>rowResolve=r);
 const route=await load('app/api/mobile/inventory/[id]/route.ts',{'next/server':{NextResponse:{json:(body,options)=>({body,...options})}},'@/lib/mobile/session':{getMobileSession:async()=>permitted?{ok:true,owner:'owner',features:{}}:{ok:false,error:'FORBIDDEN',status:403}},'@/lib/inventory/queries':{getInventoryDetail:()=>rowPromise,listCategories:async id=>{categoryCalls.push(id);return id?[{id}]:[]},listLocations:async id=>{locationCalls.push(id);return id?[{id}]:[]},listStatuses:async()=>{statusReads++;return[]}},'@/lib/inventory/listImageUrls':{signInventoryListKey:async()=>null},'@/lib/mobile/inventoryDetail':{mobileInventoryDetail:(row,categories,locations)=>{assert.equal(categories[0]?.id,'inactive-category');assert.equal(locations[0]?.id,'inactive-location');return{id:'item'}}},'@/lib/mobile/inventoryPhotos':{mobileInventoryPhotos:async()=>[]},'@/app/actions/photoRegistration':{listInventoryPhotoAssetsAction:async()=>{photoStarted=true;return{ok:true,value:{assets:[]}}}},'@/app/actions/inventory':{},'@/lib/inventory/conditionalUpdate':{},'@/lib/mobile/inventoryWrite':{}});
 permitted=false;assert.equal((await route.GET({}, {params:{id:'00000000-0000-0000-0000-000000000001'}})).status,403);assert(!photoStarted);assert.equal(categoryCalls.length,0);assert.equal(locationCalls.length,0);assert.equal(statusReads,0);
 permitted=true;const request=route.GET({}, {params:{id:'00000000-0000-0000-0000-000000000001'}});await new Promise(r=>setImmediate(r));assert(photoStarted);assert.deepEqual(categoryCalls,[undefined]);assert.deepEqual(locationCalls,[undefined]);assert.equal(statusReads,1);rowResolve({images:[],categoryId:'inactive-category',locationId:'inactive-location'});const result=await request;assert.deepEqual(categoryCalls,[undefined,'inactive-category']);assert.deepEqual(locationCalls,[undefined,'inactive-location']);assert.equal(result.body.owner,'owner');assert.equal(result.body.item.photosComplete,true);assert.match(result.headers['Cache-Control'],/no-store/);
 const report={passed:['candidate cache single-flight, expiry, invalidation race, failure, memory and entry limits','search stable results, fresh quantity/counts, soft-delete removal, sale category exclusions, filter separation, failed read rejection','master request coalescing and invalidation race','authenticated thumbnail projection, deduplication, image priority, deletion, failures','detail authorization, parallel reads, complete-photo guard and no-store','direct detail signature-verification gate, invalid ID, consistent fresh reads, missing item, identity mismatch and outage fallback']};
 fs.mkdirSync('artifacts/perceived-speed-20261031',{recursive:true});fs.writeFileSync('artifacts/perceived-speed-20261031/regression.json',JSON.stringify(report,null,2));console.log('PASS perceived-speed regressions: '+report.passed.join('; '));
})().catch(e=>{console.error(e);process.exitCode=1});
