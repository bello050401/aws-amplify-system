import test from 'node:test';
import assert from 'node:assert/strict';
import {corroborateYahooSale} from '../lib/saleCandidates/yahooSaleFacts';
import {createYahooSaleFactCompleter} from '../lib/saleCandidates/yahooSaleFactsServer';
import type {SaleCandidate} from '../lib/saleCandidates/model';
import type {YahooListingEvidence} from '../lib/listing/yahooAuction/webHttpListing';
const at=Date.parse('2026-11-21T04:00:00Z');
const c:SaleCandidate={id:'c'.repeat(64),channel:'YAHOO',source:'GMAIL',state:'PENDING',senderAuthenticated:true,name:'検証商品',quantity:null,unitPrice:10000,orderId:'a1234567890',externalListingId:'a1234567890',identifierType:'AUCTION',shipping:null,orderTotal:null,payment:'',orderLineCount:1,saleDate:'',receivedAt:new Date(at).toISOString(),createdAt:new Date(at).toISOString(),updatedAt:new Date(at).toISOString(),yahooStatus:'WON',yahooAuthenticatedWonAt:new Date(at).toISOString(),yahooEvents:{WON:new Date(at).toISOString()},warnings:['落札数量はメールから確定できません。数量を確認してください。']};
const e:YahooListingEvidence={auctionId:c.orderId,title:c.name,priceYen:10000,quantity:1,status:'closed',bids:2,bidders:1,highestBidders:1,owned:true,checkedAt:new Date(at).toISOString()};
test('actual missing-count mail is corroborated by owned closed one-unit winning listing, preserving unknown shipping',()=>{const next=corroborateYahooSale(c,e,at)!;assert.equal(next.quantity,1);assert.equal(next.verifiedSaleFacts,true);assert.equal(next.shipping,null);assert.equal(next.warnings.length,0);assert.equal(next.yahooSaleEvidence?.source,'OWNED_CLOSED_LISTING');assert.equal(next.id,c.id);});
test('open/cancelled/multiple-unit/no-winner/price mismatch/stale or other listing is not a sale quantity',()=>{for(const change of [{status:'open'},{status:'cancelled'},{quantity:2},{highestBidders:0},{bids:0},{bidders:0},{priceYen:9999},{auctionId:'a9999999999'},{owned:false},{checkedAt:new Date(at-300001).toISOString()}])assert.equal(corroborateYahooSale(c,{...e,...change} as YahooListingEvidence,at),null);});
test('untrusted, completed, conflicting notifications cannot gain verified sale facts',()=>{for(const change of [{senderAuthenticated:false},{state:'DONE'},{quantity:2},{unitPrice:null},{yahooEvents:{}},{warnings:['同じIDで異なる落札価格']}])assert.equal(corroborateYahooSale({...c,...change} as SaleCandidate,e,at),null);});
test('server enrichment writes only pending version and does not overwrite a deletion race',async()=>{
 let row:SaleCandidate={...c,updatedAt:new Date().toISOString()},reads=0;const before=row;
 const complete=createYahooSaleFactCompleter(async id=>{assert.equal(id,c.orderId);reads++;row={...row,state:'DELETED'};return {...e,checkedAt:new Date().toISOString()};});
 const db={send:async(cmd:any)=>{assert.equal(cmd.input.ConditionExpression,'#s=:pending AND updatedAt=:v');assert.equal(cmd.input.ExpressionAttributeValues[':v'],before.updatedAt);if(row.state!=='PENDING')throw Object.assign(Error('race'),{name:'ConditionalCheckFailedException'});row=cmd.input.Item;}} as any;
 await assert.rejects(complete(before,db,'T'),{name:'ConditionalCheckFailedException'});assert.equal(row.state,'DELETED');assert.equal(row.quantity,null);assert.equal(reads,1);
});
test('lost CAS acknowledgement is not a second sale/enrichment when candidate is reloaded',async()=>{
 let row:SaleCandidate={...c,updatedAt:new Date().toISOString()},writes=0,reads=0;
 const complete=createYahooSaleFactCompleter(async()=>{reads++;return {...e,checkedAt:new Date().toISOString()};});
 const db={send:async(cmd:any)=>{writes++;row=cmd.input.Item;throw Error('acknowledgement lost');}} as any;
 await assert.rejects(complete(row,db,'T'));assert.equal(row.quantity,1);
 assert.equal(await complete(row,db,'T'),row);assert.equal(writes,1);assert.equal(reads,1);
});
test('auth failure and unowned page cannot enrich or save a candidate',async()=>{
 let writes=0;const db={send:async()=>{writes++;}} as any;
 await assert.rejects(createYahooSaleFactCompleter(async()=>{throw Error('YAHOO_SALE_AUTH_REQUIRED');})(c,db,'T'),/YAHOO_SALE_AUTH_REQUIRED/);
 const unchanged=await createYahooSaleFactCompleter(async()=>({...e,owned:false,checkedAt:new Date().toISOString()} as any))(c,db,'T');assert.equal(unchanged,c);assert.equal(writes,0);
});
