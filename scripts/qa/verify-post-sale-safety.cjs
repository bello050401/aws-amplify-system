const {build}=require('esbuild'),vm=require('node:vm'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
const built=await build({entryPoints:['lib/saleCandidates/postSale.ts'],bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'isolate-ports',setup(b){b.onResolve({filter:/.*/},a=>a.kind==='entry-point'?undefined:{path:a.path,external:true});}}]});
let plans=new Map(),calls=[],stock=5,title='【在庫5】椅子',remaining=3,market='MERCARI',version='v1',remoteFailure=false,sourceCount=null,soldCount=2,saleIdentity=true,fullSale=false,soldOrder='order',soldVersion=null,selling=false,deleted=false,observation={remote:null,reviews:{}},reviewFailure=false;
const candidate=()=>({id:'c',state:'DONE',channel:market,orderId:'order',result:{sourceId:'source',soldId:fullSale?'source':'sold',soldQuantity:2,remainingQuantity:remaining,updatedAt:'v1'}});
const db={send:async c=>{const x=c.input,k=x.Key?.pk??x.Item?.pk;if(c.kind==='GetCommand')return{Item:plans.has(k)?structuredClone(plans.get(k)):undefined};if(c.kind==='PutCommand'){plans.set(k,structuredClone(x.Item));return{};}const old=plans.get(k);if(old.state!=='REVIEW')throw Error('Concurrent');old.state='EXECUTING';return{};}};
const make=k=>class{constructor(input){this.input=input;this.kind=k;}};
const mods={
 'server-only':{},'node:crypto':require('node:crypto'),'@aws-sdk/lib-dynamodb':Object.fromEntries(['GetCommand','PutCommand','UpdateCommand'].map(k=>[k,make(k)])),
 './store':{candidateStore:()=>({get:async()=>candidate()})},
 '@/lib/inventory/categoryPersistence':{getInventoryRaw:async id=>({id,quantity:id==='source'?(sourceCount??(fullSale?2:remaining)):soldCount,deletedAt:deleted?'2026-10-31':null,updatedAt:id==='sold'?(soldVersion??version):version,market:'メルカリSHOP',externalProductId:soldOrder,customFields:{__belloSale:{sourceInventoryId:saleIdentity?'source':'wrong',physicalQuantity:2}}})},
 '@/lib/listing/econveni/saleAdjustment':{reviewSaleBinding:async()=>{if(reviewFailure)throw Object.assign(Error('fixture'),{code:'BUSY_OR_STOPPED'});return observation;},reviewSaleAdjustment:async()=>null,saleAdjustmentStarted:async()=>false},
 '@/lib/inventory/categories':{inventoryCategoryIds:()=>selling?['selling']:[]},'@/lib/inventory/queries':{listCategories:async()=>[{id:'selling',name:'販売中'}]},
 '@/lib/inventory/stockCountTitle':{stockCountTitle:(title,q)=>title.replace(/在庫[0-9]+/, '在庫'+q)},
 '@/lib/listing/econveni/runtimeStore':{econveniDatabase:db,ECONVENI_WORKFLOW_TABLE:'qa'},
 '@/app/actions/ecListingCatalog':{getEcListingCatalogAction:async()=>({errors:[],channels:Object.fromEntries(['BASE','MERCARI_SHOPS','YAHOO'].map(c=>[c,{source:{externalId:c+'-id',state:'ACTIVE'}}]))})},
 '@/app/actions/ecListingOperations':{reviewEcListingAction:async(id,channel)=>({inventoryId:id,channel,status:'READY',token:channel,message:'停止確認'}),executeEcListingAction:async r=>{calls.push(['STOP',r.channel]);return{status:'DONE',message:'停止済み'};}},
 '@/lib/listing/service':{getChannelListing:async()=>({externalListingId:'BASE-id'})},
 '@/lib/listing/base/manualLifecycle':{readBaseItem:async()=>({title,quantity:stock,visible:true,hasVariations:false}),claimBaseManual:async()=>({}),finishBaseManual:async()=>{}},
 '@/lib/listing/base/adapter':{setManualBaseStock:async(id,q,t)=>{calls.push(['STOCK',id,q]);stock=q;title=t;if(remoteFailure)throw Error('Lost response');}}
};
const module={exports:{}};vm.runInNewContext(built.outputFiles[0].text,{module,exports:module.exports,require:k=>{if(!(k in mods))throw Error('Unexpected dependency '+k);return mods[k];},Date,Map,Set,console});
const {reviewPostSale,executePostSale}=module.exports;const reset=()=>{plans.clear();calls=[];stock=5;title='【在庫5】椅子';version='v1';sourceCount=null;soldCount=2;saleIdentity=true;fullSale=false;soldOrder='order';soldVersion=null;selling=false;deleted=false;remoteFailure=false;observation={remote:null,reviews:{}};reviewFailure=false;};
let p=await reviewPostSale('c','owner',{BASE:2});assert(p.rows.filter(r=>r.channel==='MERCARI_SHOPS').every(r=>r.operation==='MANUAL'));assert.equal(p.rows.find(r=>r.channel==='BASE').targetQuantity,1);assert.equal(calls.length,0);
await assert.rejects(()=>executePostSale('c','owner',p.token,false));assert.equal(calls.length,0);
await assert.rejects(()=>executePostSale('c','different',p.token,true));assert.equal(calls.length,0);
await executePostSale('c','owner',p.token,true);assert.deepEqual(calls,[['STOCK','BASE-id',1]]);await executePostSale('c','owner',p.token,true);assert.equal(calls.length,1);
reset();remaining=0;p=await reviewPostSale('c','owner');await executePostSale('c','owner',p.token,true);assert.deepEqual(calls,[['STOP','BASE'],['STOP','YAHOO']]);
reset();remaining=3;p=await reviewPostSale('c','owner');version='v2';await assert.rejects(()=>executePostSale('c','owner',p.token,true));assert.equal(calls.length,0);
reset();p=await reviewPostSale('c','owner');remoteFailure=true;const result=await executePostSale('c','owner',p.token,true);assert.equal(result.state,'ATTENTION');await executePostSale('c','owner',p.token,true);assert.equal(calls.length,1);
reset();market='BASE';p=await reviewPostSale('c','owner');assert(!p.rows.some(r=>r.channel==='BASE'));assert(p.rows.every(r=>r.state==='BLOCKED'));await executePostSale('c','owner',p.token,true);assert.equal(calls.length,0);
reset();remaining=0;market='YAHOO';p=await reviewPostSale('c','owner');const waiting=plans.get('SALE_EC#c');waiting.state='ATTENTION';waiting.rows[0].state='DONE';waiting.rows[1].state='BLOCKED';waiting.rows[1].message='WAIT';p=await reviewPostSale('c','owner');assert.equal(p.rows[0].state,'DONE');assert(!p.rows.some(r=>r.channel==='YAHOO'));await executePostSale('c','owner',p.token,true);assert.deepEqual(calls,[['STOP','MERCARI_SHOPS']]);

