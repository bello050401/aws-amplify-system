import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GetCommand,UpdateCommand,type DynamoDBDocumentClient} from '@aws-sdk/lib-dynamodb';
import {claimAutomationStock,automationStockGuard,releaseAutomationStock} from '../lib/saleCandidates/automationStockLock';
import {canContinueAfterYahooPayment} from '../lib/saleCandidates/yahooSettlementContinuation';
import {uniqueSaleLink} from '../lib/saleCandidates/saleBindingPolicy';
import {withSoldChannelTitle} from '../lib/inventory/soldChannelTitle';
import {managedStockTitleChange} from '../lib/inventory/managedStockTitle';
import type {SaleCandidate} from '../lib/saleCandidates/model';
import type {ExternalProduct} from '../lib/listing/econveni/manualSyncModel';
function lockFixture(){
 const rows=new Map<string,Record<string,any>>();
 const db={send:async(command:any)=>{const x=command.input,id=x.Key.id,old=rows.get(id);if(command instanceof GetCommand)return {Item:old?structuredClone(old):undefined};assert.ok(command instanceof UpdateCommand);const values=x.ExpressionAttributeValues;
  if(x.ConditionExpression==='attribute_not_exists(candidateId)'?old?.candidateId!==undefined:old?.candidateId!==(values[':owner']??values[':id']))throw Object.assign(Error('conflict'),{name:'ConditionalCheckFailedException'});
  if(x.ConditionExpression.includes('saleStarted=:observed')&&old?.saleStarted!==values[':observed']||x.ConditionExpression.includes('attribute_not_exists(saleStarted)')&&old?.saleStarted!==undefined)throw Object.assign(Error('started concurrently'),{name:'ConditionalCheckFailedException'});
  if(x.UpdateExpression==='REMOVE candidateId'){rows.set(id,{...old,candidateId:undefined});return {};}
  rows.set(id,{...old,candidateId:values[':id'],...(Object.hasOwn(values,':no')?{saleStarted:false}:{})});return {};
 }} as unknown as DynamoDBDocumentClient;
 return {db,rows};
}
test('distinct orders serialize inventory through EC; uncertain/committed owner has no timeout takeover',async()=>{
 const f=lockFixture();f.rows.set('a',{state:'PENDING'});f.rows.set('b',{state:'PENDING'});
 const claims=await Promise.all([claimAutomationStock(f.db,'q','stock','a'),claimAutomationStock(f.db,'q','stock','b')]);assert.equal(claims.filter(Boolean).length,1);
 const owner=f.rows.get('AUTOMATION_STOCK_LOCK:stock')!.candidateId,other=owner==='a'?'b':'a';
 f.rows.get('AUTOMATION_STOCK_LOCK:stock')!.saleStarted=true;f.rows.set('AUTO:'+owner,{phase:'EC',saleAt:'old',state:'SALE_AUTO_ATTENTION'});f.rows.set(owner,{state:'DELETED'});
 assert.equal(await claimAutomationStock(f.db,'q','stock',other),false);
 await releaseAutomationStock(f.db,'q','stock',other);assert.equal(f.rows.get('AUTOMATION_STOCK_LOCK:stock')!.candidateId,owner);
 f.rows.set('AUTO:'+owner,{state:'SALE_AUTO_COMPLETE'});assert.equal(await claimAutomationStock(f.db,'q','stock',other),true);assert.equal(f.rows.get('AUTOMATION_STOCK_LOCK:stock')!.saleStarted,false);
 const guard=automationStockGuard('q','stock',other)[0].Update!;assert.equal(guard.ConditionExpression,'candidateId=:id');assert.equal(guard.ExpressionAttributeValues?.[':yes'],true);
});
test('only uncommitted deleted/cancelled owners can be reclaimed; retries retain committed flag',async()=>{
 const f=lockFixture();f.rows.set('a',{state:'PENDING'});assert.equal(await claimAutomationStock(f.db,'q','stock','a'),true);
 f.rows.set('a',{state:'DELETED'});assert.equal(await claimAutomationStock(f.db,'q','stock','b'),true);
 f.rows.get('AUTOMATION_STOCK_LOCK:stock')!.saleStarted=true;assert.equal(await claimAutomationStock(f.db,'q','stock','b'),true);assert.equal(f.rows.get('AUTOMATION_STOCK_LOCK:stock')!.saleStarted,true);
});
test('sale commit racing a deleted-owner reclaim cannot be overwritten by stale lock observation',async()=>{
 const f=lockFixture();await claimAutomationStock(f.db,'q','stock','a');f.rows.set('a',{state:'DELETED'});
 const send=f.db.send.bind(f.db);(f.db as any).send=async(command:any)=>{if(command instanceof GetCommand&&command.input.Key?.id==='a')f.rows.get('AUTOMATION_STOCK_LOCK:stock')!.saleStarted=true;return send(command);};
 assert.equal(await claimAutomationStock(f.db,'q','stock','b'),false);assert.equal(f.rows.get('AUTOMATION_STOCK_LOCK:stock')!.candidateId,'a');
});
test('eConveni repair requires one immutable listing ID and matching inventory marker; names never identify',()=>{
 const product={productId:'1',title:'same title',inventoryMarker:'stock',channels:{BASE:{listingId:'123'},YAHOO:{listingId:'x123456'},MERCARI_SHOPS:{listingId:'mercari1'}}} as ExternalProduct;
 assert.equal(uniqueSaleLink([product],'BASE','123','stock'),product);assert.equal(uniqueSaleLink([product,{...product,productId:'2'}],'BASE','123','stock'),null);
 assert.equal(uniqueSaleLink([product],'BASE','123','other'),null);assert.equal(uniqueSaleLink([product],'BASE','missing','stock'),null);assert.equal(uniqueSaleLink([product],'BASE','','stock'),null);
});
test('channel prefix replacement preserves managed title provenance on restored/resold page',()=>{
 const row={name:'【BASE】【在庫2】椅子',quantity:2,customFields:JSON.stringify({__belloStockTitle:{version:1,prefix:'【BASE】【在庫2】',baseName:'椅子'}})};
 const sold=withSoldChannelTitle(row,'ヤフオク');assert.equal(sold.name,'【ヤフオク】【在庫2】椅子');assert.equal(JSON.parse(sold.customFields).__belloStockTitle.prefix,'【ヤフオク】【在庫2】');
 const updated=managedStockTitleChange({quantity:1},sold);assert.equal(updated.name,'【ヤフオク】椅子');
});
test('only the exact known Yahoo payment successor can continue reserved EC work',()=>{
 const c={id:'candidate',channel:'YAHOO',state:'DONE',orderId:'auction',yahooPaymentState:'APPLIED',yahooReservationVersion:'reserved-v1',result:{sourceId:'source',soldId:'sold',remainingQuantity:3,soldQuantity:2,updatedAt:'paid-v2'}} as SaleCandidate;
 const source={id:'source',quantity:3,updatedAt:'paid-v2'},sold={id:'sold',quantity:2,updatedAt:'paid-v2',externalProductId:'auction',customFields:{__belloSale:{sourceInventoryId:'source',physicalQuantity:2},__belloYahooPayment:{candidateId:'candidate',auctionId:'auction',state:'APPLIED'}}};
 assert.equal(canContinueAfterYahooPayment(c,source,sold,'reserved-v1',3),true);
 for(const [candidate,stock,sale,version,remaining] of [[{...c,yahooReservationVersion:'other'},source,sold,'reserved-v1',3],[c,{...source,updatedAt:'human-v3'},sold,'reserved-v1',3],[c,source,{...sold,externalProductId:'other'},'reserved-v1',3],[c,source,sold,'reserved-v1',2],[{...c,yahooPaymentState:'WAITING'},source,sold,'reserved-v1',3],[c,source,{...sold,quantity:1},'reserved-v1',3]] as const)assert.equal(canContinueAfterYahooPayment(candidate as SaleCandidate,stock,sale,version,remaining),false);
});
