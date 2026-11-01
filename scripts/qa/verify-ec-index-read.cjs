const assert=require('node:assert/strict'),vm=require('node:vm'),{build}=require('esbuild');
async function load(file,ports){const b=await build({entryPoints:[file],bundle:true,write:false,platform:'node',format:'cjs',plugins:[{name:'ports',setup(b){b.onResolve({filter:/.*/},a=>a.kind==='entry-point'?undefined:{path:a.path,external:true});}}]});const m={exports:{}};vm.runInNewContext(b.outputFiles[0].text,{module:m,exports:m.exports,require:k=>{assert(k in ports,'unexpected dependency '+k);return ports[k]},Map,Set,Date});return m.exports;}
(async()=>{
 let ids=[],rows=[],index=null,batches=0,broken=false;
 const helper=await load('lib/inventory/ecEligibleRead.ts',{'server-only':{},
 './inventoryCountFast':{buildCountExpression:()=>({filterExpression:'safe',names:{},values:{}})},
 './readCompactSearch':{readCompactSearch:async()=>index},
 './batchRead':{readInventoryBatch:async(_db,_table,keys)=>{batches++;ids=keys;if(broken)throw Error('INCOMPLETE');return new Map(rows.map(x=>[x.id,x]));}},
 './categories':{inventoryCategoryIds:r=>r.categoryIds??(r.categoryId?[r.categoryId]:[])},
 });
 const read=()=>helper.readEcEligibleRecords({},'T',['eligible']);
 assert.equal(await read(),null);assert.equal(batches,0);
 index=[];assert.equal((await read()).length,0);
 index=[{id:'live'},{id:'deleted'},{id:'moved'},{id:'merged'},{id:'gone'},{id:'legacy'}];
 rows=[{id:'live',categoryIds:['eligible','other'],quantity:3,images:[{storageKey:'original',isPrimary:true}],updatedAt:'new'},
 {id:'deleted',categoryIds:['eligible'],deletedAt:'now'}, {id:'moved',categoryIds:['other'],categoryId:'eligible'},
 {id:'merged',categoryIds:['eligible'],listingPartition:'MERGED'}, {id:'legacy',categoryId:'eligible',quantity:0}];
 const result=await read();assert.deepEqual(Array.from(result,x=>x.id),['live','legacy']);assert.equal(result[0].quantity,3);assert.equal(result[0].images[0].storageKey,'original');assert.equal(ids.length,6);
 broken=true;await assert.rejects(read,/INCOMPLETE/);broken=false;
 let verified=null,iam=0,appsync=0,fast=null,scanPages=0;
 const query=await load('lib/inventory/ecEligibleQuery.ts',{'server-only':{},
 '@/lib/outbound/mergeInventory':{NOT_MERGED_FILTER:{}},'./productDates':{compareInventoryDateDesc:()=>0},'./categories':{categoryFilter:()=>({})},
 '@/lib/amplify/dataClient':{inventoryAuthMode:{authMode:'userPool'},serverDataClient:{models:{Inventory:{list:async()=>{appsync++;scanPages++;return {data:[{id:'fallback',categoryId:'eligible'}],nextToken:scanPages===1?'more':null};}}}}},
 '@/lib/listing/ecEligibility':{isEcListingVisible:n=>n==='販売中'},'@/lib/inventory/queries':{toListRow:x=>x},
 './mutationSession':{inventoryVerifiedReadSession:async()=>verified},'./categoryPersistence':{inventoryDdb:{},inventoryTable:()=>{iam++;return 'T';}},
 './ecEligibleRead':{readEcEligibleRecords:async()=>fast},
 });
 const get=()=>query.listEcEligibleInventory([{id:'eligible',name:'販売中'}]);
 await get();assert.equal(iam,0);assert.equal(appsync,2,'fallback must exhaust pages');
 verified={role:'VIEWER'};fast=result;appsync=0;assert.equal((await get()).items.length,2);assert.equal(iam,1);assert.equal(appsync,0);
 fast=null;await get();assert.equal(appsync,1,'missing index must fall back to authorized AppSync');
 console.log('PASS: current category/deletion/merge checks, missing items, original images, consistent-read errors, verified IAM boundary and full AppSync fallback.');
})().catch(e=>{console.error(e);process.exitCode=1;});
