const {build}=require('esbuild'),vm=require('node:vm'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
const built=await build({entryPoints:['lib/saleCandidates/postSale.ts'],bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'isolate-ports',setup(b){b.onResolve({filter:/.*/},a=>a.kind==='entry-point'?undefined:{path:a.path,external:true});}}]});
let plans=new Map(),calls=[],stock=5,remaining=3,market='MERCARI',version='v1',remoteFailure=false;
const candidate=()=>({id:'c',state:'DONE',channel:market,result:{sourceId:'source',soldId:'sold',remainingQuantity:remaining,updatedAt:'v1'}});
const db={send:async c=>{const x=c.input,k=x.Key?.pk??x.Item?.pk;if(c.kind==='GetCommand')return{Item:plans.has(k)?structuredClone(plans.get(k)):undefined};if(c.kind==='PutCommand'){plans.set(k,structuredClone(x.Item));return{};}const old=plans.get(k);if(old.state!=='REVIEW')throw Error('Concurrent');old.state='EXECUTING';return{};}};
const make=k=>class{constructor(input){this.input=input;this.kind=k;}};
const mods={
 'server-only':{},'node:crypto':require('node:crypto'),'@aws-sdk/lib-dynamodb':Object.fromEntries(['GetCommand','PutCommand','UpdateCommand'].map(k=>[k,make(k)])),
 './store':{candidateStore:()=>({get:async()=>candidate()})},
 '@/lib/inventory/categoryPersistence':{getInventoryRaw:async id=>({id,quantity:remaining,updatedAt:version,market:'メルカリSHOP'})},
 '@/lib/listing/econveni/runtimeStore':{econveniDatabase:db,ECONVENI_WORKFLOW_TABLE:'qa'},
 '@/app/actions/ecListingCatalog':{getEcListingCatalogAction:async()=>({errors:[],channels:Object.fromEntries(['BASE','MERCARI_SHOPS','YAHOO'].map(c=>[c,{source:{externalId:c+'-id',state:'ACTIVE'}}]))})},
 '@/app/actions/ecListingOperations':{reviewEcListingAction:async(id,channel)=>({inventoryId:id,channel,status:'READY',token:channel,message:'停止確認'}),executeEcListingAction:async r=>{calls.push(['STOP',r.channel]);return{status:'DONE',message:'停止済み'};}},
 '@/lib/listing/service':{getChannelListing:async()=>({externalListingId:'BASE-id'})},
 '@/lib/listing/base/manualLifecycle':{readBaseItem:async()=>({quantity:stock,visible:true,hasVariations:false}),claimBaseManual:async()=>({}),finishBaseManual:async()=>{}},
 '@/lib/listing/base/adapter':{setManualBaseStock:async(id,q)=>{calls.push(['STOCK',id,q]);stock=q;if(remoteFailure)throw Error('Lost response');}}
};
const module={exports:{}};vm.runInNewContext(built.outputFiles[0].text,{module,exports:module.exports,require:k=>{if(!(k in mods))throw Error('Unexpected dependency '+k);return mods[k];},Date,Map,Set,console});
const {reviewPostSale,executePostSale}=module.exports;const reset=()=>{plans.clear();calls=[];stock=5;version='v1';remoteFailure=false;};
let p=await reviewPostSale('c','owner',{BASE:2});assert(!p.rows.some(r=>r.channel==='MERCARI_SHOPS'));assert.equal(p.rows.find(r=>r.channel==='BASE').targetQuantity,1);assert.equal(calls.length,0);
await assert.rejects(()=>executePostSale('c','owner',p.token,false));assert.equal(calls.length,0);
await assert.rejects(()=>executePostSale('c','different',p.token,true));assert.equal(calls.length,0);
await executePostSale('c','owner',p.token,true);assert.deepEqual(calls,[['STOCK','BASE-id',1]]);await executePostSale('c','owner',p.token,true);assert.equal(calls.length,1);
reset();remaining=0;p=await reviewPostSale('c','owner');await executePostSale('c','owner',p.token,true);assert.deepEqual(calls,[['STOP','BASE'],['STOP','YAHOO']]);
reset();remaining=3;p=await reviewPostSale('c','owner');version='v2';await assert.rejects(()=>executePostSale('c','owner',p.token,true));assert.equal(calls.length,0);
reset();p=await reviewPostSale('c','owner');remoteFailure=true;const result=await executePostSale('c','owner',p.token,true);assert.equal(result.state,'ATTENTION');await executePostSale('c','owner',p.token,true);assert.equal(calls.length,1);
reset();market='BASE';p=await reviewPostSale('c','owner');assert(!p.rows.some(r=>r.channel==='BASE'));assert(p.rows.every(r=>r.state==='BLOCKED'));await executePostSale('c','owner',p.token,true);assert.equal(calls.length,0);
reset();remaining=0;market='YAHOO';p=await reviewPostSale('c','owner');const waiting=plans.get('SALE_EC#c');waiting.state='ATTENTION';waiting.rows[0].state='DONE';waiting.rows[1].state='BLOCKED';waiting.rows[1].message='WAIT';p=await reviewPostSale('c','owner');assert.equal(p.rows[0].state,'DONE');assert(!p.rows.some(r=>r.channel==='YAHOO'));await executePostSale('c','owner',p.token,true);assert.deepEqual(calls,[['STOP','MERCARI_SHOPS']]);
const resultText='PASS: explicit confirmation; actor/token binding; sold-channel exclusion; zero-stock stops only other channels; pack-size stock; stale inventory blocked; uncertain write not retried; unsupported quantity not replaced with stop.';
fs.writeFileSync('artifacts/sale-workflow-20261025/post-sale-safety.txt',resultText);console.log(resultText);
})().catch(e=>{console.error(e);process.exitCode=1;});
