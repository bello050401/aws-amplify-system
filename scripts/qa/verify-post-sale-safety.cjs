const {build}=require('esbuild'),vm=require('node:vm'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
const inputBundle=await build({entryPoints:['lib/inventory/soldOutInput.ts'],bundle:true,platform:'node',format:'cjs',write:false});
const inputModule={exports:{}};vm.runInNewContext(inputBundle.outputFiles[0].text,{module:inputModule,exports:inputModule.exports,Date});
let unlisted=false,unlistedMarker=true,unlistedGuardFailure=false,unlistedChecks=0;
const built=await build({stdin:{contents:"export * from './lib/saleCandidates/postSale';export {reviewPostSaleCore,executePostSaleCore} from './lib/saleCandidates/postSaleCore';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'isolate-ports',setup(b){b.onResolve({filter:/.*/},a=>a.kind==='entry-point'||['./postSaleCore','./lib/saleCandidates/postSale','./lib/saleCandidates/postSaleCore'].includes(a.path)?undefined:{path:a.path,external:true});}}]});
let blankFromSync=false,soldCategory=false,deferred=false,paymentState,plans=new Map(),calls=[],stock=5,title='【在庫5】椅子',remaining=3,market='MERCARI',version='v1',remoteFailure=false,sourceCount=null,soldCount=2,saleIdentity=true,fullSale=false,soldOrder='order',soldVersion=null,selling=false,deleted=false,observation={remote:null,reviews:{}},reviewFailure=false;
const candidate=()=>({id:'c',state:'DONE',yahooPaymentState:paymentState,channel:market,orderId:'order',result:{sourceId:'source',soldId:fullSale||deferred?'source':'sold',soldQuantity:2,...(unlisted?{withoutEconveniListing:true}:{}),...(deferred?{quantityDeferred:true,sourceQuantity:remaining+2}:{}),remainingQuantity:remaining,updatedAt:'v1'}});
const db={send:async c=>{const x=c.input,k=x.Key?.pk??x.Item?.pk;if(c.kind==='GetCommand')return{Item:plans.has(k)?structuredClone(plans.get(k)):undefined};if(c.kind==='PutCommand'){plans.set(k,structuredClone(x.Item));return{};}const old=plans.get(k);if(old.state!==x.ExpressionAttributeValues[':review']||old.token!==x.ExpressionAttributeValues[':token'])throw Error('Concurrent');old.state='EXECUTING';return{};}};
const make=k=>class{constructor(input){this.input=input;this.kind=k;}};
const mods={
 './yahooSettlementContinuationServer':{settledYahooContinuation:async()=>false},'server-only':{},'node:crypto':require('node:crypto'),'@aws-sdk/lib-dynamodb':Object.fromEntries(['GetCommand','PutCommand','UpdateCommand'].map(k=>[k,make(k)])),
 '@/lib/inventory/soldOutInput':inputModule.exports,
 '@/lib/inventory/unlistedSaleGuard':{verifyUnlistedSale:async()=>{unlistedChecks++;if(unlistedGuardFailure)throw Error('local EC evidence remains');return []; }},
 '@/lib/saleCandidates/store':{candidateConfig:()=>({tableName:'candidates'}),candidateStore:()=>({get:async()=>candidate()})},
 './desktopJobs':{postSaleMercariComplete:async()=>false},'./automationStockLock':{releaseAutomationStock:async()=>{}},'@/lib/inventory/categoryPersistence':{inventoryDdb:{},getInventoryRaw:async id=>({id,updatedBy:blankFromSync?'ZAICO暫定同期':'owner',quantity:blankFromSync?undefined:id==='source'?(sourceCount??(fullSale?2:remaining)):soldCount,deletedAt:deleted?'2026-10-31':null,updatedAt:id==='sold'?(soldVersion??version):version,market:unlisted?'直接取引':'メルカリSHOP',externalProductId:soldOrder,customFields:{...(deferred?{__belloYahooPayment:{state:'WAITING',quantityDeferred:true,candidateId:'c',auctionId:'order',request:{quantity:2}}}:{}),__belloSale:{sourceInventoryId:saleIdentity?'source':'wrong',physicalQuantity:2,...(unlisted&&unlistedMarker?{withoutEconveniListing:true}:{})}}})},
 '@/lib/listing/econveni/saleAdjustment':{reviewSaleBinding:async()=>{if(reviewFailure)throw Object.assign(Error('fixture'),{code:'BUSY_OR_STOPPED'});return observation;},reviewSaleAdjustment:async()=>null,saleAdjustmentStarted:async()=>false},
 '@/lib/inventory/categories':{inventoryCategoryIds:()=>selling?['selling']:soldCategory?['sold']:[]},'@/lib/inventory/queries':{listCategories:async()=>[{id:'selling',name:'販売中'},{id:'sold',name:'売り切れ'}]},
 '@/lib/inventory/stockCountTitle':{stockCountTitle:(title,q)=>title.replace(/在庫[0-9]+/, '在庫'+q)},
 '@/lib/listing/econveni/runtimeStore':{econveniDatabase:db,ECONVENI_WORKFLOW_TABLE:'qa'},
 '@/app/actions/ecListingCatalog':{getEcListingCatalogAction:async()=>({errors:[],channels:Object.fromEntries(['BASE','MERCARI_SHOPS','YAHOO'].map(c=>[c,{source:{externalId:c+'-id',state:'ACTIVE'}}]))})},
 '@/app/actions/ecListingOperations':{reviewEcListingAction:async(id,channel)=>({inventoryId:id,channel,status:'READY',token:channel,message:'停止確認'}),executeEcListingAction:async r=>{calls.push(['STOP',r.channel]);return{status:'DONE',message:'停止済み'};}},
 '@/lib/listing/service':{getChannelListing:async()=>({externalListingId:'BASE-id'})},
 '@/lib/listing/base/manualLifecycle':{readBaseItem:async()=>({title,quantity:stock,visible:true,hasVariations:false}),claimBaseManual:async()=>({}),finishBaseManual:async()=>{}},
 '@/lib/listing/base/adapter':{setManualBaseStock:async(id,q,t)=>{calls.push(['STOCK',id,q]);stock=q;title=t;if(remoteFailure)throw Error('Lost response');}}
};
mods['./store']=mods['@/lib/saleCandidates/store'];const module={exports:{}};vm.runInNewContext(built.outputFiles[0].text,{module,exports:module.exports,require:k=>{if(!(k in mods))throw Error('Unexpected dependency '+k);return mods[k];},Date,Map,Set,console});
const {reviewPostSale,executePostSale}=module.exports;const reset=()=>{blankFromSync=false;soldCategory=false;plans.clear();calls=[];stock=5;title='【在庫5】椅子';version='v1';sourceCount=null;soldCount=2;saleIdentity=true;fullSale=false;soldOrder='order';soldVersion=null;selling=false;deleted=false;remoteFailure=false;observation={remote:null,reviews:{}};reviewFailure=false;};
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
reset();remaining=0;market='YAHOO';fullSale=true;paymentState='WAITING';p=await reviewPostSale('c','owner');assert.equal(p.rows.length,2);assert(!p.rows.some(r=>r.channel==='YAHOO'));assert.equal(calls.length,0);await executePostSale('c','owner',p.token,true);assert.deepEqual(calls,[['STOP','BASE'],['STOP','MERCARI_SHOPS']]);
reset();remaining=0;market='YAHOO';fullSale=true;paymentState='APPLIED';version='v2';p=await reviewPostSale('c','owner');await executePostSale('c','owner',p.token,true);assert.deepEqual(calls,[['STOP','BASE'],['STOP','MERCARI_SHOPS']]);

reset();deferred=true;paymentState='WAITING';market='YAHOO';remaining=0;sourceCount=2;
p=await reviewPostSale('c','owner');assert.equal(p.quantityDeferred,true);assert.equal(p.remaining,0);assert.equal(p.rows.map(r=>r.channel).join(','),'BASE,MERCARI_SHOPS');assert.equal(calls.length,0);
await executePostSale('c','owner',p.token,true);assert.deepEqual(calls,[['STOP','BASE'],['STOP','MERCARI_SHOPS']]);assert.equal(sourceCount,2);
deferred=false;paymentState='APPLIED';const settled=await reviewPostSale('c','owner');assert.equal(settled.quantityDeferred,false);assert.equal(calls.length,2);
reset();deferred=true;paymentState='WAITING';market='YAHOO';remaining=3;sourceCount=5;
p=await reviewPostSale('c','owner');assert.equal(p.rows.find(r=>r.channel==='BASE').targetQuantity,3);assert.equal(sourceCount,5);
sourceCount=4;plans.clear();await assert.rejects(()=>reviewPostSale('c','owner'),/数量/);deferred=false;

reset();deferred=false;remaining=0;fullSale=true;version='v2';blankFromSync=true;soldCategory=true;market='MERCARI';
p=await reviewPostSale('c','owner');assert.equal(p.remaining,0);assert.equal(p.rows.map(r=>r.channel).join(','),'BASE,YAHOO');assert.equal(calls.length,0);
reset();remaining=0;fullSale=true;version='v2';blankFromSync=true;await assert.rejects(()=>reviewPostSale('c','owner'),/数量または注文/);
reset();remaining=3;version='v2';blankFromSync=true;soldCategory=true;await assert.rejects(()=>reviewPostSale('c','owner'),/数量または注文/);
reset();remaining=0;fullSale=true;version='v2';blankFromSync=true;soldCategory=true;soldOrder='different';await assert.rejects(()=>reviewPostSale('c','owner'),/数量または注文/);
// Real execution core, with only the external stop endpoint replaced: waiting and crash recovery.
reset();remaining=0;market='YAHOO';p=await reviewPostSale('c','owner');
const queued=plans.get('SALE_EC#c');queued.state='QUEUED';queued.queuedAt=new Date().toISOString();
let stopping=0,wait=true;
const background={background:true,catalog:async()=>({channels:{},errors:[]}),reviewStop:async()=>{},executeStop:async r=>{stopping++;return wait?{status:'WAIT',message:'間隔待ち',nextAt:Date.now()+30000}:{status:'DONE',message:'停止済み'};}};
const run=()=>module.exports.executePostSaleCore(background,'c','owner',p.token,true);
await executePostSale('c','owner',p.token,true);assert.equal(stopping,0); // Browser cannot drain an accepted job.
let bg=await run();assert.equal(bg.state,'QUEUED');assert.equal(stopping,1);assert.equal(bg.rows[0].state,'READY');
await run();assert.equal(stopping,1); // No sleep or early resend; next schedule owns the delay.
plans.get('SALE_EC#c').nextAt=0;wait=false;bg=await run();assert.equal(bg.state,'COMPLETE');assert.equal(stopping,3);assert(!bg.rows.some(r=>r.channel==='YAHOO'));
await run();assert.equal(stopping,3);
reset();remaining=0;market='YAHOO';p=await reviewPostSale('c','owner');Object.assign(plans.get('SALE_EC#c'),{state:'QUEUED',queuedAt:new Date().toISOString()});version='changed';await assert.rejects(run,/商品が変わり/);assert.equal(stopping,3);
reset();remaining=0;market='YAHOO';p=await reviewPostSale('c','owner');Object.assign(plans.get('SALE_EC#c'),{state:'EXECUTING',queuedAt:new Date().toISOString(),executionLeaseUntil:Date.now()-1});plans.get('SALE_EC#c').rows[0].state='VERIFY_REQUIRED';bg=await run();assert.equal(bg.state,'COMPLETE');assert.equal(stopping,5); // Protected child receipt is consulted on recovery.
// Actual automatic planner/executor: all six channel/stock branches, with external boundaries replaced.
mods['@/lib/saleCandidates/store'].candidateStore=()=>({get:async()=>({...candidate(),externalListingId:market==='YAHOO'?'YAHOO-id':market==='MERCARI'?'MERCARI_SHOPS-id':'BASE-id'})});
const auto={automatic:true,catalog:mods['@/app/actions/ecListingCatalog'].getEcListingCatalogAction,reviewStop:mods['@/app/actions/ecListingOperations'].reviewEcListingAction,executeStop:mods['@/app/actions/ecListingOperations'].executeEcListingAction,desktopMercari:async r=>{calls.push(['DESKTOP',r.externalId,r.targetQuantity]);return {status:'DONE',message:'verified title/photo/quantity'};}};
const observeAll=()=>({remote:{productId:'bound',title:'chair',channels:Object.fromEntries(['BASE','MERCARI_SHOPS','YAHOO'].map(c=>[c,{listingId:c+'-id',state:'ACTIVE'}]))},reviews:{}});
for(const saleChannel of ['BASE','YAHOO','MERCARI'])for(const count of [0,3]){
 reset();market=saleChannel;remaining=count;observation=observeAll();
 mods['@/lib/listing/econveni/saleAdjustment'].reviewSaleAdjustment=async input=>input.channel==='YAHOO'?{...input,quantity:input.remaining,beforeQuantity:5}:null;
 mods['@/lib/listing/econveni/saleAdjustment'].executeSaleAdjustment=async input=>{calls.push(['RELIST',input.channel,input.remaining]);return {status:'DONE',message:'new page confirmed; old page retained',newListingId:'new-yahoo-id'};};
 let plan=await module.exports.reviewPostSaleCore(auto,'c','owner');
 const soldEc=saleChannel==='MERCARI'?'MERCARI_SHOPS':saleChannel;
 if(count===0){assert(!plan.rows.some(r=>r.channel===soldEc));assert(plan.rows.every(r=>r.operation==='STOP'));}
 else{
  assert(!plan.rows.some(r=>r.channel==='YAHOO'&&saleChannel!=='YAHOO'));
  assert(plan.rows.filter(r=>r.channel==='MERCARI_SHOPS').every(r=>r.operation==='STOCK'&&r.targetQuantity===3));
  if(saleChannel==='YAHOO'){assert.equal(plan.rows.find(r=>r.channel==='YAHOO').operation,'RELIST');await assert.rejects(()=>module.exports.executePostSaleCore(auto,'c','owner',plan.token,true,false),/ガイドライン/);assert.equal(calls.length,0);}
 }
 const done=await module.exports.executePostSaleCore(auto,'c','owner',plan.token,true,true);assert.equal(done.state,count===0&&saleChannel!=='YAHOO'?'ATTENTION':'COMPLETE');if(count===0&&saleChannel!=='YAHOO'){assert.equal(done.rows.find(r=>r.channel==='YAHOO').state,'BLOCKED');assert.match(done.rows.find(r=>r.channel==='YAHOO').message,/手数料なし取消/);}assert(!calls.some(r=>r[0]==='STOP'&&r[1]==='YAHOO'));const once=calls.length;await module.exports.executePostSaleCore(auto,'c','owner',plan.token,true,true);assert.equal(calls.length,once);
 assert(calls.filter(r=>r[0]==='DESKTOP').every(r=>r[2]===count));if(saleChannel!=='YAHOO')assert(!calls.some(r=>r.includes('RELIST')));
}
// Configured automatic STOP uses only the no-fee adapter; unknown children are read back on ordinary retry.
let noFeeResult='DONE';const noFee={...auto,automaticYahooStop:async request=>{calls.push(['SAFE_YAHOO',request.externalId,request.reconcileOnly===true]);return {status:noFeeResult,message:'safe adapter result'};}};
for(const seller of ['BASE','MERCARI']){reset();market=seller;remaining=0;observation=observeAll();p=await module.exports.reviewPostSaleCore(noFee,'c','owner');assert.equal(p.rows.find(r=>r.channel==='YAHOO').automaticYahooNoFee,true);const outcome=await module.exports.executePostSaleCore(noFee,'c','owner',p.token,true);assert.equal(outcome.state,'COMPLETE');assert.equal(calls.filter(r=>r[0]==='SAFE_YAHOO').length,1);assert(!calls.some(r=>r[0]==='STOP'&&r[1]==='YAHOO'));}
reset();market='BASE';remaining=0;observation=observeAll();noFeeResult='VERIFY_REQUIRED';p=await module.exports.reviewPostSaleCore(noFee,'c','owner');const uncertain=await module.exports.executePostSaleCore(noFee,'c','owner',p.token,true);assert.equal(uncertain.state,'ATTENTION');assert.equal(uncertain.rows.find(r=>r.channel==='YAHOO').state,'VERIFY_REQUIRED');noFeeResult='DONE';p=await module.exports.reviewPostSaleCore(noFee,'c','owner');const reconciled=await module.exports.executePostSaleCore(noFee,'c','owner',p.token,true);assert.equal(reconciled.state,'COMPLETE');assert.deepEqual(calls.filter(r=>r[0]==='SAFE_YAHOO').map(r=>r[2]),[false,true]);assert(!calls.some(r=>r[0]==='STOP'&&r[1]==='YAHOO'));
// Persisted READY and interrupted automatic Yahoo STOP plans cannot reach the fee-unsafe executor.
for(const state of ['READY','VERIFY_REQUIRED']){reset();market='BASE';remaining=0;observation=observeAll();let held=await module.exports.reviewPostSaleCore(auto,'c','owner');let saved=plans.get('SALE_EC#c');saved.rows=[{channel:'YAHOO',externalId:'YAHOO-id',operation:'STOP',state,message:'old plan',review:{inventoryId:'source',channel:'YAHOO',operation:'STOP',status:'READY',token:'old'}}];if(state==='VERIFY_REQUIRED')Object.assign(saved,{state:'EXECUTING',queuedAt:new Date().toISOString(),executionLeaseUntil:Date.now()-1});const checked=await module.exports.executePostSaleCore(state==='VERIFY_REQUIRED'?{...noFee,background:true}:noFee,'c','owner',held.token,true);assert.equal(checked.state,'ATTENTION');assert.equal(checked.rows[0].state,state==='READY'?'BLOCKED':'VERIFY_REQUIRED');assert.match(checked.rows[0].message,/手数料なし取消/);assert.equal(calls.length,0);}
// Reviewing ATTENTION preserves the unresolved child's receipt identity and uncertainty.
reset();market='BASE';remaining=0;observation=observeAll();p=await module.exports.reviewPostSaleCore(auto,'c','owner');const unresolved={channel:'YAHOO',externalId:'YAHOO-id',operation:'STOP',state:'VERIFY_REQUIRED',message:'unknown',review:{inventoryId:'source',channel:'YAHOO',operation:'STOP',status:'READY',token:'durable-unknown-receipt'}};Object.assign(plans.get('SALE_EC#c'),{state:'ATTENTION',rows:[unresolved]});const rereviewed=await module.exports.reviewPostSaleCore(auto,'c','owner');const preserved=rereviewed.rows.find(r=>r.channel==='YAHOO');assert.equal(preserved.state,'VERIFY_REQUIRED');assert.equal(preserved.review.token,'durable-unknown-receipt');assert.match(preserved.message,/手数料なし取消/);assert.equal(calls.length,0);
// Existing completed proof stays complete; readonly inactive remote state needs no cancellation.
plans.get('SALE_EC#c').rows.find(r=>r.channel==='YAHOO').state='DONE';const completed=await module.exports.reviewPostSaleCore(auto,'c','owner');assert.equal(completed.rows.find(r=>r.channel==='YAHOO').state,'DONE');assert.equal(calls.length,0);
reset();market='BASE';remaining=0;observation=observeAll();observation.remote.channels.YAHOO.state='INACTIVE';const inactive=await module.exports.reviewPostSaleCore(auto,'c','owner');assert(!inactive.rows.some(r=>r.channel==='YAHOO'));await module.exports.executePostSaleCore(auto,'c','owner',inactive.token,true);assert(!calls.some(r=>r[0]==='STOP'&&r[1]==='YAHOO'));
reset();market='MERCARI';remaining=3;stock=1;observation=observeAll();p=await module.exports.reviewPostSaleCore(auto,'c','owner');assert.equal(p.rows.find(r=>r.channel==='BASE').targetQuantity,3);await module.exports.executePostSaleCore(auto,'c','owner',p.token,true);assert(calls.some(r=>r[0]==='STOCK'&&r[2]===3));
reset();market='BASE';remaining=3;observation=observeAll();const unavailable={...auto,desktopMercari:async()=>({status:'WAIT',nextAt:Date.now()+6*3600000,message:'PC unavailable'})};p=await module.exports.reviewPostSaleCore(unavailable,'c','owner');const pcWait=await module.exports.executePostSaleCore(unavailable,'c','owner',p.token,true);assert.equal(pcWait.state,'REVIEW');assert(pcWait.nextAt>Date.now()+5*3600000);assert.equal(pcWait.rows[0].state,'READY');
// A completed desktop receipt resumes the persisted six-hour plan without another write.
let receiptReads=0;const readyReceipt={...unavailable,desktopMercariComplete:async r=>{receiptReads++;assert.equal(r.candidateId,'c');assert.equal(r.inventoryVersion,'v1');assert.equal(r.targetQuantity,3);return true;},desktopMercari:async()=>{throw Error('completed receipt must not dispatch again');}};
const stillWaiting=await module.exports.executePostSaleCore({...readyReceipt,desktopMercariComplete:async()=>false},'c','owner',p.token,true);assert.equal(stillWaiting.state,'REVIEW');assert(stillWaiting.nextAt>Date.now());
const waitingPlan=structuredClone(plans.get('SALE_EC#c'));plans.set('SALE_EC#c',{...structuredClone(waitingPlan),rows:[{channel:'YAHOO',externalId:'yahoo',operation:'STOCK',state:'VERIFY_REQUIRED',message:'uncertain'},...waitingPlan.rows]});
await module.exports.executePostSaleCore(readyReceipt,'c','owner',p.token,true);assert.equal(receiptReads,0);assert.equal(plans.get('SALE_EC#c').rows[0].state,'VERIFY_REQUIRED');
plans.set('SALE_EC#c',{...structuredClone(waitingPlan),state:'QUEUED',queuedAt:new Date().toISOString()});
const nativeResumed=await module.exports.executePostSaleCore({...readyReceipt,automatic:false,background:true},'c','owner',p.token,true);assert.equal(nativeResumed.state,'COMPLETE');assert.equal(receiptReads,1);assert(!nativeResumed.rows.some(r=>r.state==='VERIFY_REQUIRED'));assert.equal(calls.length,0);
// A detached eConveni BASE ID is not evidence that the native listing stopped.
reset();market='YAHOO';remaining=0;observation=observeAll();observation.remote.channels.BASE={listingId:null,state:'INACTIVE'};p=await module.exports.reviewPostSaleCore(auto,'c','owner');assert(p.rows.some(r=>r.channel==='BASE'&&r.operation==='STOP'));
// A manual queued plan survives only the exact proven reservation->payment successor.
reset();market='YAHOO';remaining=0;deferred=true;paymentState='WAITING';sourceCount=2;observation=observeAll();p=await module.exports.reviewPostSaleCore(background,'c','owner');Object.assign(plans.get('SALE_EC#c'),{state:'QUEUED',queuedAt:new Date().toISOString()});
deferred=false;fullSale=true;paymentState='APPLIED';version='v2';mods['./yahooSettlementContinuationServer'].settledYahooContinuation=async(id,source,oldVersion,count)=>id==='c'&&source==='source'&&oldVersion==='v1'&&count===0;
const rebased=await module.exports.executePostSaleCore(background,'c','owner',p.token,true);assert.equal(rebased.sourceVersion,'v2');assert.equal(rebased.quantityDeferred,false);assert.equal(rebased.state,'COMPLETE');
// Explicitly unlisted direct sales complete locally, including older clients
// that still invoke post-sale review. Every external review/operation is denied.
const resetUnlisted=()=>{reset();deferred=false;paymentState=undefined;market='DIRECT';remaining=3;unlisted=true;unlistedMarker=true;unlistedGuardFailure=false;unlistedChecks=0;reviewFailure=true;};
let localReleases=0;
const externalDenied=async()=>{throw Error('unlisted sale attempted external work');};
const directPorts={catalog:externalDenied,reviewStop:externalDenied,executeStop:externalDenied,releaseStock:async(id,candidateId)=>{assert.equal(id,'source');assert.equal(candidateId,'c');localReleases++;}};
for(const isFull of [false,true]){
 resetUnlisted();fullSale=isFull;remaining=isFull?0:3;localReleases=0;
 const plan=await module.exports.reviewPostSaleCore(directPorts,'c','owner');
 assert.equal(plan.state,'COMPLETE');assert.equal(plan.withoutEconveniListing,true);assert.equal(plan.rows.length,0);assert.equal(plan.soldChannel,null);assert.equal(plan.queuedAt,undefined);assert.equal(unlistedChecks,1);assert.equal(localReleases,1);
 assert.equal(plans.get('SALE_EC#c').withoutEconveniListing,true);
 const done=await module.exports.executePostSaleCore(directPorts,'c','owner',plan.token,true);
 assert.equal(done.state,'COMPLETE');assert.equal(done.rows.length,0);assert.equal(calls.length,0);
 const reviewedAgain=await module.exports.reviewPostSaleCore(directPorts,'c','owner');
 assert.equal(reviewedAgain.state,'COMPLETE');assert.equal(plans.size,1);assert.equal(calls.length,0);
}
for(const invalid of ['marker','channel','identity','quantity']){
 resetUnlisted();if(invalid==='marker')unlistedMarker=false;if(invalid==='channel')market='BASE';if(invalid==='identity')saleIdentity=false;if(invalid==='quantity')soldCount=3;
 await assert.rejects(()=>module.exports.reviewPostSaleCore(directPorts,'c','owner'));
 assert.equal(plans.size,0);assert.equal(unlistedChecks,0);assert.equal(calls.length,0);
}
resetUnlisted();unlistedGuardFailure=true;
await assert.rejects(()=>module.exports.reviewPostSaleCore(directPorts,'c','owner'),/local EC evidence/);assert.equal(plans.size,0);assert.equal(calls.length,0);
resetUnlisted();plans.set('SALE_EC#c',{state:'REVIEW',rows:[{channel:'BASE',state:'VERIFY_REQUIRED'}],token:'existing'});
await assert.rejects(()=>module.exports.reviewPostSaleCore(directPorts,'c','owner'),/受付済みのEC処理/);assert.equal(plans.get('SALE_EC#c').token,'existing');assert.equal(calls.length,0);
resetUnlisted();plans.set('SALE_EC#c',{state:'QUEUED',rows:[{channel:'BASE',state:'READY'}],token:'queued',queuedAt:'2026-11-25T00:00:00Z'});
assert.equal((await module.exports.reviewPostSaleCore(directPorts,'c','owner')).token,'queued');assert.equal(plans.get('SALE_EC#c').state,'QUEUED');assert.equal(unlistedChecks,0);assert.equal(calls.length,0);
const resultText='PASS: automatic Yahoo STOP fee HOLD including persisted/unknown plans; six seller/stock branches; absolute BASE stock; Yahoo relist authorization and old-page retention; unsold Yahoo untouched; desktop six-hour WAIT; exact payment successor rebase; background queue and stale/unknown outcome safety; unlisted full/partial local completion, no EC review/write, provenance rejection, linkage guard and preservation of existing EC plans.';
fs.mkdirSync('artifacts/sale-shipping-link-20261031',{recursive:true});fs.writeFileSync('artifacts/sale-shipping-link-20261031/post-sale-safety.txt',resultText);console.log(resultText);
})().catch(e=>{console.error(e);process.exitCode=1;});

