import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import {build} from 'esbuild';
import {yahooReservationWarning} from './yahooReservationIntegrity';
import type {SaleCandidate} from './model';

const built=build({entryPoints:[fileURLToPath(new URL('./listSummary.ts',import.meta.url))],bundle:true,platform:'node',format:'cjs',packages:'external',external:['*'],write:false});
async function harness(read:(id:string,options:unknown)=>Promise<unknown>){
 const testModule={exports:{} as {withCurrentSaleSummary:(items:SaleCandidate[])=>Promise<SaleCandidate[]>}};
 const auth={authMode:'userPool'};
 runInNewContext((await built).outputFiles[0].text,{module:testModule,exports:testModule.exports,require:(name:string)=>{
  if(name==='server-only')return {};
  if(name==='../amplify/dataClient')return {inventoryAuthMode:auth,serverDataClient:{models:{Inventory:{get:({id}:{id:string},options:unknown)=>read(id,options)}}}};
  if(name==='./yahooReservationIntegrity')return {yahooReservationWarning};
  throw Error('Unexpected dependency '+name);
 }});
 return testModule.exports.withCurrentSaleSummary;
}
const candidate={id:'candidate',state:'DONE',channel:'YAHOO',source:'GMAIL',name:'商品',orderId:'g1247424811',yahooPaymentState:'WAITING',
 result:{sourceId:'source',soldId:'source',quantityDeferred:true,sourceQuantity:3,soldQuantity:1,remainingQuantity:2}} as SaleCandidate;
const marker={state:'WAITING',quantityDeferred:true,candidateId:'candidate',auctionId:'g1247424811',sourceQuantity:3,sourceMarket:'',sourceExternalProductId:'',
 waitingCategoryIds:['selling','unpaid'],request:{inventoryId:'source',sourceCandidateId:'candidate',quantity:1,name:'予約時の商品',salePrice:10000,saleCommission:1000,externalProductId:'g1247424811',market:'ヤフオク'}};

test('actual list enrichment keeps auth, deduplicates reads, and exposes no full inventory/internal metadata',async()=>{
 let reads=0;
 const enrich=await harness(async(id,options)=>{
  reads++;assert.equal(id,'source');const o=options as {authMode:string;selectionSet:string[]};assert.equal(o.authMode,'userPool');
  for(const field of ['id','quantity','market','categoryIds','saleEndDate','customFields'])assert.ok(o.selectionSet.includes(field));
  return {data:{id:'source',quantity:2,categoryIds:['selling'],market:'',externalProductId:'',customFields:JSON.stringify({__belloYahooPayment:marker,privateMetadata:'never-client'})}};
 });
 const items=await enrich([candidate,{...candidate}]);assert.equal(reads,1);
 assert.match(items[0].yahooInventoryWarning??'',/二重処理/);assert.equal(items[0].completedSale?.quantity,1);
 assert.equal(items[0].completedSale?.total,10000);assert.equal(items[0].yahooPaymentState,'WAITING');
 assert.doesNotMatch(JSON.stringify(items),/never-client|__belloYahooPayment/);
});
test('fresh healthy inventory clears derived warning without changing payment state',async()=>{
 const enrich=await harness(async()=>({data:{id:'source',quantity:3,categoryIds:['selling','unpaid'],market:'',externalProductId:'',customFields:JSON.stringify({__belloYahooPayment:marker})}}));
 const [item]=await enrich([{...candidate,yahooInventoryWarning:'old'}]);assert.equal(item.yahooInventoryWarning,undefined);assert.equal(item.yahooPaymentState,'WAITING');
});
test('failed inventory read remains a failed read instead of a healthy or zero-stock summary',async()=>{
 const enrich=await harness(async()=>({errors:[{message:'unavailable'}]}));
 await assert.rejects(enrich([candidate]),/SALE_SUMMARY_UNAVAILABLE/);
});