reset();remaining=0;market='YAHOO';observation={remote:{productId:'bound',channels:{BASE:{listingId:'BASE-id',state:'ACTIVE'},MERCARI_SHOPS:{listingId:'MERCARI_SHOPS-id',state:'ACTIVE'},YAHOO:{listingId:'YAHOO-id',state:'ACTIVE'}}},reviews:{BASE:{status:'READY',token:'shared',message:'一括確認'},MERCARI_SHOPS:{status:'BLOCKED',message:'認証を確認'}}};p=await reviewPostSale('c','owner');assert.equal(p.productId,'bound');assert.equal(p.rows.length,2);assert.equal(p.rows[0].review.token,'shared');assert.equal(p.rows[1].state,'BLOCKED');assert(!p.rows.some(r=>r.channel==='YAHOO'));assert.equal(calls.length,0);
reset();remaining=0;market='YAHOO';observation={remote:{productId:'bound',channels:{BASE:{listingId:'BASE-id',state:'INACTIVE'},MERCARI_SHOPS:{listingId:null,state:'INACTIVE'},YAHOO:{listingId:'YAHOO-id',state:'ACTIVE'}}},reviews:{BASE:{status:'DONE',message:'BASE停止を直接確認済み'}}};p=await reviewPostSale('c','owner');assert.equal(p.rows.find(r=>r.channel==='BASE').state,'DONE');assert.equal(p.rows.find(r=>r.channel==='MERCARI_SHOPS').state,'BLOCKED');assert.match(p.rows.find(r=>r.channel==='MERCARI_SHOPS').message,/番号が外れ/);assert.equal(calls.length,0);
reset();reviewFailure=true;await assert.rejects(()=>reviewPostSale('c','owner'),/保存済みの紐付けは保持/);assert.equal(plans.size,0);assert.equal(calls.length,0);
reset();plans.set('SALE_EC#c',{state:'COMPLETE',rows:[],token:'empty'});p=await reviewPostSale('c','owner');assert.equal(p.rows.length,2);assert.equal(p.state,'REVIEW');
reset();observation={remote:{productId:'bound',channels:{BASE:{listingId:'different',state:'ACTIVE'}}},reviews:{}};await assert.rejects(()=>reviewPostSale('c','owner'),/一致しません/);assert.equal(calls.length,0);
reset();remaining=3;market='MERCARI';version='v2';p=await reviewPostSale('c','owner');assert.equal(p.sourceVersion,'v2');assert.equal(p.rows.length,3);assert.equal(calls.length,0);
reset();version='v2';sourceCount=4;await assert.rejects(()=>reviewPostSale('c','owner'),/数量または注文/);
reset();version='v2';soldCount=3;await assert.rejects(()=>reviewPostSale('c','owner'),/数量または注文/);
reset();version='v2';saleIdentity=false;await assert.rejects(()=>reviewPostSale('c','owner'),/数量または注文/);
reset();remaining=0;market='YAHOO';fullSale=true;version='v2';p=await reviewPostSale('c','owner');assert.equal(p.sourceVersion,'v2');assert.equal(p.rows.length,2);assert(!p.rows.some(r=>r.channel==='YAHOO'));assert.equal(calls.length,0);
reset();remaining=0;fullSale=true;version='v2';soldOrder='other-order';await assert.rejects(()=>reviewPostSale('c','owner'),/数量または注文/);assert.equal(calls.length,0);
reset();remaining=0;fullSale=true;version='v2';selling=true;await assert.rejects(()=>reviewPostSale('c','owner'),/販売中に戻/);assert.equal(calls.length,0);
reset();deleted=true;await assert.rejects(()=>reviewPostSale('c','owner'),/状態を確認/);assert.equal(calls.length,0);
reset();remaining=3;market='YAHOO';soldVersion='v2';soldOrder='different';await assert.rejects(()=>reviewPostSale('c','owner'),/数量または注文/);assert.equal(calls.length,0);
const resultText='PASS: explicit confirmation; actor/token binding; sold-channel exclusion; zero-stock stops only other channels; pack-size stock; stale inventory blocked; uncertain write not retried; unsupported quantity not replaced with stop.';
fs.writeFileSync('artifacts/sale-shipping-link-20261031/post-sale-safety.txt',resultText);console.log(resultText);
})().catch(e=>{console.error(e);process.exitCode=1;});
