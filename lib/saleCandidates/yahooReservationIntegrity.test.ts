import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {YahooProgress} from '../../components/sales/YahooProgress';
import {yahooReservationWarning,YAHOO_RESERVATION_CHANGED} from './yahooReservationIntegrity';
import type {SaleCandidate} from './model';

function fixture(){
 const candidate:SaleCandidate={id:'candidate',state:'DONE',channel:'YAHOO',source:'GMAIL',name:'商品',quantity:1,unitPrice:10000,
  orderId:'g1247424811',identifierType:'AUCTION',saleDate:'',receivedAt:'2026-11-24T00:00:00Z',createdAt:'2026-11-24T00:00:00Z',updatedAt:'2026-11-24T00:00:00Z',
  shipping:null,orderTotal:null,payment:'',warnings:[],orderLineCount:1,yahooPaymentState:'WAITING',
  result:{sourceId:'source',soldId:'source',quantityDeferred:true,sourceQuantity:3,soldQuantity:1,remainingQuantity:2,updatedAt:'2026-11-24T00:00:00Z'}};
 const marker={state:'WAITING',quantityDeferred:true,candidateId:candidate.id,auctionId:candidate.orderId,sourceQuantity:3,
  sourceMarket:'',sourceExternalProductId:'',waitingCategoryIds:['selling','unpaid'],
  request:{inventoryId:'source',sourceCandidateId:candidate.id,quantity:1,market:'ヤフオク',externalProductId:candidate.orderId}};
 const item={id:'source',quantity:3,market:null,externalProductId:'',categoryIds:['unpaid','selling'],saleEndDate:null,customFields:JSON.stringify({__belloYahooPayment:marker})};
 return {candidate,marker,item};
}

test('unchanged reservation accepts reordered categories and does not change stock or payment',()=>{
 const {candidate,item}=fixture(),before=JSON.stringify({candidate,item});
 assert.equal(yahooReservationWarning(candidate,item),undefined);
 assert.equal(JSON.stringify({candidate,item}),before);
});
test('external split 3 to 2 is flagged before any payment notice',()=>{
 const {candidate,item}=fixture();
 assert.equal(yahooReservationWarning(candidate,{...item,quantity:2,categoryIds:['selling']}),YAHOO_RESERVATION_CHANGED);
 assert.equal(candidate.yahooPaymentState,'WAITING');assert.equal(candidate.yahooPaymentNotice,undefined);
});
test('external sold state with unknown or zero quantity cannot imply paid or another decrement',()=>{
 const {candidate,item}=fixture();
 for(const quantity of [null,undefined,0])assert.equal(yahooReservationWarning(candidate,{...item,quantity,saleEndDate:'2026-11-25',categoryIds:['sold']}),YAHOO_RESERVATION_CHANGED);
});
test('missing, changed order, categories, source or reservation are held',()=>{
 const {candidate,item}=fixture();
 for(const current of [null,{...item,id:'different'},{...item,customFields:'{}'},{...item,externalProductId:'another'},
  {...item,market:'ベイス'},{...item,categoryIds:['selling']},{...item,deletedAt:'2026-11-25'},
  {...item,outboundBatchId:'batch'},{...item,listingPartition:'MERGED'}])
  assert.equal(yahooReservationWarning(candidate,current),YAHOO_RESERVATION_CHANGED);
});
test('mismatched reservation evidence is rejected and fresh healthy read clears diagnostic',()=>{
 const {candidate,item,marker}=fixture();
 for(const change of [{candidateId:'other'},{auctionId:'other'},{sourceQuantity:4},{state:'APPLIED'},
  {request:{...marker.request,quantity:2}},{request:{...marker.request,sourceCandidateId:'other'}}])
  assert.equal(yahooReservationWarning(candidate,{...item,customFields:JSON.stringify({__belloYahooPayment:{...marker,...change}})}),YAHOO_RESERVATION_CHANGED);
 assert.equal(yahooReservationWarning({...candidate,yahooInventoryWarning:YAHOO_RESERVATION_CHANGED},item),undefined);
});
test('applied and non-deferred legacy sales are outside this diagnostic',()=>{
 const {candidate}=fixture();
 for(const c of [{...candidate,yahooPaymentState:'APPLIED' as const},{...candidate,channel:'BASE' as const},
  {...candidate,result:{...candidate.result!,quantityDeferred:false}}])assert.equal(yahooReservationWarning(c,null),undefined);
});
test('reservation receipt must conserve known source, sold and remaining quantities',()=>{
 const {candidate,item}=fixture();
 for(const change of [{remainingQuantity:1},{soldQuantity:0},{sourceQuantity:undefined},{soldQuantity:1.5},{remainingQuantity:-1}])
  assert.equal(yahooReservationWarning({...candidate,result:{...candidate.result!,...change}},item),YAHOO_RESERVATION_CHANGED);
});
test('legacy candidate without yahooStatus shows divergence without promising automatic updates',()=>{
 const {candidate}=fixture();
 const html=renderToStaticMarkup(createElement(YahooProgress,{candidate:{...candidate,yahooInventoryWarning:YAHOO_RESERVATION_CHANGED,yahooPaymentError:'以前の同じ競合メッセージ'}}));
 assert.match(html,/二重処理を避けて/);assert.match(html,/支払い完了メールを待っています/);
 assert.doesNotMatch(html,/他ECの出品停止は進められます|商品情報を自動更新中/);
 assert.doesNotMatch(html,/以前の同じ競合メッセージ/);
});
test('authenticated paid notice is displayed independently from held stock update',()=>{
 const {candidate}=fixture();
 const html=renderToStaticMarkup(createElement(YahooProgress,{candidate:{...candidate,yahooInventoryWarning:YAHOO_RESERVATION_CHANGED,
  yahooPaymentNotice:{gmailId:'receipt',receivedAt:'2026-11-25T00:00:00Z'}}}));
 assert.match(html,/支払い完了メールは受信済み/);assert.doesNotMatch(html,/販売終了日時を登録しました/);
});
