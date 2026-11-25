import test from 'node:test';
import assert from 'node:assert/strict';
import {desktopInventoryFingerprint,canContinueDesktopInventory} from './desktopInventoryContinuation';
import {claimDesktopJob,finishDesktopJob,newDesktopJob,startDesktopWrite,type DesktopRequest,type DesktopEvidence} from './desktopJobModel';
import {completedDesktopStockReceipt} from './desktopCompletion';
import type {SaleCandidate} from './model';
const now=Date.parse('2026-11-25T01:00:00Z');
function fixture(deferred=false){
 const item:Record<string,unknown>={id:'source',sku:'B004734',sourceSystem:'ZAICO',sourceInventoryId:'67673496',name:'椅子',quantity:deferred?3:2,categoryIds:['selling','other'],updatedAt:'v1',images:[{storageKey:'inventory/chair.jpg'}],market:'ヤフオク',externalProductId:'auction-old'};
 const c={id:'a'.repeat(64),state:'DONE',channel:'YAHOO',orderId:'g1247424811',orderLineId:'',yahooPaymentState:deferred?'WAITING':'APPLIED',result:{sourceId:'source',soldId:deferred?'source':'sold',soldQuantity:1,remainingQuantity:2,updatedAt:'v1',...(deferred?{quantityDeferred:true,sourceQuantity:3}:{})}} as SaleCandidate;
 if(deferred)item.customFields=JSON.stringify({__belloYahooPayment:{state:'WAITING',quantityDeferred:true,candidateId:c.id,auctionId:c.orderId,sourceQuantity:3,sourceMarket:'ヤフオク',sourceExternalProductId:'auction-old',request:{inventoryId:'source',sourceCandidateId:c.id,quantity:1}}});
 const request:DesktopRequest={purpose:'STOCK',candidateId:c.id,inventoryId:'source',inventoryVersion:'v1',externalId:'mercari-1',title:'椅子',imageKeys:['inventory/chair.jpg'],orderId:c.orderId,orderLineId:'',targetQuantity:2,inventoryFingerprint:desktopInventoryFingerprint(item)};
 const job=newDesktopJob(request,now);
 const latest={...item,updatedAt:'v2',note:'ZAICOで備考のみ更新',purchasePrice:9000,locationId:'new-location'};
 const next={...request,inventoryVersion:'v2',inventoryFingerprint:desktopInventoryFingerprint(latest)};
 return {item,c,request,job,latest,next};
}
test('new immutable stock proof permits version-only and unrelated ZAICO metadata updates',()=>{
 for(const deferred of [false,true]){const f=fixture(deferred);assert.equal(canContinueDesktopInventory(f.job,f.next,f.c,f.latest),true);assert.equal(f.next.inventoryFingerprint,f.request.inventoryFingerprint);}
});
test('legacy receipts do not gain proof from current inventory',()=>{
 const f=fixture(),legacy=newDesktopJob({...f.request,inventoryFingerprint:undefined},now);
 assert.equal(canContinueDesktopInventory(legacy,{...f.next,inventoryFingerprint:undefined},f.c,f.latest),false);
});

test('completed external write is reused after metadata-only sync without altering its durable receipt',()=>{
 const f=fixture(),claimed=claimDesktopJob(f.job,'operator',now);
 const evidence:DesktopEvidence={snapshot:claimed.snapshot,externalId:claimed.externalId,inventoryId:claimed.inventoryId,orderId:claimed.orderId,orderLineId:claimed.orderLineId,observedTitle:claimed.title,expectedImageKey:claimed.imageKeys[0],titleMatched:true,imageMatched:true,observedEvidenceRef:'screenshots/before.jpg',observedAt:new Date(now).toISOString(),observedQuantity:2,observedState:'ACTIVE'};
 const started=startDesktopWrite(claimed,'operator',claimed.lease!,evidence,now);
 const done=finishDesktopJob(started,'operator',started.lease!,{...evidence,observedEvidenceRef:'screenshots/after.jpg'},now),original=structuredClone(done);
 assert.equal(canContinueDesktopInventory(done,f.next,f.c,f.latest),true);
 assert.equal(completedDesktopStockReceipt(f.next,done),false);
 assert.equal(completedDesktopStockReceipt(f.next,done,true),true);
 assert.deepEqual(done,original);assert.equal(done.writeStartedAt,started.writeStartedAt);
 assert.throws(()=>claimDesktopJob(done,'operator',now+1),/NOT_CLAIMABLE/);
 assert.equal(canContinueDesktopInventory(done,{...f.next,targetQuantity:1},f.c,f.latest),false);
});
test('exact stock, provider, category, order, title and image invariants remain mandatory',()=>{
 const f=fixture();
 for(const change of [{quantity:1},{sku:'other'},{sourceInventoryId:'75943081'},{categoryIds:['sold']},{market:'直接取引'},{externalProductId:'other'},{saleEndDate:'2026-11-25'},{outboundBatchId:'out'},{deletedAt:'now'}]){
  const item={...f.latest,...change},request={...f.next,inventoryFingerprint:desktopInventoryFingerprint(item)};
  assert.equal(canContinueDesktopInventory(f.job,request,f.c,item),false,JSON.stringify(change));
 }
 for(const change of [{orderId:'other'},{externalId:'other'},{title:'机'},{imageKeys:['inventory/new.jpg']},{targetQuantity:1}])assert.equal(canContinueDesktopInventory(f.job,{...f.next,...change},f.c,f.latest),false);
 for(const change of [{orderId:'other'},{state:'PENDING'},{result:{...f.c.result!,remainingQuantity:1}},{result:{...f.c.result!,sourceId:'other'}}])assert.equal(canContinueDesktopInventory(f.job,f.next,{...f.c,...change} as SaleCandidate,f.latest),false);
});
test('CLAIMED and WRITE_STARTED cannot be refreshed or erase an uncertain operation',()=>{
 const f=fixture();for(const change of [{state:'CLAIMED' as const},{state:'WRITE_STARTED' as const,writeStartedAt:'now'},{writeStartedAt:'now'}])assert.equal(canContinueDesktopInventory({...f.job,...change},f.next,f.c,f.latest),false);
});
test('pending stock must still conserve the exact unpaid reservation quantity and order',()=>{
 const f=fixture(true);
 for(const change of [{quantity:2},{quantity:null},{saleEndDate:'2026-11-25'}]){const item={...f.latest,...change};assert.equal(canContinueDesktopInventory(f.job,{...f.next,inventoryFingerprint:desktopInventoryFingerprint(item)},f.c,item),false);}
 for(const change of [{yahooPaymentState:'APPLIED'},{result:{...f.c.result!,sourceQuantity:4}},{result:{...f.c.result!,soldId:'sold'}}])assert.equal(canContinueDesktopInventory(f.job,f.next,{...f.c,...change} as SaleCandidate,f.latest),false);
});
test('map ordering and category order do not fabricate changed stock identity',()=>{
 const f=fixture();assert.equal(desktopInventoryFingerprint({...f.item,categoryIds:['other','selling']}),f.request.inventoryFingerprint);
 const a={...f.item,customFields:JSON.stringify({__belloSale:{sourceInventoryId:'source',physicalQuantity:1},publicMemo:'one'})},b={...f.item,customFields:JSON.stringify({publicMemo:'two',__belloSale:{physicalQuantity:1,sourceInventoryId:'source'}})};
 assert.equal(desktopInventoryFingerprint(a),desktopInventoryFingerprint(b));
});
