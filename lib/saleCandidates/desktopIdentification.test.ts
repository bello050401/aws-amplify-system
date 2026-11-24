import test from 'node:test';
import assert from 'node:assert/strict';
import {assertDesktopIdentificationInventory,assertDesktopIdentificationOrder,sameBoundDesktopTitle} from './desktopIdentification';
import {ageDesktopJob,assertDesktopIdentity,claimDesktopJob,desktopIssueDiagnostic,desktopSaveFailureIssue,DESKTOP_RETRY_MS,newDesktopJob,recordDesktopIssue,type DesktopEvidence} from './desktopJobModel';
import type {SaleCandidate} from './model';
const now=Date.parse('2026-11-24T04:00:00Z'),at=new Date(now).toISOString();
const merchant='Magis Tom The Wild Bunch スツール ナチュラル グレー';
const c:SaleCandidate={id:'a'.repeat(64),state:'PENDING',channel:'MERCARI',source:'GMAIL',name:merchant,quantity:1,unitPrice:10000,orderId:'order-1',identifierType:'ORDER',saleDate:'2026-11-24',receivedAt:at,createdAt:at,updatedAt:at,shipping:0,orderTotal:10000,payment:'',warnings:[],orderLineCount:1,senderAuthenticated:true,mercariOrderUrl:'https://mercari-shops.com/seller/shops/shop/orders/1',mercariShopId:'shop'};
const job=claimDesktopJob(newDesktopJob({purpose:'IDENTIFY_SALE',candidateId:c.id,inventoryId:'UNRESOLVED',inventoryVersion:'UNRESOLVED',externalId:'ORDER:'+c.orderId,title:c.name,imageKeys:[],orderId:c.orderId,orderLineId:'',orderUrl:c.mercariOrderUrl,shopId:c.mercariShopId,soldQuantity:c.quantity!,unitPrice:c.unitPrice!},now),'admin',now);
const item={id:'inventory-natural',updatedAt:'v1',name:'【在庫５】【メモ】 Magis Tom - The Wild Bunch スツール ナチュラル グレー'};
const e:DesktopEvidence={snapshot:job.snapshot,externalId:'mercari-natural',inventoryId:item.id,inventoryVersion:item.updatedAt,orderId:c.orderId,orderLineId:'',observedTitle:merchant,expectedImageKey:'inventory/natural.jpg',titleMatched:true,imageMatched:true,observedEvidenceRef:'screenshots/order-1.jpg',observedAt:at};
test('standalone separator variation requires current exact binding and exact inventory/photo/version',()=>{
 assertDesktopIdentity(job,e,now);assertDesktopIdentificationOrder(job,c);
 assert.throws(()=>assertDesktopIdentificationInventory(c,item,[e.expectedImageKey],e),/BINDING_REQUIRED/);
 assert.throws(()=>assertDesktopIdentificationInventory(c,item,[e.expectedImageKey],e,'mercari-black'),/BINDING_REQUIRED/);
 assert.doesNotThrow(()=>assertDesktopIdentificationInventory(c,item,[e.expectedImageKey],e,e.externalId));
 for(const changed of [{...item,id:'inventory-black'},{...item,updatedAt:'v2'},{...item,isDeleted:true}])assert.throws(()=>assertDesktopIdentificationInventory(c,changed,[e.expectedImageKey],e,e.externalId),/STALE_INVENTORY/);
 assert.throws(()=>assertDesktopIdentificationInventory(c,item,['inventory/black.jpg'],e,e.externalId),/IMAGE_CHANGED/);
 assert.throws(()=>assertDesktopIdentificationInventory({...c,externalListingId:'mercari-black'},item,[e.expectedImageKey],e,e.externalId),/IDENTITY_CHANGED/);
});
test('variant words, model hyphens, dimensions and nonseparator punctuation stay significant',()=>{
 for(const [left,right] of [['Magis Tom ブラック','Magis Tom ナチュラル'],['Magis Tom グレー','Magis Tom ブラック'],['model A-1','model A1'],['幅 70-80 cm','幅 7080 cm'],['chair A/B','chair AB'],['Magis Tom Small','Magis Tom Large'],['【メモ】','']])assert.equal(sameBoundDesktopTitle(left,right),false);
 assert.equal(sameBoundDesktopTitle('Magis Tom — The Wild Bunch','Magis Tom The Wild Bunch'),true);
 assert.throws(()=>assertDesktopIdentificationInventory(c,{...item,name:item.name.replace('ナチュラル','ブラック')},[e.expectedImageKey],e,e.externalId),/TITLE_MISMATCH/);
 // The merchant title must STILL equal the authenticated order title, even with an existing binding.
 assert.throws(()=>assertDesktopIdentity(job,{...e,observedTitle:merchant.replace('Tom ','Tom - ')},now),/EVIDENCE_MISMATCH/);
});
test('immutable order/shop/line/quantity/price/sender remain exact and completed sale never reidentifies',()=>{
 for(const patch of [{id:'b'.repeat(64)},{orderId:'order-2'},{orderLineId:'other'},{mercariShopId:'other'},{mercariOrderUrl:'https://example.invalid/'},{quantity:2},{unitPrice:9999},{senderAuthenticated:false},{source:'DIRECT' as const}])assert.throws(()=>assertDesktopIdentificationOrder(job,{...c,...patch}),/ORDER_CHANGED/);
 const result={sourceId:item.id,soldId:'sold-id',remainingQuantity:5,soldQuantity:1,updatedAt:at};
 assert.throws(()=>assertDesktopIdentificationOrder(job,{...c,state:'DONE',result}),/ORDER_ALREADY_COMPLETED/);
});
test('known save faults remain precise after lease expiry and bounded retry exhaustion',()=>{
 const failed=recordDesktopIssue(job,'admin',job.lease!,'TITLE_MISMATCH',now);
 const expired=ageDesktopJob(failed,now+16*60000);assert.equal(expired.state,'WAITING');assert.equal(expired.reason,'DESKTOP_TITLE_MISMATCH');
 const exhausted=ageDesktopJob(expired,now+4*DESKTOP_RETRY_MS);assert.equal(exhausted.state,'ATTENTION');assert.equal(exhausted.attempts,4);assert.equal(exhausted.reason,'DESKTOP_TITLE_MISMATCH');assert.equal(exhausted.lastIssue?.code,'TITLE_MISMATCH');
 assert.equal(ageDesktopJob(exhausted,now+99*DESKTOP_RETRY_MS),exhausted);
 assert.equal(ageDesktopJob({...exhausted,reason:'DESKTOP_UNAVAILABLE'},now).reason,'DESKTOP_TITLE_MISMATCH');
 assert.equal(desktopSaveFailureIssue(Error('DESKTOP_STALE_INVENTORY')),'INVENTORY_CHANGED');assert.equal(desktopSaveFailureIssue(Error('DESKTOP_IMAGE_CHANGED')),'IMAGE_CHANGED');
 assert.equal(desktopSaveFailureIssue(Object.assign(Error('private'),{name:'TransactionCanceledException'})),'SAVE_CONFLICT');
 assert.equal(desktopSaveFailureIssue(Object.assign(Error('private'),{code:'AUTH_REQUIRED'})),'AUTH_REQUIRED');
 for(const code of ['DESKTOP_LEASE_CHANGED','DESKTOP_ORDER_ALREADY_COMPLETED','DESKTOP_RECEIPT_CHANGED','private details'])assert.equal(desktopSaveFailureIssue(Error(code)),null);
 assert.equal(desktopIssueDiagnostic('INVENTORY_CHANGED'),'DESKTOP_INVENTORY_CHANGED');
});
